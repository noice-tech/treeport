import crypto from 'node:crypto'
import type { IDisposable, IPty } from 'node-pty'
import * as pty from 'node-pty'
import {
  terminalBinarySchema,
  terminalInputSchema,
  terminalOutputAckSchema,
  terminalResizeSchema,
  terminalTakeControlSchema,
  TERMINAL_CONTROLLER_GRACE_MS,
  TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_OUTPUT_HIGH_WATERMARK,
  TERMINAL_OUTPUT_LOW_WATERMARK,
  TERMINAL_OUTPUT_STALL_TIMEOUT_MS,
  type TerminalAuth,
  type TerminalClientEvent,
  type TerminalRuntimeMetadata,
  type TerminalServerEvent,
  type TerminalServerPayload
} from '@tasktty/shared'
import type { TaskTTYService, TmuxAdapter } from '@tasktty/core'
import { resolveExecutablePath } from '@tasktty/core'
import type { TerminalMetadataManager } from './terminal-metadata.js'

type PtySpawner = typeof pty.spawn
type ConnectionState = 'initializing' | 'ready' | 'closed'

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
}

interface ControllerLease {
  clientId: string
  connectionId: string | null
  generation: number
  expiresAt: number
  timer: NodeJS.Timeout | null
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
  private readonly tmuxExecutable: string

  constructor(
    private readonly service: TaskTTYService,
    private readonly tmux: TmuxAdapter,
    tmuxExecutable: string,
    private readonly metadata: TerminalMetadataManager,
    private readonly spawnPty: PtySpawner = pty.spawn
  ) {
    this.tmuxExecutable = resolveExecutablePath(tmuxExecutable)
  }

  accept(auth: TerminalAuth, transport: TerminalTransport): string {
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
      metadataUnsubscribe: null
    }
    this.clients.set(connection.id, connection)
    void this.initialize(connection, auth.cols, auth.rows)
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
      const parsed = terminalTakeControlSchema.safeParse(value)
      if (!parsed.success) {
        this.protocolError(
          connection,
          'INVALID_MESSAGE',
          'Invalid controller request'
        )
        return
      }

      this.takeControl(connection, parsed.data.generation)
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

      if (this.canControl(connection, parsed.data.generation)) {
        connection.pty?.write(parsed.data.data)
      }

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

      if (this.canControl(connection, parsed.data.generation)) {
        connection.pty?.write(Buffer.from(parsed.data.data, 'latin1'))
      }

      return
    }

    const parsed = terminalResizeSchema.safeParse(value)
    if (!parsed.success) {
      this.protocolError(connection, 'INVALID_MESSAGE', 'Invalid resize')
      return
    }

    if (this.canControl(connection, parsed.data.generation)) {
      connection.pty?.resize(parsed.data.cols, parsed.data.rows)
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
    }

    connection.dataDisposable?.dispose()
    connection.exitDisposable?.dispose()
    connection.metadataUnsubscribe?.()
    connection.metadataUnsubscribe = null
    try {
      connection.pty?.kill()
    } catch {
      // The tmux client may already have exited.
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
  }

  private async initialize(
    connection: ClientConnection,
    cols: number,
    rows: number
  ): Promise<void> {
    try {
      const terminal = await this.service.refreshTerminalStatus(
        connection.terminalId
      )
      if (terminal.status === 'missing') {
        throw new Error('The tmux session for this terminal is missing')
      }

      const worktree = this.service.getWorktree(terminal.worktreeId)
      await this.tmux.configureServer(worktree.tmuxSocketName)
      const [sessionSize] = await Promise.all([
        this.tmux.sessionSize(
          worktree.tmuxSocketName,
          terminal.tmuxSessionName
        ),
        this.metadata.trackTerminal(terminal, worktree)
      ])
      if (connection.state === 'closed') {
        return
      }

      const size = sessionSize ?? { cols, rows }
      const env = tmuxEnvironment()
      env.TERM = 'xterm-256color'
      const clientPty = this.spawnPty(
        this.tmuxExecutable,
        this.tmux.attachArgs(worktree.tmuxSocketName, terminal.tmuxSessionName),
        {
          name: 'xterm-256color',
          cols: size.cols,
          rows: size.rows,
          cwd: worktree.path,
          env
        }
      )
      connection.pty = clientPty
      connection.streamId = crypto.randomUUID()
      connection.metadataUnsubscribe = this.metadata.subscribe(
        connection.terminalId,
        (metadata) => {
          if (connection.announcedReady && this.isActive(connection)) {
            this.sendRuntimeMetadata(connection, metadata)
          }
        }
      )
      clientPty.pause()
      connection.dataDisposable = clientPty.onData((data) =>
        this.sendOutput(connection, data)
      )
      connection.exitDisposable = clientPty.onExit(({ exitCode }) =>
        this.send(connection, 'exit', { exitCode })
      )
      this.claimController(connection)
      connection.state = 'ready'
      const lease = this.controllers.get(connection.terminalId)
      if (
        !this.send(connection, 'ready', {
          connectionId: connection.id,
          streamId: connection.streamId,
          generation: lease?.generation ?? 0,
          controller: this.isController(connection),
          reset: 'full'
        })
      ) {
        return
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
        )
      ) {
        return
      }

      if (!this.isActive(connection)) {
        return
      }

      clientPty.resume()
      this.broadcastControl(connection.terminalId)
    } catch (error) {
      if (connection.state === 'closed') {
        return
      }

      this.send(connection, 'terminal_error', {
        code: 'ATTACH_FAILED',
        message: errorMessage(error),
        retryable: false
      })
      connection.transport.disconnect(false)
      this.close(connection.id)
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

  private takeControl(connection: ClientConnection, generation: number): void {
    const previous = this.controllers.get(connection.terminalId)
    if (!previous || generation !== previous.generation) {
      this.sendControl(connection)
      return
    }

    if (previous.connectionId === connection.id) {
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
    this.broadcastControl(connection.terminalId)
    this.publishControllerChanged(connection.terminalId, connection.clientId)
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
