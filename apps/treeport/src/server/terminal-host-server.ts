import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import type { Socket } from 'node:net'
import type { TerminalHostSessionManager } from './terminal-host-sessions'
import type { TreeportSpanAttributes, TreeportTraceContext } from './tracing'
import {
  encodeTerminalHostFrame,
  TERMINAL_HOST_PROTOCOL_VERSION,
  TerminalHostFrameDecoder,
  terminalHostInputSchemas,
  terminalHostRecordSchema,
  type TerminalHostEventFrame,
  type TerminalHostRecord,
  type TerminalHostRequestFrame,
  type TerminalHostResponseFrame,
  type TerminalHostResults
} from './terminal-host-protocol'

// A valid frame can exceed this limit while Node owns it. Bound only the
// additional frames waiting behind a write that returned false.
const TERMINAL_HOST_MAX_QUEUED_BYTES = 4 * 1024 * 1024

export interface TerminalHostServerOptions {
  hostId: string
  hostKey: string
  token: string
  socketPath: string
  recordPath: string
  sessions: TerminalHostSessionManager
  pid?: number
  startedAt?: string
  onShutdown?: () => void | Promise<void>
  trace?: <A>(
    name: string,
    parent: TreeportTraceContext,
    attributes: TreeportSpanAttributes,
    evaluate: () => Promise<A>
  ) => Promise<A>
}

interface QueuedFrame {
  encoded: Buffer
  next: QueuedFrame | null
}

interface HostConnection {
  socket: Socket
  authenticated: boolean
  decoder: TerminalHostFrameDecoder
  outputUnsubscribes: Map<string, () => void>
  runtimeUnsubscribes: Map<string, () => void>
  requestTail: Promise<void>
  writeBlocked: boolean
  queuedFrameHead: QueuedFrame | null
  queuedFrameTail: QueuedFrame | null
  queuedBytes: number
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

export async function startTerminalHostServer(
  options: TerminalHostServerOptions
): Promise<{
  record: TerminalHostRecord
  close(): Promise<void>
}> {
  await options.sessions.initialize()
  const record: TerminalHostRecord = {
    protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
    hostId: options.hostId,
    hostKey: options.hostKey,
    pid: options.pid ?? process.pid,
    socketPath: options.socketPath,
    startedAt: options.startedAt ?? new Date().toISOString()
  }
  const connections = new Set<HostConnection>()
  let closing = false
  let shuttingDown = false

  const send = (
    connection: HostConnection,
    frame: TerminalHostResponseFrame | TerminalHostEventFrame
  ): boolean => {
    if (connection.socket.destroyed) {
      return false
    }

    const encoded = encodeTerminalHostFrame(frame)
    if (connection.writeBlocked) {
      if (
        connection.queuedBytes + encoded.byteLength >
        TERMINAL_HOST_MAX_QUEUED_BYTES
      ) {
        connection.socket.destroy()
        return false
      }

      const queuedFrame: QueuedFrame = { encoded, next: null }
      if (connection.queuedFrameTail) {
        connection.queuedFrameTail.next = queuedFrame
      } else {
        connection.queuedFrameHead = queuedFrame
      }

      connection.queuedFrameTail = queuedFrame
      connection.queuedBytes += encoded.byteLength
      return true
    }

    try {
      connection.writeBlocked = !connection.socket.write(encoded)
      return true
    } catch {
      connection.socket.destroy()
      return false
    }
  }

  const flush = (connection: HostConnection): void => {
    if (connection.socket.destroyed) {
      return
    }

    connection.writeBlocked = false
    while (connection.queuedFrameHead) {
      const queuedFrame = connection.queuedFrameHead
      connection.queuedFrameHead = queuedFrame.next
      if (!connection.queuedFrameHead) {
        connection.queuedFrameTail = null
      }

      connection.queuedBytes -= queuedFrame.encoded.byteLength
      try {
        if (!connection.socket.write(queuedFrame.encoded)) {
          connection.writeBlocked = true
          return
        }
      } catch {
        connection.socket.destroy()
        return
      }
    }
  }

  const respond = <Method extends keyof TerminalHostResults>(
    connection: HostConnection,
    id: string,
    result: TerminalHostResults[Method]
  ) =>
    send(connection, {
      protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
      type: 'response',
      id,
      result,
      error: null
    })

  const fail = (
    connection: HostConnection,
    id: string,
    code: string,
    message: string,
    details: Pick<
      NonNullable<TerminalHostResponseFrame['error']>,
      'hostProtocolVersion' | 'liveSessionCount'
    > = {}
  ) =>
    send(connection, {
      protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
      type: 'response',
      id,
      result: null,
      error: { code, message, ...details }
    })

  const handleRequest = async (
    connection: HostConnection,
    frame: TerminalHostRequestFrame
  ): Promise<void> => {
    if (frame.protocolVersion !== TERMINAL_HOST_PROTOCOL_VERSION) {
      fail(
        connection,
        frame.id,
        'INCOMPATIBLE_PROTOCOL',
        `Terminal host protocol ${TERMINAL_HOST_PROTOCOL_VERSION} is not compatible with daemon protocol ${frame.protocolVersion}`,
        {
          hostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
          liveSessionCount: options.sessions.sessionCount
        }
      )
      return
    }

    if (!connection.authenticated) {
      if (frame.method !== 'handshake') {
        fail(connection, frame.id, 'AUTH_REQUIRED', 'Handshake is required')
        connection.socket.destroy()
        return
      }

      const input = terminalHostInputSchemas.handshake.parse(frame.input)
      if (!tokensMatch(input.token ?? '', options.token)) {
        fail(connection, frame.id, 'AUTH_FAILED', 'Authentication failed')
        connection.socket.destroy()
        return
      }

      if (input.hostKey !== options.hostKey) {
        fail(connection, frame.id, 'HOST_MISMATCH', 'Terminal host key differs')
        connection.socket.destroy()
        return
      }

      if (input.protocolVersion !== TERMINAL_HOST_PROTOCOL_VERSION) {
        fail(
          connection,
          frame.id,
          'INCOMPATIBLE_PROTOCOL',
          `Terminal host protocol ${TERMINAL_HOST_PROTOCOL_VERSION} is not compatible with daemon protocol ${input.protocolVersion}`,
          {
            hostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
            liveSessionCount: options.sessions.sessionCount
          }
        )
        return
      }

      connection.authenticated = true
      respond<'handshake'>(connection, frame.id, {
        ...record,
        liveSessionCount: options.sessions.sessionCount,
        traceContext: true
      })
      return
    }

    if (shuttingDown) {
      fail(
        connection,
        frame.id,
        'HOST_SHUTTING_DOWN',
        'The terminal host is shutting down'
      )
      return
    }

    switch (frame.method) {
      case 'handshake':
        fail(
          connection,
          frame.id,
          'ALREADY_AUTHENTICATED',
          'Handshake is complete'
        )
        return
      case 'create':
        await options.sessions.createTerminal(
          terminalHostInputSchemas.create.parse(frame.input)
        )
        respond<'create'>(connection, frame.id, null)
        return
      case 'inventory': {
        const input = terminalHostInputSchemas.inventory.parse(frame.input)
        respond<'inventory'>(
          connection,
          frame.id,
          await options.sessions.listTerminals(input.worktreeId)
        )
        return
      }
      case 'state': {
        const input = terminalHostInputSchemas.state.parse(frame.input)
        respond<'state'>(
          connection,
          frame.id,
          await options.sessions.terminalState(input.terminalId)
        )
        return
      }
      case 'attach': {
        const input = terminalHostInputSchemas.attach.parse(frame.input)
        connection.outputUnsubscribes.get(input.terminalId)?.()
        const unsubscribe = options.sessions.subscribeOutput(
          input.terminalId,
          (output, sequence) => {
            send(connection, {
              protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
              type: 'event',
              event: 'output',
              data: { terminalId: input.terminalId, output, sequence }
            })
          }
        )
        connection.outputUnsubscribes.set(input.terminalId, unsubscribe)
        const snapshot = await options.sessions.snapshot(input.terminalId)
        if (snapshot === null) {
          unsubscribe()
          connection.outputUnsubscribes.delete(input.terminalId)
        }

        respond<'attach'>(connection, frame.id, snapshot)
        return
      }
      case 'unsubscribeOutput': {
        const input = terminalHostInputSchemas.unsubscribeOutput.parse(
          frame.input
        )
        connection.outputUnsubscribes.get(input.terminalId)?.()
        connection.outputUnsubscribes.delete(input.terminalId)
        respond<'unsubscribeOutput'>(connection, frame.id, null)
        return
      }
      case 'subscribeRuntime': {
        const input = terminalHostInputSchemas.subscribeRuntime.parse(
          frame.input
        )
        connection.runtimeUnsubscribes.get(input.terminalId)?.()
        connection.runtimeUnsubscribes.set(
          input.terminalId,
          options.sessions.subscribeRuntime(input.terminalId, (value) => {
            send(connection, {
              protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
              type: 'event',
              event: 'runtime',
              data: { terminalId: input.terminalId, value }
            })
          })
        )
        respond<'subscribeRuntime'>(connection, frame.id, null)
        return
      }
      case 'unsubscribeRuntime': {
        const input = terminalHostInputSchemas.unsubscribeRuntime.parse(
          frame.input
        )
        connection.runtimeUnsubscribes.get(input.terminalId)?.()
        connection.runtimeUnsubscribes.delete(input.terminalId)
        respond<'unsubscribeRuntime'>(connection, frame.id, null)
        return
      }
      case 'runtimeState': {
        const input = terminalHostInputSchemas.runtimeState.parse(frame.input)
        respond<'runtimeState'>(
          connection,
          frame.id,
          options.sessions.runtimeState(input.terminalId)
        )
        return
      }
      case 'write': {
        const input = terminalHostInputSchemas.write.parse(frame.input)
        options.sessions.write(
          input.terminalId,
          input.encoding === 'base64'
            ? Buffer.from(input.data, 'base64')
            : input.data,
          input.authority
        )
        respond<'write'>(connection, frame.id, null)
        return
      }
      case 'prepareQueryAuthority': {
        const input = terminalHostInputSchemas.prepareQueryAuthority.parse(
          frame.input
        )
        respond<'prepareQueryAuthority'>(
          connection,
          frame.id,
          await options.sessions.prepareQueryAuthority(input.terminalId)
        )
        return
      }
      case 'activateQueryAuthority': {
        const input = terminalHostInputSchemas.activateQueryAuthority.parse(
          frame.input
        )
        await options.sessions.activateQueryAuthority(
          input.terminalId,
          input.transitionId,
          input.attachmentId,
          input.generation
        )
        respond<'activateQueryAuthority'>(connection, frame.id, null)
        return
      }
      case 'hostQueryAuthority': {
        const input = terminalHostInputSchemas.hostQueryAuthority.parse(
          frame.input
        )
        await options.sessions.useHostQueryAuthority(input.terminalId)
        respond<'hostQueryAuthority'>(connection, frame.id, null)
        return
      }
      case 'resize': {
        const input = terminalHostInputSchemas.resize.parse(frame.input)
        await options.sessions.resize(input.terminalId, input.cols, input.rows)
        respond<'resize'>(connection, frame.id, null)
        return
      }
      case 'capture': {
        const input = terminalHostInputSchemas.capture.parse(frame.input)
        respond<'capture'>(
          connection,
          frame.id,
          await options.sessions.captureTerminal(input.terminalId, input.lines)
        )
        return
      }
      case 'rename': {
        const input = terminalHostInputSchemas.rename.parse(frame.input)
        await options.sessions.renameTerminal(
          input.terminalId,
          input.name,
          input.updatedAt
        )
        respond<'rename'>(connection, frame.id, null)
        return
      }
      case 'processes': {
        const input = terminalHostInputSchemas.processes.parse(frame.input)
        respond<'processes'>(
          connection,
          frame.id,
          await options.sessions.listProcesses(input.worktreeId)
        )
        return
      }
      case 'titleState': {
        const input = terminalHostInputSchemas.titleState.parse(frame.input)
        respond<'titleState'>(
          connection,
          frame.id,
          await options.sessions.terminalTitleState(input.terminalId)
        )
        return
      }
      case 'signal': {
        const input = terminalHostInputSchemas.signal.parse(frame.input)
        await options.sessions.signalTerminal(input.terminalId, input.signal)
        respond<'signal'>(connection, frame.id, null)
        return
      }
      case 'kill': {
        const input = terminalHostInputSchemas.kill.parse(frame.input)
        await options.sessions.killTerminal(input.terminalId)
        respond<'kill'>(connection, frame.id, null)
        return
      }
      case 'killWorktree': {
        const input = terminalHostInputSchemas.killWorktree.parse(frame.input)
        respond<'killWorktree'>(
          connection,
          frame.id,
          await options.sessions.killWorktree(input.worktreeId)
        )
        return
      }
      case 'shutdown':
        terminalHostInputSchemas.shutdown.parse(frame.input)
        if (options.sessions.sessionCount > 0) {
          fail(
            connection,
            frame.id,
            'HOST_NOT_EMPTY',
            'The terminal host still owns live or exited sessions',
            { liveSessionCount: options.sessions.sessionCount }
          )
          return
        }

        shuttingDown = true
        await options.sessions.shutdown().catch((error) => {
          shuttingDown = false
          throw error
        })
        respond<'shutdown'>(connection, frame.id, null)
        setImmediate(() => {
          void close()
            .then(() => options.onShutdown?.())
            .catch((error) => {
              console.error(
                '[Treeport terminal host] Requested shutdown failed:',
                error instanceof Error ? error.message : String(error)
              )
            })
        })
    }
  }

  const server = net.createServer((socket) => {
    socket.setNoDelay(true)
    const connection: HostConnection = {
      socket,
      authenticated: false,
      decoder: new TerminalHostFrameDecoder(),
      outputUnsubscribes: new Map(),
      runtimeUnsubscribes: new Map(),
      requestTail: Promise.resolve(),
      writeBlocked: false,
      queuedFrameHead: null,
      queuedFrameTail: null,
      queuedBytes: 0
    }
    connections.add(connection)
    const release = () => {
      connections.delete(connection)
      connection.queuedFrameHead = null
      connection.queuedFrameTail = null
      connection.queuedBytes = 0
      for (const unsubscribe of connection.outputUnsubscribes.values()) {
        unsubscribe()
      }
      for (const unsubscribe of connection.runtimeUnsubscribes.values()) {
        unsubscribe()
      }
      connection.outputUnsubscribes.clear()
      connection.runtimeUnsubscribes.clear()
      if (connection.authenticated) {
        void options.sessions.restoreHostQueryAuthority().catch((error) => {
          console.error(
            '[Treeport terminal host] Failed to restore query authority after a client disconnected:',
            error instanceof Error ? error.message : String(error)
          )
        })
      }
    }
    socket.once('close', release)
    socket.on('error', () => undefined)
    socket.on('drain', () => flush(connection))
    socket.on('data', (chunk) => {
      let frames
      try {
        frames = connection.decoder.push(chunk)
      } catch {
        socket.destroy()
        return
      }

      for (const frame of frames) {
        if (frame.type !== 'request') {
          socket.destroy()
          return
        }

        const admittedAt = Date.now()
        const run = () => {
          const evaluate = () => handleRequest(connection, frame)
          const request =
            frame.trace && options.trace
              ? options.trace(
                  frame.method === 'create'
                    ? 'treeport.terminal_host.pty.create'
                    : frame.method === 'attach'
                      ? 'treeport.terminal_host.attach'
                      : frame.method === 'kill'
                        ? 'treeport.terminal_host.pty.remove'
                        : 'treeport.terminal_host.request',
                  frame.trace,
                  {
                    'treeport.terminal_host.method': frame.method,
                    'treeport.terminal_host.queue_wait_ms':
                      Date.now() - admittedAt
                  },
                  evaluate
                )
              : evaluate()
          return request.catch((error) => {
            fail(
              connection,
              frame.id,
              'REQUEST_FAILED',
              error instanceof Error ? error.message : String(error)
            )
          })
        }
        if (connection.authenticated && frame.method === 'kill') {
          // Wait for preceding control work so kill cannot overtake create for
          // the same ID, but do not put slow physical cleanup on the control
          // tail. Request IDs allow this response to arrive out of order.
          void connection.requestTail.then(run)
        } else {
          connection.requestTail = connection.requestTail.then(run)
        }
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await fs.chmod(options.socketPath, 0o600)
  const temporaryRecordPath = `${options.recordPath}.${process.pid}.tmp`
  await fs.writeFile(temporaryRecordPath, `${JSON.stringify(record)}\n`, {
    mode: 0o600
  })
  await fs.rename(temporaryRecordPath, options.recordPath)

  async function close(): Promise<void> {
    if (closing) {
      return
    }

    closing = true
    for (const connection of connections) {
      connection.socket.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const ownsRecord = await fs
      .readFile(options.recordPath, 'utf8')
      .then((value) => {
        const parsed = terminalHostRecordSchema.safeParse(JSON.parse(value))
        return parsed.success && parsed.data.hostId === options.hostId
      })
      .catch(() => false)
    if (ownsRecord) {
      await fs.rm(options.recordPath, { force: true })
    }

    await fs.rm(options.socketPath, { force: true })
  }

  return { record, close }
}
