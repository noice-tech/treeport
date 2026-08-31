import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import type { Socket } from 'node:net'
import type { DirectPtySessionManager } from './direct-pty-sessions'
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

const TERMINAL_HOST_CONNECTION_HIGH_WATERMARK = 64 * 1024 * 1024

interface TerminalHostServerOptions {
  hostId: string
  hostKey: string
  token: string
  socketPath: string
  recordPath: string
  sessions: DirectPtySessionManager
  pid?: number
  startedAt?: string
  onShutdown?: () => void
}

interface HostConnection {
  socket: Socket
  authenticated: boolean
  decoder: TerminalHostFrameDecoder
  outputUnsubscribes: Map<string, () => void>
  runtimeUnsubscribes: Map<string, () => void>
  requestTail: Promise<void>
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

  const send = (
    connection: HostConnection,
    frame: TerminalHostResponseFrame | TerminalHostEventFrame
  ): boolean => {
    if (
      connection.socket.destroyed ||
      connection.socket.writableLength > TERMINAL_HOST_CONNECTION_HIGH_WATERMARK
    ) {
      connection.socket.destroy()
      return false
    }

    connection.socket.write(encodeTerminalHostFrame(frame))
    return true
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
        liveSessionCount: options.sessions.sessionCount
      })
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
        await options.sessions.createSession(
          terminalHostInputSchemas.create.parse(frame.input)
        )
        respond<'create'>(connection, frame.id, null)
        return
      case 'list': {
        const input = terminalHostInputSchemas.list.parse(frame.input)
        respond<'list'>(
          connection,
          frame.id,
          await options.sessions.listSessions(input.socketName)
        )
        return
      }
      case 'state': {
        const input = terminalHostInputSchemas.state.parse(frame.input)
        respond<'state'>(
          connection,
          frame.id,
          await options.sessions.sessionState(
            input.socketName,
            input.sessionName
          )
        )
        return
      }
      case 'size': {
        const input = terminalHostInputSchemas.size.parse(frame.input)
        respond<'size'>(
          connection,
          frame.id,
          await options.sessions.sessionSize(
            input.socketName,
            input.sessionName
          )
        )
        return
      }
      case 'snapshot': {
        const input = terminalHostInputSchemas.snapshot.parse(frame.input)
        respond<'snapshot'>(
          connection,
          frame.id,
          await options.sessions.snapshot(input.terminalId)
        )
        return
      }
      case 'subscribeOutput': {
        const input = terminalHostInputSchemas.subscribeOutput.parse(
          frame.input
        )
        connection.outputUnsubscribes.get(input.terminalId)?.()
        connection.outputUnsubscribes.set(
          input.terminalId,
          options.sessions.subscribeOutput(
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
        )
        respond<'subscribeOutput'>(connection, frame.id, null)
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
            : input.data
        )
        respond<'write'>(connection, frame.id, null)
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
          await options.sessions.capturePane(
            input.socketName,
            input.sessionName,
            input.lines
          )
        )
        return
      }
      case 'rename': {
        const input = terminalHostInputSchemas.rename.parse(frame.input)
        await options.sessions.renameTerminal(
          input.socketName,
          input.sessionName,
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
          await options.sessions.listPaneProcesses(
            input.socketName,
            input.worktreeId
          )
        )
        return
      }
      case 'titleState': {
        const input = terminalHostInputSchemas.titleState.parse(frame.input)
        respond<'titleState'>(
          connection,
          frame.id,
          await options.sessions.sessionTitleState(
            input.socketName,
            input.sessionName
          )
        )
        return
      }
      case 'setShellTitle': {
        terminalHostInputSchemas.setShellTitle.parse(frame.input)
        await options.sessions.setSessionShellTitle()
        respond<'setShellTitle'>(connection, frame.id, null)
        return
      }
      case 'kill': {
        const input = terminalHostInputSchemas.kill.parse(frame.input)
        await options.sessions.killSession(
          input.socketName,
          input.sessionName,
          input.terminalId
        )
        respond<'kill'>(connection, frame.id, null)
        return
      }
      case 'killServer': {
        const input = terminalHostInputSchemas.killServer.parse(frame.input)
        respond<'killServer'>(
          connection,
          frame.id,
          await options.sessions.killServer(input.socketName)
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

        respond<'shutdown'>(connection, frame.id, null)
        setImmediate(() => {
          void close().then(() => options.onShutdown?.())
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
      requestTail: Promise.resolve()
    }
    connections.add(connection)
    const release = () => {
      connections.delete(connection)
      for (const unsubscribe of connection.outputUnsubscribes.values()) {
        unsubscribe()
      }
      for (const unsubscribe of connection.runtimeUnsubscribes.values()) {
        unsubscribe()
      }
      connection.outputUnsubscribes.clear()
      connection.runtimeUnsubscribes.clear()
    }
    socket.once('close', release)
    socket.on('error', () => undefined)
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

        connection.requestTail = connection.requestTail
          .then(() => handleRequest(connection, frame))
          .catch((error) => {
            fail(
              connection,
              frame.id,
              'REQUEST_FAILED',
              error instanceof Error ? error.message : String(error)
            )
          })
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
