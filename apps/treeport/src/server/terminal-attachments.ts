import crypto from 'node:crypto'
import {
  decodeUnknownOrNull,
  terminalBinarySchema,
  terminalInputSchema,
  terminalOutputAckSchema,
  terminalQueryAuthorityRequestSchema,
  terminalResizeSchema,
  terminalSizeSchema,
  terminalTakeControlSchema,
  TERMINAL_CONTROLLER_GRACE_MS,
  TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_OUTPUT_HIGH_WATERMARK,
  TERMINAL_OUTPUT_LOW_WATERMARK,
  TERMINAL_OUTPUT_MAX_UNACKNOWLEDGED_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalAuth,
  type TerminalClientEvent,
  type TerminalRuntimeMetadata,
  type TerminalProtocolInput,
  type TerminalServerEvent,
  type TerminalServerPayload
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import type { TreeportService } from './core/index'
import type { ApplicationServices } from './core/services/infrastructure/application-runtime'
import type { TerminalMetadataManager } from './terminal-metadata'
import type { TerminalAttachmentBackend } from './terminal-host-sessions'
import { networkTelemetry } from './network-telemetry'

type ConnectionState = 'initializing' | 'ready' | 'closed'
type TerminalProtocolVersion = typeof TERMINAL_PROTOCOL_VERSION

const TERMINAL_MAX_QUEUED_INPUT_BYTES = 1024 * 1024
const TERMINAL_MAX_QUEUED_INPUT_MESSAGES = 256
// The shared host cannot pause one viewer without pausing every viewer. Give a
// progressing browser time to drain, but retain a hard per-viewer byte limit.
const TERMINAL_OUTPUT_STALL_TIMEOUT_MS = 30_000

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
  streamId: string | null
  nextSequence: number
  lastAckSequence: number
  unacknowledgedBytes: number
  outputBytes: Map<number, { bytes: number; sentAt: number }>
  outputBacklogged: boolean
  outputStallTimeout: NodeJS.Timeout | null
  announcedReady: boolean
  metadataUnsubscribe: (() => void) | null
  directOutputUnsubscribe: (() => void) | null
  directRuntimeUnsubscribe: (() => void) | null
  queryAuthorityActive: boolean
  queryAuthorityGrantPending: boolean
  queryTransitionId: string | null
  pendingDirectOutput: Array<{ data: string; ownerSequence: number }>
  pendingDirectOutputBytes: number
  exitObserved: boolean
  pendingExitCode: number | null
  protocolVersion: TerminalProtocolVersion
  queuedInputBytes: number
  queuedInputMessages: number
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
}

function errorMessage(cause: unknown): string {
  const message = (
    cause instanceof Error ? cause.message : String(cause)
  ).trim()
  return (message || 'Terminal attachment failed').slice(0, 1_000)
}

export class TerminalAttachmentManager {
  private readonly clients = new Map<string, ClientConnection>()
  private readonly controllers = new Map<string, ControllerLease>()
  private readonly controllerGenerations = new Map<string, number>()
  private readonly dimensions = new Map<string, CanonicalTerminalDimensions>()

  constructor(
    private readonly service: TreeportService,
    private readonly metadata: TerminalMetadataManager,
    private readonly terminalHost: TerminalAttachmentBackend
  ) {}

  accept(
    auth: TerminalAuth,
    transport: TerminalTransport,
    protocolVersion: TerminalProtocolVersion = TERMINAL_PROTOCOL_VERSION
  ): Effect.Effect<string, never, ApplicationServices | Scope.Scope> {
    if (
      [...this.clients.values()].some(
        (connection) =>
          connection.terminalId === auth.terminalId &&
          connection.clientId === auth.clientId &&
          connection.state !== 'closed'
      )
    ) {
      networkTelemetry.reconnectNow('terminals')
    }

    const connection: ClientConnection = {
      id: transport.id,
      terminalId: auth.terminalId,
      transport,
      state: 'initializing',
      clientId: auth.clientId,
      streamId: null,
      nextSequence: 1,
      lastAckSequence: 0,
      unacknowledgedBytes: 0,
      outputBytes: new Map(),
      outputBacklogged: false,
      outputStallTimeout: null,
      announcedReady: false,
      metadataUnsubscribe: null,
      directOutputUnsubscribe: null,
      directRuntimeUnsubscribe: null,
      queryAuthorityActive: false,
      queryAuthorityGrantPending: false,
      queryTransitionId: null,
      pendingDirectOutput: [],
      pendingDirectOutputBytes: 0,
      exitObserved: false,
      pendingExitCode: null,
      protocolVersion,
      queuedInputBytes: 0,
      queuedInputMessages: 0
    }
    this.clients.set(connection.id, connection)

    return Effect.zipRight(
      Effect.annotateCurrentSpan({
        'treeport.connection.id': connection.id,
        'treeport.terminal.id': connection.terminalId,
        'treeport.client.id': connection.clientId
      }),
      Effect.forkScoped(
        this.service
          .terminalAttachmentMutation(
            connection.terminalId,
            this.initialize(connection, auth.cols, auth.rows)
          )
          .pipe(
            Effect.catchAll((cause) =>
              Effect.sync(() => {
                if (connection.state === 'closed') {
                  return
                }

                this.send(connection, 'terminal_error', {
                  code: 'ATTACH_FAILED',
                  message: errorMessage(cause),
                  retryable: false
                })
                connection.transport.disconnect(false)
                this.close(connection.id)
              })
            )
          )
      )
    ).pipe(Effect.as(connection.id))
  }

  message(
    connectionId: string,
    event: TerminalClientEvent,
    value: TerminalProtocolInput
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
      const parsed = decodeUnknownOrNull(terminalOutputAckSchema, value)
      if (!parsed) {
        this.protocolError(connection, 'INVALID_MESSAGE', 'Invalid output ACK')
        return
      }

      this.acknowledgeOutput(connection, parsed.streamId, parsed.sequence)
      return
    }

    if (event === 'take_control') {
      const parsed = decodeUnknownOrNull(terminalTakeControlSchema, value)
      if (!parsed) {
        this.protocolError(
          connection,
          'INVALID_MESSAGE',
          'Invalid controller request'
        )
        return
      }

      this.takeControl(connection, parsed.generation, parsed.cols, parsed.rows)
      return
    }

    if (event === 'query_authority') {
      const parsed = decodeUnknownOrNull(
        terminalQueryAuthorityRequestSchema,
        value
      )
      if (!parsed) {
        this.protocolError(
          connection,
          'INVALID_MESSAGE',
          'Invalid terminal query authority request'
        )
        return
      }

      this.changeQueryAuthority(
        connection,
        parsed.generation,
        parsed.transitionId
      )
      return
    }

    if (event === 'input') {
      const parsed = decodeUnknownOrNull(terminalInputSchema, value)
      if (
        !parsed ||
        Buffer.byteLength(parsed.data) > TERMINAL_MAX_INPUT_BYTES
      ) {
        this.protocolError(connection, 'INVALID_MESSAGE', 'Invalid input')
        return
      }

      if (!this.canControl(connection, parsed.generation)) {
        return
      }

      this.writeInput(
        connection,
        parsed.generation,
        parsed.data,
        Buffer.byteLength(parsed.data)
      )
      return
    }

    if (event === 'binary') {
      const parsed = decodeUnknownOrNull(terminalBinarySchema, value)
      if (
        !parsed ||
        Buffer.byteLength(parsed.data, 'latin1') > TERMINAL_MAX_INPUT_BYTES
      ) {
        this.protocolError(
          connection,
          'INVALID_MESSAGE',
          'Invalid binary input'
        )
        return
      }

      if (!this.canControl(connection, parsed.generation)) {
        return
      }

      this.writeInput(
        connection,
        parsed.generation,
        Buffer.from(parsed.data, 'latin1'),
        Buffer.byteLength(parsed.data, 'latin1')
      )
      return
    }

    const parsed = decodeUnknownOrNull(terminalResizeSchema, value)
    if (!parsed) {
      this.protocolError(connection, 'INVALID_MESSAGE', 'Invalid resize')
      return
    }

    if (this.canControl(connection, parsed.generation)) {
      this.resizeTerminal(connection, parsed.cols, parsed.rows)
    }
  }

  close(connectionId: string): void {
    const connection = this.clients.get(connectionId)
    if (!connection || connection.state === 'closed') {
      return
    }

    connection.state = 'closed'
    this.clients.delete(connectionId)
    if (connection.outputStallTimeout) {
      clearTimeout(connection.outputStallTimeout)
      connection.outputStallTimeout = null
    }

    this.releaseMetadataSubscription(connection)
    connection.directOutputUnsubscribe?.()
    connection.directRuntimeUnsubscribe?.()
    connection.directOutputUnsubscribe = null
    connection.directRuntimeUnsubscribe = null
    connection.pendingDirectOutput = []
    connection.pendingDirectOutputBytes = 0
    networkTelemetry.watermarkBytesNow('terminals', 'unacknowledged_output', 0)
    networkTelemetry.watermarkBytesNow('terminals', 'pending_output', 0)
    networkTelemetry.watermarkBytesNow('terminals', 'queued_input', 0)
    const restoreHostAuthority =
      connection.queryAuthorityActive || connection.queryTransitionId !== null
    connection.queryAuthorityActive = false
    connection.queryAuthorityGrantPending = false
    connection.queryTransitionId = null
    if (restoreHostAuthority) {
      this.enqueueTerminal(
        connection.terminalId,
        () => this.terminalHost.useHostQueryAuthority(connection.terminalId),
        (error) => {
          console.error(
            `[Treeport] Failed to restore terminal query authority for ${connection.terminalId}:`,
            error instanceof Error ? error.message : String(error)
          )
        }
      )
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
  ): Effect.Effect<void, unknown, ApplicationServices> {
    // Effect.gen's generator needs a stable manager receiver across callbacks.
    // eslint-disable-next-line typescript/no-this-alias
    const self = this
    const active = () =>
      self.clients.get(connection.id) === connection &&
      connection.state !== 'closed' &&
      connection.transport.isConnected()

    return Effect.gen(function* () {
      const terminal = yield* self.service.terminals.getTerminalForAttachment(
        connection.terminalId
      )
      if (!active()) {
        return
      }

      const worktree = yield* self.service.projects.getWorktree(
        terminal.worktreeId
      )
      if (!active()) {
        return
      }

      connection.streamId = crypto.randomUUID()
      connection.metadataUnsubscribe = self.metadata.subscribe(
        connection.terminalId,
        (value) => {
          if (connection.announcedReady && self.isActive(connection)) {
            self.sendRuntimeMetadata(connection, value)
          }
        }
      )
      yield* self.metadata
        .trackTerminal(terminal, worktree)
        .pipe(
          Effect.catchAll((error) =>
            Effect.logError(
              `Failed to initialize terminal metadata for ${terminal.id}`
            ).pipe(Effect.annotateLogs({ cause: String(error) }))
          )
        )
      connection.directRuntimeUnsubscribe = yield* Effect.tryPromise({
        try: async () =>
          self.terminalHost.subscribeRuntime(connection.terminalId, (event) => {
            if ('exitCode' in event) {
              connection.exitObserved = true
              connection.pendingExitCode = event.exitCode ?? null
              if (connection.announcedReady) {
                self.send(connection, 'exit', {
                  exitCode: connection.pendingExitCode
                })
              }
            }
          }),
        catch: (cause) => cause
      })
      const initial = yield* Effect.tryPromise({
        try: () =>
          self.terminalHost.attach(
            connection.terminalId,
            (data, ownerSequence) => {
              if (connection.state === 'initializing') {
                connection.pendingDirectOutputBytes += Buffer.byteLength(data)
                networkTelemetry.watermarkBytesNow(
                  'terminals',
                  'pending_output',
                  connection.pendingDirectOutputBytes
                )
                if (
                  connection.pendingDirectOutputBytes >=
                  TERMINAL_OUTPUT_MAX_UNACKNOWLEDGED_BYTES
                ) {
                  connection.transport.disconnect(true)
                  self.close(connection.id)
                  return
                }

                connection.pendingDirectOutput.push({ data, ownerSequence })
              } else {
                self.sendOutput(connection, data)
              }
            }
          ),
        catch: (cause) => cause
      })
      if (!active()) {
        initial?.unsubscribe()
        return
      }

      if (initial === null) {
        yield* self.service.terminals.refreshTerminalStatus(
          connection.terminalId,
          false
        )
        return yield* Effect.fail(new Error('Terminal is unavailable'))
      }

      connection.directOutputUnsubscribe = initial.unsubscribe
      const size = decodeUnknownOrNull(terminalSizeSchema, {
        cols: initial.cols || cols,
        rows: initial.rows || rows
      })
      if (!size) {
        return yield* Effect.fail(
          new Error('Terminal host returned invalid dimensions')
        )
      }

      const current = self.dimensions.get(connection.terminalId)
      const dimensions = current ?? {
        ...size,
        revision: 1
      }
      self.dimensions.set(connection.terminalId, dimensions)
      self.claimController(connection)
      connection.state = 'ready'
      const lease = self.controllers.get(connection.terminalId)
      if (
        !self.send(connection, 'ready', {
          connectionId: connection.id,
          streamId: connection.streamId!,
          generation: lease?.generation ?? 0,
          controller: self.isController(connection),
          reset: 'full',
          cols: dimensions.cols,
          rows: dimensions.rows,
          revision: dimensions.revision,
          snapshot: initial.data,
          snapshotLinks: initial.links
        })
      ) {
        return
      }

      connection.announcedReady = true
      if (connection.exitObserved) {
        self.send(connection, 'exit', {
          exitCode: connection.pendingExitCode
        })
      }

      if (self.isController(connection)) {
        self.publishControllerChanged(
          connection.terminalId,
          connection.clientId
        )
      }

      self.sendRuntimeMetadata(
        connection,
        self.metadata.get(connection.terminalId)
      )
      for (const output of connection.pendingDirectOutput.splice(0)) {
        if (output.ownerSequence > initial.fence) {
          self.sendOutput(connection, output.data)
        }
      }
      connection.pendingDirectOutputBytes = 0
      networkTelemetry.watermarkBytesNow('terminals', 'pending_output', 0)
      self.broadcastControl(connection.terminalId)
    })
  }

  private releaseMetadataSubscription(connection: ClientConnection): void {
    const metadataUnsubscribe = connection.metadataUnsubscribe
    connection.metadataUnsubscribe = null
    try {
      metadataUnsubscribe?.()
    } catch {
      // Metadata teardown must not interrupt attachment teardown.
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
    connection.outputBytes.set(sequence, { bytes, sentAt: Date.now() })
    connection.unacknowledgedBytes += bytes
    networkTelemetry.watermarkBytesNow(
      'terminals',
      'unacknowledged_output',
      connection.unacknowledgedBytes
    )
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
      connection.unacknowledgedBytes >= TERMINAL_OUTPUT_MAX_UNACKNOWLEDGED_BYTES
    ) {
      this.disconnectSlowViewer(connection)
      return
    }

    if (
      !connection.outputBacklogged &&
      connection.unacknowledgedBytes >= TERMINAL_OUTPUT_HIGH_WATERMARK
    ) {
      connection.outputBacklogged = true
      this.restartOutputStallTimeout(connection)
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
      const output = connection.outputBytes.get(current)
      if (output !== undefined) {
        connection.unacknowledgedBytes = Math.max(
          0,
          connection.unacknowledgedBytes - output.bytes
        )
        connection.outputBytes.delete(current)
        networkTelemetry.durationNow(
          'terminals',
          'ack_lag',
          Date.now() - output.sentAt
        )
      }
    }
    connection.lastAckSequence = sequence
    networkTelemetry.watermarkBytesNow(
      'terminals',
      'unacknowledged_output',
      connection.unacknowledgedBytes
    )
    if (
      connection.outputBacklogged &&
      connection.unacknowledgedBytes <= TERMINAL_OUTPUT_LOW_WATERMARK
    ) {
      connection.outputBacklogged = false
      if (connection.outputStallTimeout) {
        clearTimeout(connection.outputStallTimeout)
        connection.outputStallTimeout = null
      }
    } else if (connection.outputBacklogged) {
      this.restartOutputStallTimeout(connection)
    }
  }

  private restartOutputStallTimeout(connection: ClientConnection): void {
    if (connection.outputStallTimeout) {
      clearTimeout(connection.outputStallTimeout)
    }

    connection.outputStallTimeout = setTimeout(() => {
      connection.outputStallTimeout = null
      this.disconnectSlowViewer(connection)
    }, TERMINAL_OUTPUT_STALL_TIMEOUT_MS)
    connection.outputStallTimeout.unref()
  }

  private disconnectSlowViewer(connection: ClientConnection): void {
    if (!this.isActive(connection)) {
      return
    }

    this.send(connection, 'terminal_error', {
      code: 'OUTPUT_STALLED',
      message: 'Terminal viewer could not keep up with output',
      retryable: true
    })
    connection.transport.disconnect(true)
    this.close(connection.id)
  }

  private enqueueTerminal<Result>(
    terminalId: string,
    operation: () => Promise<Result> | Result,
    onError: (cause: unknown) => void
  ): void {
    this.service.forkApplicationEffect(
      this.service
        .terminalAttachmentMutation(
          terminalId,
          Effect.tryPromise({
            try: async () => operation(),
            catch: (cause) => cause
          })
        )
        .pipe(
          Effect.catchAll((cause) => Effect.sync(() => onError(cause))),
          Effect.asVoid
        )
    )
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
    networkTelemetry.watermarkBytesNow(
      'terminals',
      'queued_input',
      connection.queuedInputBytes
    )
    this.enqueueTerminal(
      connection.terminalId,
      async () => {
        connection.queuedInputBytes = Math.max(
          0,
          connection.queuedInputBytes - bytes
        )
        connection.queuedInputMessages = Math.max(
          0,
          connection.queuedInputMessages - 1
        )
        networkTelemetry.watermarkBytesNow(
          'terminals',
          'queued_input',
          connection.queuedInputBytes
        )
        if (
          this.isActive(connection) &&
          this.canControl(connection, generation) &&
          connection.queryAuthorityActive
        ) {
          await this.terminalHost.write(connection.terminalId, data, {
            attachmentId: connection.id,
            generation
          })
        }
      },
      (error) => this.failInputWrite(connection, error)
    )
  }

  private failInputWrite(connection: ClientConnection, cause: unknown): void {
    if (!this.isActive(connection)) {
      return
    }

    this.send(connection, 'terminal_error', {
      code: 'INPUT_FAILED',
      message: errorMessage(cause),
      retryable: true
    })
    connection.transport.disconnect(true)
    this.close(connection.id)
  }

  private changeQueryAuthority(
    connection: ClientConnection,
    generation: number,
    transitionId: string | null
  ): void {
    this.enqueueTerminal(
      connection.terminalId,
      async () => {
        if (
          !this.isActive(connection) ||
          !this.canControl(connection, generation)
        ) {
          return
        }

        if (transitionId === null) {
          if (connection.queryAuthorityActive) {
            this.send(connection, 'query_authority', {
              generation,
              transitionId: null,
              active: true
            })
            return
          }

          const otherAuthority = [...this.clients.values()].some(
            (client) =>
              client.terminalId === connection.terminalId &&
              (client.queryAuthorityActive || client.queryTransitionId !== null)
          )
          if (otherAuthority) {
            await this.revokeQueryAuthority(connection.terminalId)
          }

          const transition = await this.terminalHost.prepareQueryAuthority(
            connection.terminalId
          )
          if (
            !this.isActive(connection) ||
            !this.canControl(connection, generation)
          ) {
            await this.terminalHost.useHostQueryAuthority(connection.terminalId)
            return
          }

          connection.queryAuthorityGrantPending = false
          connection.queryTransitionId = transition.transitionId
          this.send(connection, 'query_authority', {
            generation,
            transitionId: transition.transitionId,
            active: false
          })
          return
        }

        if (connection.queryTransitionId !== transitionId) {
          return
        }

        if (!connection.queryAuthorityGrantPending) {
          connection.queryAuthorityGrantPending = true
          this.send(connection, 'query_authority', {
            generation,
            transitionId,
            active: true
          })
          return
        }

        await this.terminalHost.activateQueryAuthority(
          connection.terminalId,
          transitionId,
          connection.id,
          generation
        )
        if (
          !this.isActive(connection) ||
          !this.canControl(connection, generation)
        ) {
          await this.terminalHost.useHostQueryAuthority(connection.terminalId)
          return
        }

        connection.queryTransitionId = null
        connection.queryAuthorityGrantPending = false
        connection.queryAuthorityActive = true
        this.send(connection, 'query_authority', {
          generation,
          transitionId: null,
          active: true
        })
      },
      (error) => this.failInputWrite(connection, error)
    )
  }

  private async revokeQueryAuthority(terminalId: string): Promise<void> {
    await this.terminalHost.useHostQueryAuthority(terminalId)
    for (const client of this.clients.values()) {
      if (
        client.terminalId !== terminalId ||
        (!client.queryAuthorityActive && client.queryTransitionId === null)
      ) {
        continue
      }

      client.queryAuthorityActive = false
      client.queryAuthorityGrantPending = false
      client.queryTransitionId = null
      if (this.isActive(client)) {
        const lease = this.controllers.get(terminalId)
        this.send(client, 'query_authority', {
          generation: lease?.generation ?? 0,
          transitionId: null,
          active: false
        })
      }
    }
  }

  private resizeTerminal(
    connection: ClientConnection,
    cols: number,
    rows: number
  ): void {
    this.enqueueTerminal(
      connection.terminalId,
      async () => {
        if (!this.isActive(connection) || !this.isController(connection)) {
          return
        }

        await this.applyDimensions(connection.terminalId, cols, rows)
      },
      (error) => this.failDimensionChange(connection.terminalId, error)
    )
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

    const active = [...this.clients.values()].filter(
      (client) => client.terminalId === terminalId && this.isActive(client)
    )
    for (const client of active) {
      this.send(client, 'dimensions', {
        cols: next.cols,
        rows: next.rows,
        revision: next.revision
      })
    }
    await this.terminalHost.resize(terminalId, next.cols, next.rows)
  }

  private failDimensionChange(terminalId: string, cause: unknown): void {
    this.dimensions.delete(terminalId)
    for (const client of [...this.clients.values()]) {
      if (client.terminalId !== terminalId || !this.isActive(client)) {
        continue
      }

      this.send(client, 'terminal_error', {
        code: 'RESIZE_FAILED',
        message: errorMessage(cause),
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
    this.enqueueTerminal(
      connection.terminalId,
      async () => {
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

        if (previous.timer) {
          clearTimeout(previous.timer)
        }

        await this.revokeQueryAuthority(connection.terminalId)
        if (!this.isActive(connection)) {
          return
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
        this.publishControllerChanged(
          connection.terminalId,
          connection.clientId
        )
      },
      (error) => this.failDimensionChange(connection.terminalId, error)
    )
  }

  private expireControllerLease(terminalId: string, clientId: string): void {
    this.enqueueTerminal(
      terminalId,
      async () => {
        const lease = this.controllers.get(terminalId)
        if (!lease || lease.clientId !== clientId || lease.connectionId) {
          return
        }

        const replacement = [...this.clients.values()].find(
          (client) =>
            client.terminalId === terminalId && client.state === 'ready'
        )
        await this.revokeQueryAuthority(terminalId)
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
      },
      (error) => this.failDimensionChange(terminalId, error)
    )
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
