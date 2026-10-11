import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as pty from 'node-pty'
import { SessionJournal } from './session-journal'
import {
  SESSION_MAX_FRAME_BYTES,
  sessionManifestSchema,
  sessionRequestSchema,
  type SessionFrame,
  type SessionRecordInput,
  type SessionStatus
} from './session-protocol'

interface Engine {
  readonly socket: net.Socket
  replaying: boolean
  paused: boolean
  sent: number
  forcedFence: number
  pumping: Promise<void> | null
  readonly waiters: Array<{
    fence: number
    resolve: () => void
    reject: (error: Error) => void
  }>
}
const EMERGENCY_BUFFER_BYTES = 1024 * 1024

async function main(): Promise<void> {
  process.title = 'treeport-session'
  const directory = process.argv[2]
  if (!directory) {
    throw new Error('Missing session directory')
  }

  const manifestPath = path.join(directory, 'manifest.json')
  const manifest = sessionManifestSchema.parse(
    JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'))
  )
  const journal = new SessionJournal(directory, manifest.journalLimitBytes)
  const child = pty.spawn(manifest.argv[0]!, manifest.argv.slice(1), {
    name: 'xterm-256color',
    cwd: manifest.cwd,
    env: manifest.env,
    cols: manifest.cols,
    rows: manifest.rows
  })
  const status: SessionStatus = {
    version: 1,
    ownerPid: process.pid,
    pid: child.pid,
    process: child.process,
    cols: manifest.cols,
    rows: manifest.rows,
    sequence: 0,
    processedSequence: 0,
    exitCode: null,
    error: null,
    incomplete: false
  }
  let engine: Engine | null = null
  let terminating = false
  let sourcePaused = false
  let pendingBytes = 0
  const pending: SessionRecordInput[] = []
  const publishStatus = () => {
    // Failure to write diagnostics must not crash the owner and destroy a PTY.
    try {
      const temporary = path.join(directory, 'status.json.tmp')
      fs.writeFileSync(temporary, JSON.stringify(status), { mode: 0o600 })
      fs.renameSync(temporary, path.join(directory, 'status.json'))
    } catch (error) {
      console.error('Cannot publish session status:', error)
    }
  }
  const updateReadFlow = () => {
    // Engine disconnection, replay, and socket backpressure never stop capture.
    // Only exhausted storage AND a bounded emergency buffer backpressure a PTY.
    const paused =
      status.error !== null && pendingBytes >= EMERGENCY_BUFFER_BYTES
    if (paused === sourcePaused) {
      return
    }

    sourcePaused = paused
    if (paused) {
      child.pause()
    } else {
      child.resume()
    }
  }
  const send = (socket: net.Socket, frame: SessionFrame) => {
    if (!socket.destroyed) {
      socket.write(`${JSON.stringify(frame)}\n`)
    }
  }
  const drain = (socket: net.Socket) =>
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off('drain', onDrain)
        socket.off('close', onClose)
        socket.off('error', onError)
      }
      const onDrain = () => {
        cleanup()
        resolve()
      }
      const onClose = () => {
        cleanup()
        reject(new Error('Engine disconnected'))
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      socket.once('drain', onDrain)
      socket.once('close', onClose)
      socket.once('error', onError)
      if (socket.destroyed) {
        onClose()
      }
    })
  const settle = (context: Engine) => {
    for (let index = context.waiters.length - 1; index >= 0; index--) {
      if (context.waiters[index]!.fence <= context.sent) {
        context.waiters.splice(index, 1)[0]!.resolve()
      }
    }
  }
  const sendRecord = async (
    context: Engine,
    frame: SessionFrame & { sequence: number }
  ) => {
    if (context.socket.destroyed || engine !== context) {
      throw new Error('Engine disconnected')
    }

    const accepted = context.socket.write(`${JSON.stringify(frame)}\n`)
    context.sent = frame.sequence
    settle(context)
    if (!accepted) {
      await drain(context.socket)
    }
  }
  const pump = (context: Engine): void => {
    if (
      context.pumping ||
      context.replaying ||
      context.socket.destroyed ||
      engine !== context
    ) {
      return
    }

    context.pumping = (async () => {
      while (engine === context && !context.socket.destroyed) {
        const fence = context.paused ? context.forcedFence : journal.sequence
        if (context.sent >= fence) {
          return
        }

        const snapshot = journal.snapshot(context.sent)
        try {
          for await (const record of snapshot.records) {
            if (
              record.sequence >
              (context.paused ? context.forcedFence : snapshot.fence)
            ) {
              break
            }

            await sendRecord(context, record)
          }
        } finally {
          snapshot.close()
        }
      }
    })()
      .catch((error) => {
        for (const waiter of context.waiters.splice(0)) {
          waiter.reject(error)
        }
        if (!context.socket.destroyed) {
          console.error('Session replay failed:', error)
          context.socket.destroy()
        }
      })
      .finally(() => {
        context.pumping = null
        if (
          engine === context &&
          !context.socket.destroyed &&
          context.sent <
            (context.paused ? context.forcedFence : journal.sequence)
        ) {
          pump(context)
        }
      })
  }
  const flushThrough = (context: Engine, fence: number): Promise<void> => {
    if (context.sent >= fence) {
      return Promise.resolve()
    }

    context.forcedFence = Math.max(context.forcedFence, fence)
    return new Promise((resolve, reject) => {
      context.waiters.push({ fence, resolve, reject })
      pump(context)
    })
  }
  const retain = (record: SessionRecordInput) => {
    pending.push(record)
    pendingBytes +=
      record.type === 'output' || record.type === 'marker'
        ? Buffer.byteLength(record.data)
        : 128
    updateReadFlow()
  }
  const append = (record: SessionRecordInput) => {
    record = { ...record, at: record.at ?? Date.now() }
    if (status.error) {
      retain(record)
      return
    }

    try {
      journal.append(record)
      status.sequence = journal.sequence
      if (engine) {
        pump(engine)
      }
    } catch (error) {
      status.error = error instanceof Error ? error.message : String(error)
      retain(record)
      publishStatus()
      if (engine) {
        send(engine.socket, { type: 'fault', message: status.error })
      }

      console.error(status.error)
    }
  }
  child.onData((data) => {
    if (!terminating) {
      append({ type: 'output', data })
    }
  })
  child.onExit(({ exitCode }) => {
    status.exitCode = exitCode
    if (terminating) {
      return
    }

    if (sourcePaused) {
      // node-pty can close its read socket on exit even when paused. Never
      // advertise a complete recovery if exhausted storage could lose that tail.
      status.incomplete = true
      status.error =
        'The PTY exited while storage was exhausted; its journal may be incomplete. Preserve the journal and explicitly close this terminal.'
    }

    append({ type: 'exit', exitCode })
    publishStatus()
  })

  const server = net.createServer((socket) => {
    let authenticated = false
    let context: Engine | null = null
    let buffer = ''
    let requests = Promise.resolve()
    let admitted = 0
    socket.setEncoding('utf8')
    socket.setTimeout(10000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      if (context) {
        for (const waiter of context.waiters.splice(0)) {
          waiter.reject(new Error('Engine detached'))
        }
      }

      if (engine === context) {
        engine = null
      }
      // The PTY remains readable and its command keeps running.
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > SESSION_MAX_FRAME_BYTES) {
        socket.destroy()
        return
      }

      let boundary: number
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 1)
        socket.pause()
        admitted++
        requests = requests
          .then(async () => {
            const request = sessionRequestSchema.parse(JSON.parse(line))
            const independentClose =
              request.method === 'terminate' &&
              request.token !== undefined &&
              !authenticated
            if (
              request.method === 'attach' ||
              request.method === 'inspect' ||
              independentClose
            ) {
              const supplied = Buffer.from(request.token!)
              const expected = Buffer.from(manifest.token)
              if (
                authenticated ||
                supplied.length !== expected.length ||
                !crypto.timingSafeEqual(supplied, expected) ||
                (request.method === 'attach' && engine)
              ) {
                send(socket, {
                  type: 'response',
                  id: request.id,
                  status: null,
                  error:
                    'Session authentication failed or another engine is attached'
                })
                socket.end()
                return
              }

              if (request.method === 'inspect') {
                send(socket, {
                  type: 'response',
                  id: request.id,
                  status: { ...status },
                  error: null
                })
                socket.end()
                return
              }

              if (independentClose) {
                engine?.socket.destroy()
              }

              authenticated = true
              socket.setTimeout(0)
              context = {
                socket,
                replaying: true,
                paused: true,
                sent: 0,
                forcedFence: 0,
                pumping: null,
                waiters: []
              }
              engine = context
              if (request.method === 'attach') {
                if (request.journalLimitBytes !== undefined) {
                  journal.limitBytes = request.journalLimitBytes
                  manifest.journalLimitBytes = request.journalLimitBytes
                  fs.writeFileSync(
                    `${manifestPath}.tmp`,
                    JSON.stringify(manifest),
                    { mode: 0o600 }
                  )
                  fs.renameSync(`${manifestPath}.tmp`, manifestPath)
                }

                if (status.error && !status.incomplete) {
                  status.error = null
                  const records = pending.splice(0)
                  pendingBytes = 0
                  for (const record of records) {
                    append(record)
                  }
                  updateReadFlow()
                  publishStatus()
                }

                if (status.exitCode === null) {
                  status.process = child.process
                }

                const snapshot = journal.snapshot(0)
                send(socket, {
                  type: 'response',
                  id: request.id,
                  status: { ...status },
                  error: null
                })
                try {
                  for await (const record of snapshot.records) {
                    await sendRecord(context, record)
                  }
                } finally {
                  snapshot.close()
                }
                send(socket, { type: 'ready', sequence: snapshot.fence })
                context.replaying = false
                if (status.error) {
                  send(socket, { type: 'fault', message: status.error })
                }

                return
              }

              context.replaying = false
            }

            if (
              !authenticated ||
              !context ||
              engine !== context ||
              context.replaying ||
              terminating
            ) {
              socket.destroy()
              return
            }

            switch (request.method) {
              case 'status':
                if (status.exitCode === null) {
                  status.process = child.process
                }

                break
              case 'processed':
                if (request.sequence > context.sent) {
                  throw new Error('Invalid engine processing fence')
                }

                status.processedSequence = Math.max(
                  status.processedSequence,
                  request.sequence
                )
                publishStatus()
                break
              case 'write':
                if (status.exitCode === null) {
                  child.write(
                    request.encoding === 'base64'
                      ? Buffer.from(request.data, 'base64')
                      : request.data
                  )
                }

                break
              case 'resize': {
                if (status.error) {
                  throw new Error(status.error)
                }

                append({
                  type: 'resize',
                  cols: request.cols,
                  rows: request.rows
                })
                if (status.error) {
                  throw new Error(status.error)
                }

                const fence = status.sequence
                status.cols = request.cols
                status.rows = request.rows
                if (status.exitCode === null) {
                  child.resize(request.cols, request.rows)
                }

                publishStatus()
                await flushThrough(context, fence)
                break
              }
              case 'pause':
                context.paused = request.paused
                context.forcedFence = context.sent
                if (!context.paused) {
                  pump(context)
                }

                break
              case 'signal':
                if (status.exitCode === null) {
                  child.kill(request.signal)
                }

                break
              case 'marker': {
                if (status.error) {
                  throw new Error(status.error)
                }

                append({ type: 'marker', data: request.data })
                if (status.error) {
                  throw new Error(status.error)
                }

                await flushThrough(context, status.sequence)
                break
              }
              case 'metadata':
                manifest.metadata = request.metadata
                // Fence publication across engines, including an old socket
                // closing during a metadata update.
                fs.writeFileSync(
                  `${manifestPath}.tmp`,
                  JSON.stringify(manifest),
                  { mode: 0o600 }
                )
                fs.renameSync(`${manifestPath}.tmp`, manifestPath)
                break
              case 'terminate': {
                terminating = true
                const rows = await promisify(execFile)('ps', [
                  '-axo',
                  'pid=,ppid='
                ]).then(
                  (result) => result.stdout,
                  () => ''
                )
                const children = new Map<number, number[]>()
                for (const line of rows.split('\n')) {
                  const [pid, parent] = line.trim().split(/\s+/u).map(Number)
                  if (pid && parent) {
                    children.set(parent, [...(children.get(parent) ?? []), pid])
                  }
                }
                const descendants: number[] = []
                const remaining = [...(children.get(child.pid) ?? [])]
                while (remaining.length) {
                  const pid = remaining.pop()!
                  descendants.push(pid)
                  remaining.push(...(children.get(pid) ?? []))
                }
                if (status.exitCode === null) {
                  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
                    for (const pid of [
                      -child.pid,
                      ...[...descendants].reverse()
                    ]) {
                      try {
                        process.kill(pid, signal)
                      } catch (error) {
                        // SAFETY: Node process signaling errors have an errno code.
                        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                          throw error
                        }
                      }
                    }
                    if (signal === 'SIGTERM') {
                      await new Promise((resolve) => setTimeout(resolve, 500))
                    }
                  }
                }

                await new Promise<void>((resolve) =>
                  socket.end(
                    JSON.stringify({
                      type: 'response',
                      id: request.id,
                      status: { ...status },
                      error: null
                    }) + '\n',
                    resolve
                  )
                )
                server.close()
                journal.close()
                await fs.promises.rm(manifest.socketPath, { force: true })
                await fs.promises.rm(directory, {
                  recursive: true,
                  force: true
                })
                process.exit(0)
              }
            }
            send(socket, {
              type: 'response',
              id: request.id,
              status: { ...status },
              error: null
            })
          })
          .catch((error) => {
            if (!socket.destroyed) {
              send(socket, {
                type: 'fault',
                message: error instanceof Error ? error.message : String(error)
              })
            }

            socket.destroy()
          })
          .finally(() => {
            admitted--
            if (admitted === 0) {
              socket.resume()
            }
          })
      }
    })
  })
  server.on('error', (error) => {
    status.error = `Session listener failed: ${error.message}`
    publishStatus()
    console.error(status.error)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(manifest.socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await fs.promises.chmod(manifest.socketPath, 0o600)
  publishStatus()
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
