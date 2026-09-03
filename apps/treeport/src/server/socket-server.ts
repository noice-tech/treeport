import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import type {
  BrowserClientMessage,
  BrowserClientToServerEvents,
  BrowserOwnerAuth,
  BrowserOwnerClientMessage,
  BrowserOwnerClientToServerEvents,
  BrowserOwnerServerToClientEvents,
  BrowserServerToClientEvents,
  EventsServerToClientEvents,
  TerminalClientToServerEvents,
  TerminalServerToClientEvents
} from '@treeport/shared'
import {
  parseBrowserAuth,
  parseBrowserOwnerAuth,
  parseTerminalAuth,
  SOCKET_IO_PATH,
  TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalAuth,
  type TerminalServerEvent,
  type TerminalServerPayload
} from '@treeport/shared'
import type { AppConfig, TreeportService } from './core/index'
import {
  TerminalAttachmentManager,
  type TerminalTransport
} from './terminal-attachments'
import { authorizeRequest } from './request-security'
import type { TerminalMetadataManager } from './terminal-metadata'
import type { TerminalAttachmentBackend } from './terminal-host-sessions'
import {
  BrowserSessionManager,
  type BrowserOwnerTransport,
  type BrowserTransport
} from './browser-sessions'

interface ClientToServerEvents
  extends
    BrowserClientToServerEvents,
    BrowserOwnerClientToServerEvents,
    TerminalClientToServerEvents {}

interface ServerToClientEvents
  extends
    BrowserServerToClientEvents,
    BrowserOwnerServerToClientEvents,
    EventsServerToClientEvents,
    TerminalServerToClientEvents {}

interface SocketData {
  terminalAuth?: TerminalAuth
  browserTicket?: string
  browserOwnerAuth?: BrowserOwnerAuth
  terminalProtocolVersion?: typeof TERMINAL_PROTOCOL_VERSION
}

type InterServerEvents = Record<never, never>

type TreeportSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>

export interface BrowserSessionController {
  accept(ticket: string, transport: BrowserTransport): Promise<string>
  message(connectionId: string, message: BrowserClientMessage): void
  close(connectionId: string): void
  acceptOwner(
    auth: BrowserOwnerAuth,
    transport: BrowserOwnerTransport
  ): Promise<string>
  ownerMessage(connectionId: string, message: BrowserOwnerClientMessage): void
  closeOwner(connectionId: string): void
}

interface SocketServerResult {
  io: TreeportSocketServer
  attachments: TerminalAttachmentManager
  browserSessions: BrowserSessionController
}

interface SocketServerDependencies {
  service: TreeportService
  config: AppConfig
  terminalMetadata: TerminalMetadataManager
  terminalHost: TerminalAttachmentBackend
  attachmentManager?: TerminalAttachmentManager
  browserSessions?: BrowserSessionController
}

export function createSocketServer(
  httpServer: HttpServer,
  {
    service,
    config,
    terminalMetadata,
    terminalHost,
    attachmentManager,
    browserSessions
  }: SocketServerDependencies
): SocketServerResult {
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
      callback(null, authorizeRequest(request, { socketUpgrade: true }).allowed)
  })
  const metadataReady = terminalMetadata.initialize()
  const attachments =
    attachmentManager ??
    new TerminalAttachmentManager(service, terminalMetadata, terminalHost)
  const hostedBrowsers =
    browserSessions ?? new BrowserSessionManager(service, config)

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
        void Promise.all([
          service.runEffect(service.panels.listWebPanels()),
          service.runEffect(service.panels.listBrowserPanels())
        ])
          .then(([webPanels, browserPanels]) => {
            if (!socket.connected) {
              return
            }

            socket.emit('snapshot', {
              at: new Date().toISOString(),
              terminalMetadata: metadataSnapshot,
              webPanels,
              browserPanels
            })
            queuedEvents.splice(0, representedEventCount)
            while (queuedEvents.length && socket.connected) {
              socket.emit('product_event', queuedEvents.shift()!)
            }
            snapshotted = true
          })
          .catch((error) => {
            console.error('[Treeport] Socket.IO panel snapshot failed:', error)
            socket.disconnect(true)
          })
      },
      (error) => {
        console.error(
          '[Treeport] Socket.IO event snapshot failed:',
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
    if (requestedVersion !== String(TERMINAL_PROTOCOL_VERSION)) {
      next(new Error('UNSUPPORTED_TERMINAL_PROTOCOL'))
      return
    }

    socket.data.terminalAuth = auth
    socket.data.terminalProtocolVersion = TERMINAL_PROTOCOL_VERSION
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

        // SAFETY: TerminalTransport accepts only terminal protocol events and matching payloads.
        const emit = socket.emit.bind(socket) as (
          event: TerminalServerEvent,
          payload: TerminalServerPayload
        ) => void
        emit(event, payload)
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
    socket.on('query_authority', (payload) =>
      attachments.message(connectionId, 'query_authority', payload)
    )
    socket.once('disconnect', () => attachments.close(connectionId))
  })

  const browsers = io.of('/browsers')
  browsers.use((socket, next) => {
    const auth = parseBrowserAuth(socket.handshake.auth)
    if (!auth) {
      next(new Error('INVALID_BROWSER_AUTH'))
      return
    }

    socket.data.browserTicket = auth.ticket
    next()
  })
  browsers.on('connection', (socket) => {
    const transport: BrowserTransport = {
      id: socket.id,
      isConnected: () => socket.connected,
      sendMessage(message) {
        if (!socket.connected) {
          return false
        }

        socket.emit('message', message)
        return true
      },
      sendFrame(frame) {
        if (!socket.connected) {
          return false
        }

        socket.emit('frame', frame)
        return true
      },
      disconnect() {
        socket.disconnect(true)
      }
    }
    socket.on('command', (message) =>
      hostedBrowsers.message(socket.id, message)
    )
    socket.once('disconnect', () => hostedBrowsers.close(socket.id))
    void hostedBrowsers
      .accept(socket.data.browserTicket!, transport)
      .catch(() => socket.disconnect(true))
  })

  const browserOwners = io.of('/browser-owners')
  browserOwners.use((socket, next) => {
    const auth = parseBrowserOwnerAuth(socket.handshake.auth)
    if (!auth) {
      next(new Error('INVALID_BROWSER_OWNER_AUTH'))
      return
    }

    socket.data.browserOwnerAuth = auth
    next()
  })
  browserOwners.on('connection', (socket) => {
    const transport: BrowserOwnerTransport = {
      id: socket.id,
      isConnected: () => socket.connected,
      send(message) {
        if (!socket.connected) {
          return false
        }

        socket.emit('ownerMessage', message)
        return true
      },
      disconnect() {
        socket.disconnect(true)
      }
    }
    socket.on('ownerMessage', (message) =>
      hostedBrowsers.ownerMessage(socket.id, message)
    )
    socket.once('disconnect', () => hostedBrowsers.closeOwner(socket.id))
    void hostedBrowsers
      .acceptOwner(socket.data.browserOwnerAuth!, transport)
      .catch(() => socket.disconnect(true))
  })

  return { io, attachments, browserSessions: hostedBrowsers }
}
