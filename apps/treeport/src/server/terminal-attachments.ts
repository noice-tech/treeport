import crypto from 'node:crypto'
import type { IDisposable, IPty } from 'node-pty'
import * as pty from 'node-pty'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import type * as Scope from 'effect/Scope'
import {
  terminalBinarySchema,
  terminalInputSchema,
  terminalLegacyTakeControlSchema,
  terminalOutputAckSchema,
  terminalResizeSchema,
  terminalSizeSchema,
  terminalTakeControlSchema,
  TERMINAL_CONTROLLER_GRACE_MS,
  TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_OUTPUT_HIGH_WATERMARK,
  TERMINAL_OUTPUT_LOW_WATERMARK,
  TERMINAL_OUTPUT_STALL_TIMEOUT_MS,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalAuth,
  type TerminalClientEvent,
  type TerminalRuntimeMetadata,
  type TerminalServerEvent,
  type TerminalServerPayload
} from '@treeport/shared'
import type { TreeportService, TmuxAdapter } from './core/index'
import { resolveExecutablePath } from './core/index'
import type { TerminalMetadataManager } from './terminal-metadata'

type PtySpawner = typeof pty.spawn
type ConnectionState = 'initializing' | 'ready' | 'closed'
type TerminalProtocolVersion = 1 | typeof TERMINAL_PROTOCOL_VERSION
type AttachmentInitializationPhase =
  | 'refresh_terminal'
  | 'resolve_worktree'
  | 'configure_server'
  | 'track_metadata'
  | 'configure_window_size'
  | 'read_session_size'
  | 'resize_fallback'
  | 'spawn_pty'
  | 'pause_pty'
  | 'subscribe_metadata'
  | 'subscribe_pty_data'
  | 'subscribe_pty_exit'
  | 'announce_ready'

class AttachmentInitializationError {
  readonly _tag = 'AttachmentInitializationError'

  constructor(
    readonly phase: AttachmentInitializationPhase,
    readonly cause: unknown
  ) {}
}

const TERMINAL_MAX_QUEUED_INPUT_BYTES = 1024 * 1024
const TERMINAL_MAX_QUEUED_INPUT_MESSAGES = 256

export interface TerminalTransport {
  readonly id: string
  isConnected(): boolean
  send(event: TerminalServerEvent, payload: TerminalServerPayload): boolean
  disconnect(retryable: boolean): void
}

interface ClientConnection {
  id: string
  terminalId: string
  transport: TerminalTransport
  state: ConnectionState
  clientId: string
  pty: IPty | null
  streamId: string | null
  stallTimeout: NodeJS.Timeout | null
  dataDisposable: IDisposable | null
  exitDisposable: IDisposable | null
  nextSequence: number
  lastAckSequence: number
  unacknowledgedBytes: number
  outputBytes: Map<number, number>
  paused: boolean
  announcedReady: boolean
  metadataUnsubscribe: (() => void) | null
  historyUnsubscribe: (() => void) | null
  protocolVersion: TerminalProtocolVersion
  queuedInputBytes: number
  queuedInputMessages: number
  lifecycleFiber: Fiber.RuntimeFiber<void, never> | null
}

interface ControllerLease {
  clientId: string
  connectionId: string | null
  generation: number
  expiresAt: number
  timer: NodeJS.Timeout | null
}

interface CanonicalTerminalDimensions {
  cols: number
  rows: number
  revision: number
  socketName: string
  sessionName: string
}

function errorMessage(error: unknown): string {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).trim()
  return (message || 'Terminal attachment failed').slice(0, 1_000)
}

function tmuxEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && key !== 'TMUX' && key !== 'TMUX_PANE'
    )
  ) as NodeJS.ProcessEnv
}

export class TerminalAttachmentManager {
  private readonly clients = new Map<string, ClientConnection>()
  private readonly controllers = new Map<string, ControllerLease>()
  private readonly controllerGenerations = new Map<string, number>()
  private readonly dimensions = new Map<string, CanonicalTerminalDimensions>()
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly tmuxExecutable: string

  constructor(
    private readonly service: TreeportService,
    private readonly tmux: TmuxAdapter,
    tmuxExecutable: string,
    private readonly metadata: TerminalMetadataManager,
    private readonly spawnPty: PtySpawner = pty.spawn
  ) {
    this.tmuxExecutable = resolveExecutablePath(tmuxExecutable)
  }

  accept(
    auth: TerminalAuth,
    transport: TerminalTransport,
    protocolVersion: TerminalProtocolVersion = TERMINAL_PROTOCOL_VERSION
  ): string {
    const connection: ClientConnection = {
      id: transport.id,
      terminalId: auth.terminalId,
      transport,
      state: 'initializing',
      clientId: auth.clientId,
      pty: null,
      streamId: null,
      stallTimeout: null,
      dataDisposable: null,
      exitDisposable: null,
      nextSequence: 1,
      lastAckSequence: 0,
      unacknowledgedBytes: 0,
      outputBytes: new Map(),
      paused: false,
      announcedReady: false,
      metadataUnsubscribe: null,
      historyUnsubscribe: null,
      protocolVersion,
      queuedInputBytes: 0,
      queuedInputMessages: 0,
      lifecycleFiber: null
    }
    this.clients.set(connection.id, connection)
    connection.lifecycleFiber = Effect.runFork(
      Effect.yieldNow().pipe(
        Effect.zipRight(
          Effect.scoped(this.initialize(connection, auth.cols, auth.rows))
        ),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            if (connection.state === 'closed') {
              return
            }

            this.send(connection, 'terminal_error', {
              code: 'ATTACH_FAILED',
              message: errorMessage(error.cause),
              retryable: false
            })
            connection.transport.disconnect(false)
            this.close(connection.id)
          })
        )
      )
    )
    return connection.id
  }

  message(
    connectionId: string,
    event: TerminalClientEvent,
    value: unknown
  ): void {
    const connection = this.clients.get(connectionId)
    if (!connection || connection.state === 'closed') {
      return
    }

    if (connection.state !== 'ready') {
      this.protocolError(
        connection,
        'NOT_READY',
        'Terminal attachment is not ready'
      )
      return
    }

    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      this.protocolError(
        connection,
        'INVALID_MESSAGE',
        'Invalid terminal message'
      )
      return
    }

    const serializedBytes = Buffer.byteLength(serialized)
    if (serializedBytes > TERMINAL_MAX_CLIENT_MESSAGE_BYTES) {
      this.protocolError(
        connection,
        'MESSAGE_TOO_LARGE',
        'Terminal message is too large'
      )
      return
    }

    if (event === 'output_ack') {
      const parsed = terminalOutputAckSchema.safeParse(value)
      if (!parsed.success) {
        this.protocolError(connection, 'INVALID_MESSAGE', 'Invalid output ACK')
        return
      }

      this.acknowledgeOutput(
        connection,
        parsed.data.streamId,
        parsed.data.sequence
      )
      return
    }

    if (event === 'take_control') {
      if (connection.protocolVersion === TERMINAL_PROTOCOL_VERSION) {
        const parsed = terminalTakeControlSchema.safeParse(value)
        if (!parsed.success) {
          this.protocolError(
            connection,
            'INVALID_MESSAGE',
            'Invalid controller request'
          )
          return
        }

        this.takeControl(
          connection,
          parsed.data.generation,
          parsed.data.cols,
          parsed.data.rows
        )
        return
      }

      const parsed = terminalLegacyTakeControlSchema.safeParse(value)
      const dimensions = this.dimensions.get(connection.terminalId)
      if (!parsed.success || !dimensions) {
        this.protocolError(
          connection,
          'INVALID_MESSAGE',
          'Invalid controller request'
        )
        return
      }

      this.takeControl(
        connection,
        parsed.data.generation,
        dimensions.cols,
        dimensions.rows
      )
      return
    }

    if (event === 'input') {
      const parsed = terminalInputSchema.safeParse(value)
      if (
        !parsed.success ||
        Buffer.byteLength(parsed.data.data) > TERMINAL_MAX_INPUT_BYTES
      ) {
        this.protocolError(connection, 'INVALID_MESSAGE', 'Invalid input')
        return
      }

      if (!this.canControl(connection, parsed.data.generation)) {
        return
      }

      this.writeInput(
        connection,
        parsed.data.generation,
        parsed.data.data,
        Buffer.byteLength(parsed.data.data)
      )
      return
    }

    if (event === 'binary') {
      const parsed = terminalBinarySchema.safeParse(value)
      if (
        !parsed.success ||
        Buffer.byteLength(parsed.data.data, 'latin1') > TERMINAL_MAX_INPUT_BYTES
      ) {
        this.protocolError(
          connection,
          'INVALID_MESSAGE',
          'Invalid binary input'
        )
        return
      }

      if (!this.canControl(connection, parsed.data.generation)) {
        return
      }

      this.writeInput(
        connection,
        parsed.data.generation,
        Buffer.from(parsed.data.data, 'latin1'),
        Buffer.byteLength(parsed.data.data, 'latin1')
      )
      return
    }

    const parsed = terminalResizeSchema.safeParse(value)
    if (!parsed.success) {
      this.protocolError(connection, 'INVALID_MESSAGE', 'Invalid resize')
      return
    }

    if (this.canControl(connection, parsed.data.generation)) {
      this.resizeTerminal(connection, parsed.data.cols, parsed.data.rows)
    }
  }

  close(connectionId: string): void {
    const connection = this.clients.get(connectionId)
    if (!connection || connection.state === 'closed') {
      return
    }

    connection.state = 'closed'
    this.clients.delete(connectionId)
    if (connection.stallTimeout) {
      clearTimeout(connection.stallTimeout)
      connection.stallTimeout = null
    }

    this.releaseExitSubscription(connection)
    this.releaseDataSubscription(connection)
    this.releaseMetadataSubscription(connection)
    this.releasePty(connection)
    if (connection.lifecycleFiber) {
      Effect.runFork(Fiber.interrupt(connection.lifecycleFiber))
      connection.lifecycleFiber = null
    }

    const lease = this.controllers.get(connection.terminalId)
    if (lease?.connectionId === connection.id) {
      if (!connection.announcedReady) {
        if (lease.timer) {
          clearTimeout(lease.timer)
        }

        this.controllers.delete(connection.terminalId)
      } else {
        lease.connectionId = null
        lease.expiresAt = Date.now() + TERMINAL_CONTROLLER_GRACE_MS
        if (lease.timer) {
          clearTimeout(lease.timer)
        }

        lease.timer = setTimeout(
          () =>
            this.expireControllerLease(connection.terminalId, lease.clientId),
          TERMINAL_CONTROLLER_GRACE_MS
        )
        lease.timer.unref()
      }

      this.broadcastControl(connection.terminalId)
      this.publishControllerChanged(connection.terminalId, null)
    }
  }

  dispose(): void {
    for (const connection of [...this.clients.values()]) {
      connection.transport.disconnect(false)
      this.close(connection.id)
    }
    for (const lease of this.controllers.values()) {
      if (lease.timer) {
        clearTimeout(lease.timer)
      }
    }
    this.controllers.clear()
    this.dimensions.clear()
  }

  private initialize(
    connection: ClientConnection,
    cols: number,
    rows: number
  ): Effect.Effect<void, AttachmentInitializationError, Scope.Scope> {
    const isInitializing = () =>
      this.clients.get(connection.id) === connection &&
      connection.state === 'initializing' &&
      connection.transport.isConnected()
    const promisePhase = <Value>(
      phase: AttachmentInitializationPhase,
      evaluate: () => Promise<Value>
    ) =>
      Effect.tryPromise({
        try: evaluate,
        catch: (cause) => new AttachmentInitializationError(phase, cause)
      })

    return Effect.gen(this, function* () {
      const terminal = yield* promisePhase('refresh_terminal', () =>
        this.service.refreshTerminalStatus(connection.terminalId)
      )
      if (!isInitializing()) {
        return
      }

      if (terminal.status === 'missing') {
        return yield* Effect.fail(
          new AttachmentInitializationError(
            'refresh_terminal',
            new Error('The tmux session for this terminal is missing')
          )
        )
      }

      const worktree = yield* promisePhase('resolve_worktree', () =>
        this.service.getWorktree(terminal.worktreeId)
      )
      yield* Effect.all(
        [
          promisePhase('configure_server', () =>
            this.tmux.configureServer(worktree.tmuxSocketName)
          ),
          promisePhase('track_metadata', () =>
            this.metadata.trackTerminal(terminal, worktree)
          )
        ],
        { concurrency: 'unbounded' }
      )
      if (!isInitializing()) {
        return
      }

      const initialDimensions = yield* Effect.tryPromise({
        try: () =>
          this.enqueueTerminal(connection.terminalId, async () => {
            if (!isInitializing()) {
              return null
            }

            await this.tmux
              .useManualWindowSize(
                worktree.tmuxSocketName,
                terminal.tmuxSessionName
              )
              .catch((cause) => {
                throw new AttachmentInitializationError(
                  'configure_window_size',
                  cause
                )
              })
            if (!isInitializing()) {
              return null
            }

            const current = this.dimensions.get(connection.terminalId)
            if (current) {
              return current
            }

            const sessionSize = await this.tmux
              .sessionSize(worktree.tmuxSocketName, terminal.tmuxSessionName)
              .catch((cause) => {
                throw new AttachmentInitializationError(
                  'read_session_size',
                  cause
                )
              })
            if (!isInitializing()) {
              return null
            }

            let size
            if (sessionSize) {
              const parsed = terminalSizeSchema.safeParse(sessionSize)
              if (!parsed.success) {
                throw new AttachmentInitializationError(
                  'read_session_size',
                  new Error('tmux reported unsupported terminal dimensions')
                )
              }

              size = parsed.data
            } else {
              const parsed = terminalSizeSchema.safeParse({ cols, rows })
              if (!parsed.success) {
                throw new AttachmentInitializationError(
                  'resize_fallback',
                  new Error('Terminal fallback dimensions are invalid')
                )
              }

              size = parsed.data
              await this.tmux
                .resizeWindow(
                  worktree.tmuxSocketName,
                  terminal.tmuxSessionName,
                  size.cols,
                  size.rows
                )
                .catch((cause) => {
                  throw new AttachmentInitializationError(
                    'resize_fallback',
                    cause
                  )
                })
              if (!isInitializing()) {
                return null
              }
            }

            const initialized = {
              ...size,
              revision: 1,
              socketName: worktree.tmuxSocketName,
              sessionName: terminal.tmuxSessionName
            }
            this.dimensions.set(connection.terminalId, initialized)
            return initialized
          }),
        catch: (cause) =>
          cause instanceof AttachmentInitializationError
            ? cause
            : new AttachmentInitializationError('configure_window_size', cause)
      })
      if (!initialDimensions || !isInitializing()) {
        return
      }

      const clientPty = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const env = tmuxEnvironment()
            env.TERM = 'xterm-256color'
            const acquired = this.spawnPty(
              this.tmuxExecutable,
              this.tmux.attachArgs(
                worktree.tmuxSocketName,
                terminal.tmuxSessionName
              ),
              {
                name: 'xterm-256color',
                cols: initialDimensions.cols,
                rows: initialDimensions.rows,
                cwd: worktree.path,
                env
              }
            )
            connection.pty = acquired
            connection.streamId = crypto.randomUUID()
            return acquired
          },
          catch: (cause) =>
            new AttachmentInitializationError('spawn_pty', cause)
        }),
        () => Effect.sync(() => this.releasePty(connection))
      )
      yield* Effect.try({
        try: () => clientPty.pause(),
        catch: (cause) => new AttachmentInitializationError('pause_pty', cause)
      })
      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            connection.metadataUnsubscribe = this.metadata.subscribe(
              connection.terminalId,
              (metadata) => {
                if (connection.announcedReady && this.isActive(connection)) {
                  this.sendRuntimeMetadata(connection, metadata)
                }
              }
            )
            connection.historyUnsubscribe = this.metadata.subscribeHistory(
              connection.terminalId,
              (viewing) => {
                if (connection.announcedReady && this.isActive(connection)) {
                  this.send(connection, 'history', { viewing })
                }
              }
            )
          },
          catch: (cause) =>
            new AttachmentInitializationError('subscribe_metadata', cause)
        }),
        () => Effect.sync(() => this.releaseMetadataSubscription(connection))
      )
      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            connection.dataDisposable = clientPty.onData((data) =>
              this.sendOutput(connection, data)
            )
          },
          catch: (cause) =>
            new AttachmentInitializationError('subscribe_pty_data', cause)
        }),
        () => Effect.sync(() => this.releaseDataSubscription(connection))
      )
      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            connection.exitDisposable = clientPty.onExit(({ exitCode }) =>
              this.send(connection, 'exit', { exitCode })
            )
          },
          catch: (cause) =>
            new AttachmentInitializationError('subscribe_pty_exit', cause)
        }),
        () => Effect.sync(() => this.releaseExitSubscription(connection))
      )

      yield* Effect.tryPromise({
        try: () =>
          this.enqueueTerminal(connection.terminalId, () => {
            if (!isInitializing()) {
              return false
            }

            const dimensions = this.dimensions.get(connection.terminalId)
            if (!dimensions) {
              throw new AttachmentInitializationError(
                'announce_ready',
                new Error('Terminal dimensions are unavailable')
              )
            }

            if (
              dimensions.cols !== initialDimensions.cols ||
              dimensions.rows !== initialDimensions.rows
            ) {
              clientPty.resize(dimensions.cols, dimensions.rows)
            }

            this.claimController(connection)
            connection.state = 'ready'
            const lease = this.controllers.get(connection.terminalId)
            const ready = {
              connectionId: connection.id,
              streamId: connection.streamId!,
              generation: lease?.generation ?? 0,
              controller: this.isController(connection),
              reset: 'full' as const
            }
            if (
              !this.send(
                connection,
                'ready',
                connection.protocolVersion === TERMINAL_PROTOCOL_VERSION
                  ? {
                      ...ready,
                      cols: dimensions.cols,
                      rows: dimensions.rows,
                      revision: dimensions.revision
                    }
                  : ready
              )
            ) {
              return false
            }

            connection.announcedReady = true
            if (this.isController(connection)) {
              this.publishControllerChanged(
                connection.terminalId,
                connection.clientId
              )
            }

            if (
              !this.sendRuntimeMetadata(
                connection,
                this.metadata.get(connection.terminalId)
              ) ||
              !this.send(connection, 'history', {
                viewing: this.metadata.viewingHistory(connection.terminalId)
              }) ||
              !this.isActive(connection)
            ) {
              return false
            }

            clientPty.resume()
            this.broadcastControl(connection.terminalId)
            return true
          }),
        catch: (cause) =>
          cause instanceof AttachmentInitializationError
            ? cause
            : new AttachmentInitializationError('announce_ready', cause)
      })
      if (this.isActive(connection)) {
        yield* Effect.never
      }
    })
  }

  private releaseExitSubscription(connection: ClientConnection): void {
    const disposable = connection.exitDisposable
    connection.exitDisposable = null
    try {
      disposable?.dispose()
    } catch {
      // Subscription disposal is best-effort; continue releasing the PTY.
    }
  }

  private releaseDataSubscription(connection: ClientConnection): void {
    const disposable = connection.dataDisposable
    connection.dataDisposable = null
    try {
      disposable?.dispose()
    } catch {
      // Subscription disposal is best-effort; continue releasing the PTY.
    }
  }

  private releaseMetadataSubscription(connection: ClientConnection): void {
    const metadataUnsubscribe = connection.metadataUnsubscribe
    const historyUnsubscribe = connection.historyUnsubscribe
    connection.metadataUnsubscribe = null
    connection.historyUnsubscribe = null
    try {
      metadataUnsubscribe?.()
    } catch {
      // Metadata teardown must not prevent releasing the PTY.
    }
    try {
      historyUnsubscribe?.()
    } catch {
      // History teardown must not prevent releasing the PTY.
    }
  }

  private releasePty(connection: ClientConnection): void {
    const clientPty = connection.pty
    connection.pty = null
    if (!clientPty) {
      return
    }

    try {
      clientPty.kill()
    } catch {
      // The tmux client may already have exited.
    }
  }

  private sendRuntimeMetadata(
    connection: ClientConnection,
    metadata: TerminalRuntimeMetadata
  ): boolean {
    return (
      this.send(connection, 'title', { title: metadata.title ?? '' }) &&
      this.send(connection, 'progress', { progress: metadata.progress })
    )
  }

  private sendOutput(connection: ClientConnection, data: string): void {
    if (connection.state !== 'ready' || !connection.streamId || !data) {
      return
    }

    const sequence = connection.nextSequence++
    const bytes = Buffer.byteLength(data)
    connection.outputBytes.set(sequence, bytes)
    connection.unacknowledgedBytes += bytes
    if (
      !this.send(connection, 'output', {
        streamId: connection.streamId,
        sequence,
        data
      })
    ) {
      return
    }

    if (
      !connection.paused &&
      connection.unacknowledgedBytes >= TERMINAL_OUTPUT_HIGH_WATERMARK
    ) {
      connection.paused = true
      connection.pty?.pause()
      this.restartStallTimeout(connection)
    }
  }

  private acknowledgeOutput(
    connection: ClientConnection,
    streamId: string,
    sequence: number
  ): void {
    if (
      streamId !== connection.streamId ||
      sequence >= connection.nextSequence
    ) {
      this.protocolError(
        connection,
        'INVALID_ACK',
        'Invalid terminal output acknowledgement'
      )
      return
    }

    if (sequence <= connection.lastAckSequence) {
      return
    }

    for (
      let current = connection.lastAckSequence + 1;
      current <= sequence;
      current += 1
    ) {
      const bytes = connection.outputBytes.get(current)
      if (bytes !== undefined) {
        connection.unacknowledgedBytes = Math.max(
          0,
          connection.unacknowledgedBytes - bytes
        )
        connection.outputBytes.delete(current)
      }
    }
    connection.lastAckSequence = sequence
    if (
      connection.paused &&
      connection.unacknowledgedBytes <= TERMINAL_OUTPUT_LOW_WATERMARK
    ) {
      connection.paused = false
      if (connection.stallTimeout) {
        clearTimeout(connection.stallTimeout)
      }

      connection.stallTimeout = null
      connection.pty?.resume()
    } else if (connection.paused) {
      this.restartStallTimeout(connection)
    }
  }

  private restartStallTimeout(connection: ClientConnection): void {
    if (connection.stallTimeout) {
      clearTimeout(connection.stallTimeout)
    }

    connection.stallTimeout = setTimeout(() => {
      this.send(connection, 'terminal_error', {
        code: 'OUTPUT_STALLED',
        message: 'Terminal output stalled',
        retryable: true
      })
      connection.transport.disconnect(true)
      this.close(connection.id)
    }, TERMINAL_OUTPUT_STALL_TIMEOUT_MS)
    connection.stallTimeout.unref()
  }

  private enqueueTerminal<Result>(
    terminalId: string,
    operation: () => Promise<Result> | Result
  ): Promise<Result> {
    const result = (
      this.operationTails.get(terminalId) ?? Promise.resolve()
    ).then(operation)
    const tail = result.then(
      () => {
        if (this.operationTails.get(terminalId) === tail) {
          this.operationTails.delete(terminalId)
        }
      },
      () => {
        if (this.operationTails.get(terminalId) === tail) {
          this.operationTails.delete(terminalId)
        }
      }
    )
    this.operationTails.set(terminalId, tail)
    return result
  }

  private writeInput(
    connection: ClientConnection,
    generation: number,
    data: string | Buffer,
    bytes: number
  ): void {
    if (
      connection.queuedInputBytes + bytes > TERMINAL_MAX_QUEUED_INPUT_BYTES ||
      connection.queuedInputMessages + 1 > TERMINAL_MAX_QUEUED_INPUT_MESSAGES
    ) {
      this.protocolError(
        connection,
        'INPUT_QUEUE_FULL',
        'Terminal input queue is full'
      )
      return
    }

    connection.queuedInputBytes += bytes
    connection.queuedInputMessages += 1
    void this.enqueueTerminal(connection.terminalId, () => {
      connection.queuedInputBytes = Math.max(
        0,
        connection.queuedInputBytes - bytes
      )
      connection.queuedInputMessages = Math.max(
        0,
        connection.queuedInputMessages - 1
      )
      if (
        this.isActive(connection) &&
        this.canControl(connection, generation)
      ) {
        connection.pty?.write(data)
      }
    }).catch((error) => this.failInputWrite(connection, error))
  }

  private failInputWrite(connection: ClientConnection, error: unknown): void {
    if (!this.isActive(connection)) {
      return
    }

    this.send(connection, 'terminal_error', {
      code: 'INPUT_FAILED',
      message: errorMessage(error),
      retryable: true
    })
    connection.transport.disconnect(true)
    this.close(connection.id)
  }

  private resizeTerminal(
    connection: ClientConnection,
    cols: number,
    rows: number
  ): void {
    void this.enqueueTerminal(connection.terminalId, async () => {
      if (!this.isActive(connection) || !this.isController(connection)) {
        return
      }

      await this.applyDimensions(connection.terminalId, cols, rows)
    }).catch((error) => this.failDimensionChange(connection.terminalId, error))
  }

  private async applyDimensions(
    terminalId: string,
    cols: number,
    rows: number
  ): Promise<void> {
    const current = this.dimensions.get(terminalId)
    if (!current) {
      throw new Error('Terminal dimensions are unavailable')
    }

    if (current.cols === cols && current.rows === rows) {
      return
    }

    const next = { ...current, cols, rows, revision: current.revision + 1 }
    this.dimensions.set(terminalId, next)

    for (const client of [...this.clients.values()]) {
      if (
        client.terminalId === terminalId &&
        client.state === 'ready' &&
        client.paused
      ) {
        client.transport.disconnect(true)
        this.close(client.id)
      }
    }

    const active = [...this.clients.values()].filter(
      (client) => client.terminalId === terminalId && this.isActive(client)
    )
    for (const client of active) {
      if (client.protocolVersion === TERMINAL_PROTOCOL_VERSION) {
        this.send(client, 'dimensions', {
          cols: next.cols,
          rows: next.rows,
          revision: next.revision
        })
      }
    }
    for (const client of active) {
      if (this.isActive(client)) {
        client.pty?.resize(next.cols, next.rows)
      }
    }

    await this.tmux.resizeWindow(
      next.socketName,
      next.sessionName,
      next.cols,
      next.rows
    )
  }

  private failDimensionChange(terminalId: string, error: unknown): void {
    this.dimensions.delete(terminalId)
    for (const client of [...this.clients.values()]) {
      if (client.terminalId !== terminalId || !this.isActive(client)) {
        continue
      }

      this.send(client, 'terminal_error', {
        code: 'RESIZE_FAILED',
        message: errorMessage(error),
        retryable: true
      })
      client.transport.disconnect(true)
      this.close(client.id)
    }
  }

  private nextControllerGeneration(terminalId: string): number {
    const generation = (this.controllerGenerations.get(terminalId) ?? 0) + 1
    this.controllerGenerations.set(terminalId, generation)
    return generation
  }

  private claimController(connection: ClientConnection): void {
    const existing = this.controllers.get(connection.terminalId)
    if (existing && existing.expiresAt <= Date.now()) {
      if (existing.timer) {
        clearTimeout(existing.timer)
      }

      this.controllers.delete(connection.terminalId)
    }

    const lease = this.controllers.get(connection.terminalId)
    if (!lease) {
      this.controllers.set(connection.terminalId, {
        clientId: connection.clientId,
        connectionId: connection.id,
        generation: this.nextControllerGeneration(connection.terminalId),
        expiresAt: Number.POSITIVE_INFINITY,
        timer: null
      })
      return
    }

    if (lease.clientId !== connection.clientId) {
      return
    }

    const replaced = lease.connectionId
    lease.connectionId = connection.id
    lease.expiresAt = Number.POSITIVE_INFINITY
    if (lease.timer) {
      clearTimeout(lease.timer)
    }

    lease.timer = null
    if (replaced && replaced !== connection.id) {
      const old = this.clients.get(replaced)
      if (old) {
        old.transport.disconnect(false)
        this.close(old.id)
      }
    }
  }

  private takeControl(
    connection: ClientConnection,
    generation: number,
    cols: number,
    rows: number
  ): void {
    void this.enqueueTerminal(connection.terminalId, async () => {
      if (!this.isActive(connection)) {
        return
      }

      const previous = this.controllers.get(connection.terminalId)
      if (!previous || generation !== previous.generation) {
        this.sendControl(connection)
        return
      }

      if (previous.connectionId === connection.id) {
        await this.applyDimensions(connection.terminalId, cols, rows)
        return
      }

      if (connection.paused) {
        connection.transport.disconnect(true)
        this.close(connection.id)
        return
      }

      if (previous.timer) {
        clearTimeout(previous.timer)
      }

      this.controllers.set(connection.terminalId, {
        clientId: connection.clientId,
        connectionId: connection.id,
        generation: this.nextControllerGeneration(connection.terminalId),
        expiresAt: Number.POSITIVE_INFINITY,
        timer: null
      })
      await this.applyDimensions(connection.terminalId, cols, rows)
      if (!this.isActive(connection) || !this.isController(connection)) {
        return
      }

      this.broadcastControl(connection.terminalId)
      this.publishControllerChanged(connection.terminalId, connection.clientId)
    }).catch((error) => this.failDimensionChange(connection.terminalId, error))
  }

  private expireControllerLease(terminalId: string, clientId: string): void {
    const lease = this.controllers.get(terminalId)
    if (!lease || lease.clientId !== clientId || lease.connectionId) {
      return
    }

    const replacement = [...this.clients.values()].find(
      (client) => client.terminalId === terminalId && client.state === 'ready'
    )
    if (replacement) {
      lease.clientId = replacement.clientId
      lease.connectionId = replacement.id
      lease.generation = this.nextControllerGeneration(terminalId)
      lease.expiresAt = Number.POSITIVE_INFINITY
      lease.timer = null
    } else {
      this.controllers.delete(terminalId)
    }

    this.broadcastControl(terminalId)
    this.publishControllerChanged(terminalId, replacement?.clientId ?? null)
  }

  private canControl(
    connection: ClientConnection,
    generation: number
  ): boolean {
    const lease = this.controllers.get(connection.terminalId)
    return (
      lease?.connectionId === connection.id && lease.generation === generation
    )
  }

  private isController(connection: ClientConnection): boolean {
    return (
      this.controllers.get(connection.terminalId)?.connectionId ===
      connection.id
    )
  }

  private sendControl(connection: ClientConnection): boolean {
    const lease = this.controllers.get(connection.terminalId)
    return this.send(connection, 'control', {
      generation:
        lease?.generation ??
        this.controllerGenerations.get(connection.terminalId) ??
        0,
      controller: lease?.connectionId === connection.id
    })
  }

  private broadcastControl(terminalId: string): void {
    for (const client of this.clients.values()) {
      if (client.terminalId === terminalId && client.state === 'ready') {
        this.sendControl(client)
      }
    }
  }

  private isActive(connection: ClientConnection): boolean {
    return (
      this.clients.get(connection.id) === connection &&
      connection.state === 'ready' &&
      connection.transport.isConnected()
    )
  }

  private publishControllerChanged(
    terminalId: string,
    controllerId: string | null
  ): void {
    this.service.events.publish('terminal.controller_changed', {
      terminalId,
      controlled: controllerId !== null
    })
  }

  private protocolError(
    connection: ClientConnection,
    code: string,
    message: string
  ): void {
    this.send(connection, 'terminal_error', {
      code,
      message,
      retryable: false
    })
    connection.transport.disconnect(false)
    this.close(connection.id)
  }

  private send(
    connection: ClientConnection,
    event: TerminalServerEvent,
    payload: TerminalServerPayload
  ): boolean {
    if (!connection.transport.isConnected()) {
      this.close(connection.id)
      return false
    }

    const sent = connection.transport.send(event, payload)
    if (!sent) {
      this.close(connection.id)
    }

    return sent
  }
}
