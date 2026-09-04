import * as Effect from 'effect/Effect'
import type * as Fiber from 'effect/Fiber'
import * as FiberId from 'effect/FiberId'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Socket from '@effect/platform/Socket'
import { decodeBrowserFrame } from './browser-protocol.js'
import { parseSocketMessage } from './socket-protocol.js'
import { decodeUnknownOrNull } from './schema.js'
import { SOCKET_PATH } from './terminal-protocol.js'
import * as Schema from 'effect/Schema'

type EventArguments<
  Events,
  Event extends keyof Events
> = Events[Event] extends (...args: infer Arguments) => void ? Arguments : never
type ListenerMap = Map<string, Set<(...args: any[]) => void>>
type ProtocolAuthValue =
  | string
  | number
  | boolean
  | null
  | readonly ProtocolAuthValue[]
  | { readonly [key: string]: ProtocolAuthValue }
const connectErrorPayloadSchema = Schema.Struct({ message: Schema.String })

export interface ProtocolSocketOptions {
  readonly autoConnect?: boolean
  readonly webSocketConstructor?: (
    url: string,
    protocols?: string | string[]
  ) => globalThis.WebSocket
  readonly reconnection?: boolean
  readonly reconnectionDelay?: number
  readonly reconnectionDelayMax?: number
  readonly randomizationFactor?: number
  readonly query?: Readonly<Record<string, string>>
  readonly auth?: ProtocolAuthValue
  readonly authorize?: () => ProtocolAuthValue
}

export interface ProtocolSocket<
  ServerEvents extends object,
  ClientEvents extends object
> {
  readonly manager: {
    reconnection(enabled: boolean): void
    on(event: 'reconnect_attempt', listener: () => void): void
  }
  readonly volatile: {
    emit<Event extends keyof ClientEvents & string>(
      event: Event,
      ...args: EventArguments<ClientEvents, Event>
    ): void
  }
  connected: boolean
  connect(): this
  disconnect(): this
  emit<Event extends keyof ClientEvents & string>(
    event: Event,
    ...args: EventArguments<ClientEvents, Event>
  ): void
  on<Event extends keyof ServerEvents & string>(
    event: Event,
    listener: ServerEvents[Event] extends (...args: any[]) => void
      ? ServerEvents[Event]
      : never
  ): this
  on(event: 'connect', listener: () => void): this
  on(event: 'connect_error', listener: (error: Error) => void): this
  on(event: 'disconnect', listener: (reason: string) => void): this
  once<Event extends keyof ServerEvents & string>(
    event: Event,
    listener: ServerEvents[Event] extends (...args: any[]) => void
      ? ServerEvents[Event]
      : never
  ): this
  once(event: 'connect', listener: () => void): this
  once(event: 'connect_error', listener: (error: Error) => void): this
  once(event: 'disconnect', listener: (reason: string) => void): this
  removeAllListeners(): this
}

function websocketUrl(namespace: string): string {
  const base =
    namespace.startsWith('http://') || namespace.startsWith('https://')
      ? new URL(namespace)
      : new URL(namespace, globalThis.location?.href ?? 'http://127.0.0.1')
  const channel = base.pathname.split('/').filter(Boolean).at(-1) ?? ''
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  base.pathname = `${SOCKET_PATH}/${encodeURIComponent(channel)}`
  base.search = ''
  base.hash = ''
  return base.href
}

class EffectProtocolSocket<
  ServerEvents extends object,
  ClientEvents extends object
> implements ProtocolSocket<ServerEvents, ClientEvents> {
  connected = false
  readonly volatile = { emit: this.emit.bind(this) }
  readonly manager = {
    reconnection: (enabled: boolean) => {
      this.reconnectEnabled = enabled
      if (!enabled && this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
    },
    on: (event: 'reconnect_attempt', listener: () => void) => {
      if (event === 'reconnect_attempt') {
        this.managerListeners.add(listener)
      }
    }
  }
  private readonly listeners: ListenerMap = new Map()
  private readonly managerListeners = new Set<() => void>()
  private fiber: Fiber.RuntimeFiber<void, unknown> | null = null
  private outgoing: Queue.Queue<string | Uint8Array> | null = null
  private reconnectEnabled: boolean
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private manuallyClosed = false

  constructor(
    private readonly namespace: string,
    private readonly options: ProtocolSocketOptions
  ) {
    this.reconnectEnabled = options.reconnection ?? false
    if (options.autoConnect !== false) {
      this.connect()
    }
  }

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return this
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const once = (...args: any[]) => {
      this.listeners.get(event)?.delete(once)
      listener(...args)
    }
    return this.on(event, once)
  }

  removeAllListeners(): this {
    this.listeners.clear()
    this.managerListeners.clear()
    return this
  }

  emit(event: string, ...args: any[]): void {
    if (!this.connected || !this.outgoing) {
      return
    }

    const payload = JSON.stringify({ event, payload: args[0] ?? null })
    if (!Queue.unsafeOffer(this.outgoing, payload)) {
      this.disconnect()
    }
  }

  connect(): this {
    if (this.fiber) {
      return this
    }

    this.manuallyClosed = false
    const auth = this.options.authorize?.() ?? this.options.auth ?? {}

    const handshake = JSON.stringify({
      type: 'handshake',
      auth,
      query: this.options.query ?? {}
    })
    const program = Effect.scoped(
      Effect.gen(this, function* () {
        const socket = yield* Socket.makeWebSocket(
          websocketUrl(this.namespace),
          {
            closeCodeIsError: () => false,
            openTimeout: 10_000
          }
        )
        const outgoing = yield* Queue.bounded<string | Uint8Array>(512)
        this.outgoing = outgoing
        const write = yield* socket.writer
        yield* Effect.forkScoped(
          Effect.forever(Queue.take(outgoing).pipe(Effect.flatMap(write)))
        )
        yield* socket.runRaw(
          (data) => {
            if (data instanceof Uint8Array) {
              const frame = decodeBrowserFrame(data)
              if (!frame) {
                this.disconnect()
              } else {
                this.dispatch('frame', frame)
              }

              return
            }

            let value: unknown
            try {
              value = JSON.parse(data)
            } catch {
              this.disconnect()
              return
            }
            const message = parseSocketMessage(value)
            if (!message) {
              this.disconnect()
              return
            }

            if (message.event === 'connected') {
              this.connected = true
              this.reconnectAttempt = 0
              this.dispatch('connect')
              return
            }

            if (message.event === 'connect_error') {
              const payload = decodeUnknownOrNull(
                connectErrorPayloadSchema,
                message.payload
              )
              const reason = payload?.message ?? 'websocket error'
              this.dispatch('connect_error', new Error(reason))
              return
            }

            this.dispatch(message.event, message.payload)
          },
          { onOpen: Queue.offer(outgoing, handshake).pipe(Effect.asVoid) }
        )
      })
    ).pipe(
      Effect.provide(
        Layer.succeed(
          Socket.WebSocketConstructor,
          this.options.webSocketConstructor ??
            ((url: string, protocols?: string | string[]) =>
              new globalThis.WebSocket(url, protocols))
        )
      )
    )

    const fiber = Effect.runFork(program)
    this.fiber = fiber
    fiber.addObserver(() => {
      if (this.fiber !== fiber) {
        return
      }

      const wasConnected = this.connected
      this.fiber = null
      this.outgoing = null
      this.connected = false
      if (!wasConnected) {
        this.dispatch('connect_error', new Error('websocket error'))
      }

      this.dispatch('disconnect', 'transport close')
      this.scheduleReconnect()
    })
    return this
  }

  disconnect(): this {
    this.manuallyClosed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const fiber = this.fiber
    this.fiber = null
    this.outgoing = null
    const wasConnected = this.connected
    this.connected = false
    fiber?.unsafeInterruptAsFork(FiberId.none)
    if (wasConnected) {
      this.dispatch('disconnect', 'client disconnect')
    }

    return this
  }

  private dispatch(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args))
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || !this.reconnectEnabled || this.reconnectTimer) {
      return
    }

    this.managerListeners.forEach((listener) => listener())
    const minimum = this.options.reconnectionDelay ?? 100
    const maximum = this.options.reconnectionDelayMax ?? 1_000
    const randomization = this.options.randomizationFactor ?? 0
    const base = Math.min(maximum, minimum * 2 ** this.reconnectAttempt++)
    const jitter = base * randomization * (Math.random() * 2 - 1)
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null
        this.connect()
      },
      Math.max(0, base + jitter)
    )
  }
}

export function createProtocolSocket<
  ServerEvents extends object,
  ClientEvents extends object
>(
  namespace: string,
  options: ProtocolSocketOptions = {}
): ProtocolSocket<ServerEvents, ClientEvents> {
  return new EffectProtocolSocket(namespace, options)
}
