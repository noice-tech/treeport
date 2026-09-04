import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import * as EffectSocket from '@effect/platform/Socket'
import {
  BROWSER_MAX_MESSAGE_BYTES,
  encodeBrowserFrame,
  parseBrowserAuth,
  parseBrowserClientMessage,
  parseBrowserOwnerAuth,
  parseBrowserOwnerClientMessage,
  parseSocketHandshake,
  parseSocketMessage,
  parseTerminalAuth,
  parseTerminalClientEvent,
  SOCKET_PATH,
  TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  type BrowserClientMessage,
  type BrowserOwnerAuth,
  type BrowserOwnerClientMessage,
  type BrowserOwnerServerMessage,
  type BrowserServerMessage,
  type TerminalClientEvent,
  type TerminalServerEvent,
  type TerminalServerPayload
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import { WebSocket, WebSocketServer } from 'ws'
import type { AppConfig, TreeportService } from './core/index'
import type { ApplicationServices } from './core/services/infrastructure/application-runtime'
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
import { networkTelemetry } from './network-telemetry'

const HANDSHAKE_TIMEOUT_MS = 10_000
const OUTBOUND_QUEUE_CAPACITY = 512
const CHANNELS = new Set(['terminals', 'browsers', 'browser-owners'])
const TERMINAL_EVENTS = new Set<TerminalClientEvent>([
  'input',
  'binary',
  'resize',
  'take_control',
  'output_ack',
  'query_authority'
])

export interface BrowserSessionController {
  accept(
    ticket: string,
    transport: BrowserTransport
  ): Effect.Effect<string, unknown, ApplicationServices>
  message(connectionId: string, message: BrowserClientMessage): void
  close(connectionId: string): void
  acceptOwner(
    auth: BrowserOwnerAuth,
    transport: BrowserOwnerTransport
  ): Effect.Effect<string, unknown, ApplicationServices>
  ownerMessage(connectionId: string, message: BrowserOwnerClientMessage): void
  closeOwner(connectionId: string): void
}

interface SocketServerDependencies {
  service: TreeportService
  config: AppConfig
  terminalMetadata: TerminalMetadataManager
  terminalHost: TerminalAttachmentBackend
  attachmentManager?: TerminalAttachmentManager
  browserSessions?: BrowserSessionController
}

interface SocketServerResult {
  attachments: TerminalAttachmentManager
  browserSessions: BrowserSessionController
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean
  closeConnections(): void
  close(): Promise<void>
}

/* eslint-disable anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- Raw WebSocket text is parsed before Effect Schema validates it. */
function json(value: string | Uint8Array): unknown | null {
  if (typeof value !== 'string') {
    return null
  }

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function byteLength(value: string | Uint8Array): number {
  return typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength
}

export function createSocketServer({
  service,
  config,
  terminalMetadata,
  terminalHost,
  attachmentManager,
  browserSessions
}: SocketServerDependencies): SocketServerResult {
  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: Math.max(
      BROWSER_MAX_MESSAGE_BYTES,
      TERMINAL_MAX_CLIENT_MESSAGE_BYTES
    )
  })
  const attachments =
    attachmentManager ??
    new TerminalAttachmentManager(service, terminalMetadata, terminalHost)
  const hostedBrowsers =
    browserSessions ?? new BrowserSessionManager(service, config)
  const connectionFibers = new Set<Fiber.RuntimeFiber<void, unknown>>()
  let closing = false

  const runConnection = (channel: string, accepted: WebSocket) => {
    let observedClose: { code: number; reason: string } | null = null
    let telemetryOpened = false
    accepted.once('close', (code, reason) => {
      observedClose = { code, reason: reason.toString('utf8').slice(0, 256) }
    })

    return Effect.scoped(
      Effect.gen(function* () {
        const incoming = yield* Queue.bounded<{
          message: string | Uint8Array
          queuedAt: number
        }>(64)
        const outgoing = yield* Queue.bounded<{
          message: string | Uint8Array
          queuedAt: number
        }>(OUTBOUND_QUEUE_CAPACITY)
        const socket = yield* EffectSocket.fromWebSocket(
          Effect.acquireRelease(
            // SAFETY: ws implements the WebSocket operations consumed by Effect Socket.
            // eslint-disable-next-line anti-slop/no-chained-type-assertions -- The ws and DOM declarations describe the same runtime object differently.
            Effect.succeed(accepted as unknown as globalThis.WebSocket),
            (websocket) =>
              Effect.sync(() => {
                if (websocket.readyState < WebSocket.CLOSING) {
                  websocket.close(1001, 'Treeport connection closed')
                }
              })
          ),
          { closeCodeIsError: () => false }
        )
        const write = yield* socket.writer
        const rejectHandshake = (message: string) =>
          write(
            JSON.stringify({
              event: 'connect_error',
              payload: { message }
            })
          ).pipe(Effect.zipRight(Effect.fail(new Error(message))))
        const reader = yield* Effect.forkScoped(
          socket.runRaw((message) =>
            Queue.offer(incoming, { message, queuedAt: Date.now() }).pipe(
              Effect.flatMap((accepted) =>
                accepted
                  ? networkTelemetry.message(channel, 'in', byteLength(message))
                  : networkTelemetry.dropped(channel, 'dropped')
              )
            )
          )
        )
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const outgoingMessage = yield* Queue.take(outgoing)
              const started = Date.now()
              yield* networkTelemetry.duration(
                channel,
                'queue_wait',
                started - outgoingMessage.queuedAt
              )
              yield* write(outgoingMessage.message)
              yield* networkTelemetry.message(
                channel,
                'out',
                byteLength(outgoingMessage.message)
              )
              yield* networkTelemetry.duration(
                channel,
                'socket_write_drain',
                Date.now() - started
              )
              yield* Queue.size(outgoing).pipe(
                Effect.flatMap((size) =>
                  networkTelemetry.queueDepth(channel, size)
                )
              )
            })
          )
        )
        const send = (
          event: string,
          payload:
            | TerminalServerPayload
            | BrowserServerMessage
            | BrowserOwnerServerMessage
            | null
        ): boolean => {
          const message = JSON.stringify({ event, payload })
          const offered = Queue.unsafeOffer(outgoing, {
            message,
            queuedAt: Date.now()
          })
          if (!offered) {
            networkTelemetry.droppedNow(channel, 'dropped')
          }

          return offered
        }
        const sendBinary = (message: Uint8Array): boolean => {
          const offered = Queue.unsafeOffer(outgoing, {
            message,
            queuedAt: Date.now()
          })
          if (!offered) {
            networkTelemetry.droppedNow(channel, 'dropped')
          }

          return offered
        }

        yield* networkTelemetry.connectionOpened(channel)
        telemetryOpened = true
        const first = yield* Queue.take(incoming).pipe(
          Effect.timeoutFail({
            duration: HANDSHAKE_TIMEOUT_MS,
            onTimeout: () => new Error('Socket handshake timed out')
          })
        )
        yield* networkTelemetry.duration(
          channel,
          'queue_wait',
          Date.now() - first.queuedAt
        )
        const handshake = parseSocketHandshake(json(first.message))
        if (!handshake) {
          yield* networkTelemetry.decodeFailure(channel)
          return yield* rejectHandshake('INVALID_SOCKET_HANDSHAKE')
        }

        let closeConnection: (() => void) | null = null
        let protocolConnectionId: string | null = null
        if (channel === 'terminals') {
          const auth = parseTerminalAuth(handshake.auth)
          if (!auth) {
            return yield* rejectHandshake('INVALID_TERMINAL_AUTH')
          }

          if (
            handshake.query.terminalProtocol !==
            String(TERMINAL_PROTOCOL_VERSION)
          ) {
            return yield* rejectHandshake('UNSUPPORTED_TERMINAL_PROTOCOL')
          }

          const transport: TerminalTransport = {
            id: crypto.randomUUID(),
            isConnected: () => accepted.readyState === WebSocket.OPEN,
            send: (
              event: TerminalServerEvent,
              payload: TerminalServerPayload
            ) => send(event, payload),
            disconnect: (retryable) =>
              accepted.close(
                retryable ? 1012 : 4001,
                retryable ? 'Terminal reconnect required' : 'Terminal rejected'
              )
          }
          protocolConnectionId = yield* attachments.accept(
            auth,
            transport,
            TERMINAL_PROTOCOL_VERSION
          )
          closeConnection = () => attachments.close(protocolConnectionId!)
          send('connected', null)
        } else if (channel === 'browsers') {
          const auth = parseBrowserAuth(handshake.auth)
          if (!auth) {
            return yield* rejectHandshake('INVALID_BROWSER_AUTH')
          }

          const transport: BrowserTransport = {
            id: crypto.randomUUID(),
            isConnected: () => accepted.readyState === WebSocket.OPEN,
            sendMessage: (message) => send('message', message),
            sendFrame: (frame) => sendBinary(encodeBrowserFrame(frame)),
            disconnect: () => accepted.close(4001, 'Browser rejected')
          }
          protocolConnectionId = yield* Effect.raceFirst(
            hostedBrowsers.accept(auth.ticket, transport),
            Fiber.join(reader).pipe(
              Effect.zipRight(
                Effect.fail(
                  new Error('Browser socket closed during attachment')
                )
              )
            )
          )
          closeConnection = () => hostedBrowsers.close(protocolConnectionId!)
          send('connected', null)
        } else {
          const auth = parseBrowserOwnerAuth(handshake.auth)
          if (!auth) {
            return yield* rejectHandshake('INVALID_BROWSER_OWNER_AUTH')
          }

          const transport: BrowserOwnerTransport = {
            id: crypto.randomUUID(),
            isConnected: () => accepted.readyState === WebSocket.OPEN,
            send: (message) => send('ownerMessage', message),
            disconnect: () => accepted.close(4001, 'Browser owner rejected')
          }
          protocolConnectionId = yield* Effect.raceFirst(
            hostedBrowsers.acceptOwner(auth, transport),
            Fiber.join(reader).pipe(
              Effect.zipRight(
                Effect.fail(
                  new Error('Browser owner socket closed during attachment')
                )
              )
            )
          )
          closeConnection = () =>
            hostedBrowsers.closeOwner(protocolConnectionId!)
          send('connected', null)
        }

        yield* Effect.addFinalizer(() => Effect.sync(() => closeConnection?.()))
        const messages = Effect.forever(
          Effect.gen(function* () {
            const raw = yield* Queue.take(incoming)
            yield* networkTelemetry.duration(
              channel,
              'queue_wait',
              Date.now() - raw.queuedAt
            )
            const parsed = parseSocketMessage(json(raw.message))
            if (!parsed) {
              yield* networkTelemetry.decodeFailure(channel)
              return
            }

            if (channel === 'terminals') {
              // SAFETY: Membership narrows the string to a terminal client event.
              const event = TERMINAL_EVENTS.has(
                parsed.event as TerminalClientEvent
              )
                ? (parsed.event as TerminalClientEvent)
                : null
              const payload = event
                ? parseTerminalClientEvent(event, parsed.payload)
                : null
              if (!event || !payload) {
                yield* networkTelemetry.decodeFailure(channel)
                accepted.close(1007, 'Invalid terminal message')
                return
              }

              attachments.message(protocolConnectionId!, event, payload)
            } else if (channel === 'browsers') {
              const payload = parseBrowserClientMessage(parsed.payload)
              if (!payload) {
                yield* networkTelemetry.decodeFailure(channel)
                accepted.close(1007, 'Invalid Browser message')
                return
              }

              hostedBrowsers.message(protocolConnectionId!, payload)
            } else if (channel === 'browser-owners') {
              const payload = parseBrowserOwnerClientMessage(parsed.payload)
              if (!payload) {
                yield* networkTelemetry.decodeFailure(channel)
                accepted.close(1007, 'Invalid Browser owner message')
                return
              }

              hostedBrowsers.ownerMessage(protocolConnectionId!, payload)
            }
          })
        )
        yield* Effect.raceFirst(messages, Fiber.join(reader))
      }).pipe(
        Effect.onExit((exit) => {
          if (!telemetryOpened) {
            return Effect.void
          }

          const details = observedClose
            ? observedClose.reason
              ? {
                  closeCode: observedClose.code,
                  wireReason: observedClose.reason
                }
              : { closeCode: observedClose.code }
            : undefined
          const closed = networkTelemetry.connectionClosed(
            channel,
            Exit.isInterrupted(exit)
              ? 'interrupted'
              : Exit.isFailure(exit)
                ? 'failed'
                : observedClose?.code === 1000 || observedClose?.code === 1001
                  ? 'normal'
                  : 'peer_closed',
            details
          )
          return Exit.isInterrupted(exit)
            ? Effect.zipRight(networkTelemetry.interrupted(channel), closed)
            : closed
        })
      )
    ).pipe(
      Effect.withSpan(`treeport.socket.${channel}`, {
        attributes: {
          'network.protocol': 'websocket',
          'treeport.channel': channel
        }
      }),
      Effect.catchAllCause((cause) =>
        Effect.logDebug('WebSocket connection ended').pipe(
          Effect.annotateLogs({ channel, cause: String(cause) })
        )
      )
    )
  }

  function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): boolean {
    const pathname = new URL(request.url ?? '/', 'http://treeport.local')
      .pathname
    if (!pathname.startsWith(`${SOCKET_PATH}/`)) {
      return false
    }

    const channel = pathname.slice(SOCKET_PATH.length + 1)
    if (!CHANNELS.has(channel)) {
      socket.destroy()
      return true
    }

    const security = authorizeRequest(request, { socketUpgrade: true })
    if (!security.allowed || closing) {
      const status = security.allowed ? 503 : security.status
      socket.write(
        `HTTP/1.1 ${status} ${status === 503 ? 'Service Unavailable' : 'Unauthorized'}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`
      )
      socket.destroy()
      return true
    }

    websocketServer.handleUpgrade(request, socket, head, (accepted) => {
      websocketServer.emit('connection', accepted, request)
      const fiber = service.forkEffect(runConnection(channel, accepted))
      connectionFibers.add(fiber)
      fiber.addObserver(() => connectionFibers.delete(fiber))
    })
    return true
  }

  return {
    attachments,
    browserSessions: hostedBrowsers,
    handleUpgrade,
    closeConnections: () => {
      for (const client of websocketServer.clients) {
        client.close(1012, 'Treeport reconnect required')
      }
    },
    close: async () => {
      closing = true
      attachments.dispose()
      for (const client of websocketServer.clients) {
        client.close(1001, 'Treeport is shutting down')
      }
      const forceClose = setTimeout(() => {
        for (const client of websocketServer.clients) {
          client.terminate()
        }
      }, 250)
      forceClose.unref()
      await Promise.all(
        [...connectionFibers].map(
          (fiber) =>
            new Promise<void>((resolve) => {
              fiber.addObserver(() => resolve())
            })
        )
      )
      clearTimeout(forceClose)
      await new Promise<void>((resolve) =>
        websocketServer.close(() => resolve())
      )
    }
  }
}
