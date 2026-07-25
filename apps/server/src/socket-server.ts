import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import type {
  EventsServerToClientEvents,
  TerminalClientToServerEvents,
  TerminalServerToClientEvents
} from '@tasktty/shared'
import {
  parseTerminalAuth,
  SOCKET_IO_PATH,
  TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalAuth,
  type TerminalServerEvent,
  type TerminalServerPayload
} from '@tasktty/shared'
import type { AppConfig, TaskTTYService, TmuxAdapter } from './core/index'
import {
  TerminalAttachmentManager,
  type TerminalTransport
} from './terminal-attachments'
import type { TerminalMetadataManager } from './terminal-metadata'

type ClientToServerEvents = TerminalClientToServerEvents

interface ServerToClientEvents
  extends EventsServerToClientEvents, TerminalServerToClientEvents {}

interface SocketData {
  terminalAuth?: TerminalAuth
  terminalProtocolVersion?: 1 | typeof TERMINAL_PROTOCOL_VERSION
}

type InterServerEvents = Record<never, never>

interface SocketServerDependencies {
  service: TaskTTYService
  config: AppConfig
  tmux: TmuxAdapter
  terminalMetadata: TerminalMetadataManager
  attachmentManager?: TerminalAttachmentManager
}

function isAllowedSocketOrigin(
  request: IncomingMessage,
  apiUrl: string
): boolean {
  const origin = request.headers.origin
  if (origin === undefined) {
    return true
  }

  if (Array.isArray(origin) || !URL.canParse(origin)) {
    return false
  }

  const parsed = new URL(origin)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  const forwardedHost = request.headers['x-forwarded-host']
  const hosts = [
    request.headers.host,
    typeof forwardedHost === 'string'
      ? forwardedHost.split(',', 1)[0]?.trim()
      : undefined,
    URL.canParse(apiUrl) ? new URL(apiUrl).host : undefined
  ]
  return hosts.some((host) => host === parsed.host)
}

export function createSocketServer(
  httpServer: HttpServer,
  {
    service,
    config,
    tmux,
    terminalMetadata,
    attachmentManager
  }: SocketServerDependencies
): {
  io: Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >
  attachments: TerminalAttachmentManager
} {
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    path: SOCKET_IO_PATH,
    serveClient: false,
    transports: ['websocket'],
    perMessageDeflate: false,
    maxHttpBufferSize: TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
    allowRequest: (request, callback) =>
      callback(null, isAllowedSocketOrigin(request, config.apiUrl))
  })
  const metadataReady = terminalMetadata.initialize()
  const attachments =
    attachmentManager ??
    new TerminalAttachmentManager(
      service,
      tmux,
      config.tmuxPath,
      terminalMetadata
    )

  io.of('/events').on('connection', (socket) => {
    const queuedEvents: Parameters<
      EventsServerToClientEvents['product_event']
    >[0][] = []
    let snapshotted = false
    const unsubscribe = service.events.subscribe((event) => {
      if (snapshotted && socket.connected) {
        socket.emit('product_event', event)
      } else if (socket.connected) {
        queuedEvents.push(event)
      }
    })
    socket.once('disconnect', unsubscribe)

    void metadataReady.then(
      () => {
        if (!socket.connected) {
          return
        }

        const metadataSnapshot = terminalMetadata.snapshot()
        const representedEventCount = queuedEvents.length
        socket.emit('snapshot', {
          at: new Date().toISOString(),
          terminalMetadata: metadataSnapshot
        })
        queuedEvents.splice(0, representedEventCount)
        while (queuedEvents.length && socket.connected) {
          socket.emit('product_event', queuedEvents.shift()!)
        }
        snapshotted = true
      },
      (error: unknown) => {
        console.error(
          '[TaskTTY] Socket.IO event snapshot failed:',
          error instanceof Error ? error.message : String(error)
        )
        socket.disconnect(true)
      }
    )
  })

  const terminals = io.of('/terminals')
  terminals.use((socket, next) => {
    const auth = parseTerminalAuth(socket.handshake.auth)
    if (!auth) {
      next(new Error('INVALID_TERMINAL_AUTH'))
      return
    }

    const requestedVersion = socket.handshake.query.terminalProtocol
    if (
      requestedVersion !== undefined &&
      requestedVersion !== String(TERMINAL_PROTOCOL_VERSION)
    ) {
      next(new Error('UNSUPPORTED_TERMINAL_PROTOCOL'))
      return
    }

    socket.data.terminalAuth = auth
    socket.data.terminalProtocolVersion = requestedVersion
      ? TERMINAL_PROTOCOL_VERSION
      : 1
    next()
  })
  terminals.on('connection', (socket) => {
    const auth = socket.data.terminalAuth!
    const transport: TerminalTransport = {
      id: socket.id,
      isConnected: () => socket.connected,
      send(event: TerminalServerEvent, payload: TerminalServerPayload) {
        if (!socket.connected) {
          return false
        }

        ;(socket.emit as (event: string, payload: unknown) => void)(
          event,
          payload
        )
        return true
      },
      disconnect(retryable: boolean) {
        if (retryable) {
          socket.client.conn.close()
        } else {
          socket.disconnect(true)
        }
      }
    }
    const connectionId = attachments.accept(
      auth,
      transport,
      socket.data.terminalProtocolVersion
    )
    socket.on('input', (payload) =>
      attachments.message(connectionId, 'input', payload)
    )
    socket.on('binary', (payload) =>
      attachments.message(connectionId, 'binary', payload)
    )
    socket.on('resize', (payload) =>
      attachments.message(connectionId, 'resize', payload)
    )
    socket.on('take_control', (payload) =>
      attachments.message(connectionId, 'take_control', payload)
    )
    socket.on('output_ack', (payload) =>
      attachments.message(connectionId, 'output_ack', payload)
    )
    socket.once('disconnect', () => attachments.close(connectionId))
  })

  return { io, attachments }
}
