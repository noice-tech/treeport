import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { Socket } from 'node:net'
import * as EffectSocket from '@effect/platform/Socket'
import * as NodeSocket from '@effect/platform-node/NodeSocket'
import * as NodeSocketServer from '@effect/platform-node/NodeSocketServer'
import * as Cause from 'effect/Cause'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as Tracer from 'effect/Tracer'
import type { TerminalCreateInput } from './core/terminal'
import type { TerminalHostSessions } from './terminal-host-sessions'
import {
  decodeTerminalHostInput,
  decodeTerminalHostRecord,
  encodeTerminalHostFrame,
  makeTerminalHostFrameDecoder,
  TERMINAL_HOST_PROTOCOL_VERSION,
  type TerminalHostEventFrame,
  type TerminalHostRecord,
  type TerminalHostRequestFrame,
  type TerminalHostResponseFrame,
  type TerminalHostResults
} from './terminal-host-protocol'

const TERMINAL_HOST_EVENT_HIGH_WATERMARK = 4 * 1024 * 1024
const TERMINAL_HOST_EVENT_LOW_WATERMARK = 1024 * 1024
const TERMINAL_HOST_MAX_QUEUED_EVENT_BYTES = 16 * 1024 * 1024

export interface TerminalHostServerOptions {
  readonly hostId: string
  readonly hostKey: string
  readonly token: string
  readonly socketPath: string
  readonly recordPath: string
  readonly sessions: TerminalHostSessions
  readonly pid?: number
  readonly startedAt?: string
}

export interface TerminalHostServerHandle {
  readonly record: TerminalHostRecord
  readonly shutdown: Effect.Effect<void>
}

export class TerminalHostServerError extends Data.TaggedError(
  'TerminalHostServerError'
)<{ readonly message: string; readonly cause?: unknown }> {}

interface AdmittedRequest {
  readonly frame: TerminalHostRequestFrame
  readonly admittedAt: number
}

interface OutboundFrame {
  readonly encoded: Buffer
  readonly queuedEventBytes: number
  readonly completion: Deferred.Deferred<void> | null
}

interface HostConnection {
  readonly socket: Socket
  authenticated: boolean
  readonly outputScopes: Map<string, Scope.CloseableScope>
  readonly runtimeScopes: Map<string, Scope.CloseableScope>
  readonly outputPauseScopes: Map<string, Scope.CloseableScope>
  readonly requests: Queue.Queue<AdmittedRequest>
  readonly outgoing: Queue.Queue<OutboundFrame>
  queuedEventBytes: number
}

function serverError(cause: unknown): TerminalHostServerError {
  return new TerminalHostServerError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause
  })
}

function nodePromise<A>(evaluate: () => Promise<A>) {
  return Effect.tryPromise({ try: evaluate, catch: serverError })
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

/** Acquires the detached host listener and owns it for the caller's scope. */
export function makeTerminalHostServer(
  options: TerminalHostServerOptions
): Effect.Effect<
  TerminalHostServerHandle,
  TerminalHostServerError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    yield* options.sessions.initialize().pipe(Effect.mapError(serverError))
    const record: TerminalHostRecord = {
      protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
      hostId: options.hostId,
      hostKey: options.hostKey,
      pid: options.pid ?? process.pid,
      socketPath: options.socketPath,
      startedAt: options.startedAt ?? new Date().toISOString()
    }
    const shuttingDown = yield* Ref.make(false)
    const shutdown = yield* Deferred.make<void>()
    const temporaryRecordPath = `${options.recordPath}.${process.pid}.tmp`

    const socketServer = yield* NodeSocketServer.make({
      path: options.socketPath
    }).pipe(Effect.mapError(serverError))
    yield* nodePromise(() => fs.chmod(options.socketPath, 0o600))
    yield* nodePromise(() =>
      fs.writeFile(temporaryRecordPath, `${JSON.stringify(record)}\n`, {
        mode: 0o600
      })
    )
    yield* nodePromise(() => fs.rename(temporaryRecordPath, options.recordPath))

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const ownsRecord = yield* nodePromise<unknown>(async () => {
          const value = await fs.readFile(options.recordPath, 'utf8')
          return JSON.parse(value)
        }).pipe(
          Effect.flatMap(decodeTerminalHostRecord),
          Effect.map((current) => current.hostId === options.hostId),
          Effect.catchAll(() => Effect.succeed(false))
        )
        if (ownsRecord) {
          yield* Effect.all(
            [
              nodePromise(() => fs.rm(options.recordPath, { force: true })),
              nodePromise(() => fs.rm(options.socketPath, { force: true }))
            ],
            { discard: true }
          ).pipe(Effect.catchAll(() => Effect.void))
        }

        yield* nodePromise(() =>
          fs.rm(temporaryRecordPath, { force: true })
        ).pipe(Effect.catchAll(() => Effect.void))
      })
    )

    const runConnection = (
      socket: EffectSocket.Socket
    ): Effect.Effect<void, never, NodeSocket.NetSocket> =>
      Effect.scoped(
        Effect.gen(function* () {
          const netSocket = yield* NodeSocket.NetSocket
          netSocket.setNoDelay(true)
          const requests = yield* Effect.acquireRelease(
            Queue.bounded<AdmittedRequest>(1024),
            Queue.shutdown
          )
          const outgoing = yield* Effect.acquireRelease(
            Queue.unbounded<OutboundFrame>(),
            Queue.shutdown
          )
          const connection: HostConnection = {
            socket: netSocket,
            authenticated: false,
            outputScopes: new Map(),
            runtimeScopes: new Map(),
            outputPauseScopes: new Map(),
            requests,
            outgoing,
            queuedEventBytes: 0
          }

          const closeSubscription = (
            subscriptions: Map<string, Scope.CloseableScope>,
            terminalId: string
          ) => {
            const scope = subscriptions.get(terminalId)
            subscriptions.delete(terminalId)
            return scope ? Scope.close(scope, Exit.void) : Effect.void
          }
          const closeSubscriptions = (
            subscriptions: Map<string, Scope.CloseableScope>
          ) =>
            Effect.forEach(subscriptions.values(), (scope) =>
              Scope.close(scope, Exit.void)
            ).pipe(
              Effect.ensuring(Effect.sync(() => subscriptions.clear())),
              Effect.asVoid
            )

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              connection.queuedEventBytes = 0
              yield* closeSubscriptions(connection.outputScopes)
              yield* closeSubscriptions(connection.runtimeScopes)
              yield* closeSubscriptions(connection.outputPauseScopes)
              if (connection.authenticated) {
                yield* options.sessions
                  .restoreHostQueryAuthority()
                  .pipe(
                    Effect.catchAll((cause) =>
                      Effect.logError(
                        'Failed to restore terminal query authority after disconnect'
                      ).pipe(
                        Effect.annotateLogs({ cause: errorMessage(cause) })
                      )
                    )
                  )
              }

              netSocket.destroy()
            })
          )

          const enqueueResponse = (frame: TerminalHostResponseFrame) =>
            Effect.gen(function* () {
              const completion = yield* Deferred.make<void>()
              const encoded = yield* encodeTerminalHostFrame(frame).pipe(
                Effect.mapError(serverError)
              )
              const offered = yield* Queue.offer(outgoing, {
                encoded,
                queuedEventBytes: 0,
                completion
              })
              if (!offered) {
                return yield* Effect.interrupt
              }

              yield* Deferred.await(completion)
            })

          const respond = <Method extends keyof TerminalHostResults>(
            id: string,
            result: TerminalHostResults[Method]
          ) =>
            enqueueResponse({
              protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
              type: 'response',
              id,
              result,
              error: null
            })

          const fail = (
            id: string,
            code: string,
            message: string,
            details: Pick<
              NonNullable<TerminalHostResponseFrame['error']>,
              'hostProtocolVersion' | 'liveSessionCount'
            > = {}
          ) =>
            enqueueResponse({
              protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
              type: 'response',
              id,
              result: null,
              error: { code, message, ...details }
            })

          const sendEvent = (
            frame: TerminalHostEventFrame
          ): Effect.Effect<void, TerminalHostServerError> =>
            Effect.gen(function* () {
              if (connection.socket.destroyed) {
                return
              }

              const encoded = yield* encodeTerminalHostFrame(frame).pipe(
                Effect.mapError(serverError)
              )
              if (
                connection.queuedEventBytes + encoded.byteLength >
                TERMINAL_HOST_MAX_QUEUED_EVENT_BYTES
              ) {
                connection.socket.destroy()
                return yield* Effect.fail(
                  new TerminalHostServerError({
                    message: 'Terminal host event queue exceeded its hard limit'
                  })
                )
              }

              connection.queuedEventBytes += encoded.byteLength
              const offered = yield* Queue.offer(outgoing, {
                encoded,
                queuedEventBytes: encoded.byteLength,
                completion: null
              })
              if (!offered) {
                connection.queuedEventBytes = Math.max(
                  0,
                  connection.queuedEventBytes - encoded.byteLength
                )
                return yield* Effect.interrupt
              }

              if (
                frame.event === 'output' &&
                connection.queuedEventBytes >=
                  TERMINAL_HOST_EVENT_HIGH_WATERMARK &&
                !connection.outputPauseScopes.has(frame.data.terminalId)
              ) {
                const pauseScope = yield* Scope.make()
                const paused = yield* Scope.extend(
                  options.sessions.pauseOutput(frame.data.terminalId),
                  pauseScope
                )
                if (paused) {
                  connection.outputPauseScopes.set(
                    frame.data.terminalId,
                    pauseScope
                  )
                } else {
                  yield* Scope.close(pauseScope, Exit.void)
                }
              }
            })

          const installOutput = (terminalId: string) =>
            Effect.gen(function* () {
              yield* closeSubscription(connection.outputScopes, terminalId)
              const scope = yield* Scope.make()
              const attachment = yield* Scope.extend(
                options.sessions.attach(terminalId),
                scope
              )
              if (!attachment) {
                yield* Scope.close(scope, Exit.void)
                return null
              }

              yield* Effect.forkIn(
                Stream.runForEach(attachment.output, ({ data, sequence }) =>
                  sendEvent({
                    protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
                    type: 'event',
                    event: 'output',
                    data: { terminalId, output: data, sequence }
                  })
                ).pipe(Effect.orDie),
                scope
              )
              connection.outputScopes.set(terminalId, scope)
              const { output: _output, ...snapshot } = attachment
              return snapshot
            })

          const installRuntime = (terminalId: string) =>
            Effect.gen(function* () {
              yield* closeSubscription(connection.runtimeScopes, terminalId)
              const scope = yield* Scope.make()
              yield* Effect.forkIn(
                Stream.runForEach(
                  options.sessions.runtimeEvents(terminalId),
                  (value) =>
                    sendEvent({
                      protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
                      type: 'event',
                      event: 'runtime',
                      data: { terminalId, value }
                    })
                ).pipe(Effect.orDie),
                scope
              )
              connection.runtimeScopes.set(terminalId, scope)
            })

          const handleRequest = (frame: TerminalHostRequestFrame) =>
            Effect.gen(function* () {
              if (frame.protocolVersion !== TERMINAL_HOST_PROTOCOL_VERSION) {
                const liveSessionCount = yield* options.sessions.sessionCount
                yield* fail(
                  frame.id,
                  'INCOMPATIBLE_PROTOCOL',
                  `Terminal host protocol ${TERMINAL_HOST_PROTOCOL_VERSION} is not compatible with daemon protocol ${frame.protocolVersion}`,
                  {
                    hostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
                    liveSessionCount
                  }
                )
                return
              }

              if (!connection.authenticated) {
                if (frame.method !== 'handshake') {
                  yield* fail(
                    frame.id,
                    'AUTH_REQUIRED',
                    'Handshake is required'
                  )
                  connection.socket.destroy()
                  return
                }

                const input = yield* decodeTerminalHostInput(
                  'handshake',
                  frame.input
                )
                if (!tokensMatch(input.token, options.token)) {
                  yield* fail(frame.id, 'AUTH_FAILED', 'Authentication failed')
                  connection.socket.destroy()
                  return
                }

                if (input.hostKey !== options.hostKey) {
                  yield* fail(
                    frame.id,
                    'HOST_MISMATCH',
                    'Terminal host key differs'
                  )
                  connection.socket.destroy()
                  return
                }

                if (input.protocolVersion !== TERMINAL_HOST_PROTOCOL_VERSION) {
                  const liveSessionCount = yield* options.sessions.sessionCount
                  yield* fail(
                    frame.id,
                    'INCOMPATIBLE_PROTOCOL',
                    `Terminal host protocol ${TERMINAL_HOST_PROTOCOL_VERSION} is not compatible with daemon protocol ${input.protocolVersion}`,
                    {
                      hostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
                      liveSessionCount
                    }
                  )
                  return
                }

                connection.authenticated = true
                yield* respond<'handshake'>(frame.id, {
                  ...record,
                  liveSessionCount: yield* options.sessions.sessionCount,
                  traceContext: true
                })
                return
              }

              if (yield* Ref.get(shuttingDown)) {
                yield* fail(
                  frame.id,
                  'HOST_SHUTTING_DOWN',
                  'The terminal host is shutting down'
                )
                return
              }

              switch (frame.method) {
                case 'handshake':
                  yield* fail(
                    frame.id,
                    'ALREADY_AUTHENTICATED',
                    'Handshake is complete'
                  )
                  return
                case 'create': {
                  const input = yield* decodeTerminalHostInput(
                    'create',
                    frame.input
                  )
                  const createInput: TerminalCreateInput = {
                    terminalId: input.terminalId,
                    worktreeId: input.worktreeId,
                    name: input.name,
                    createdAt: input.createdAt,
                    cwd: input.cwd,
                    argv: [...input.argv],
                    shellCommand: input.shellCommand,
                    interactiveShell: input.interactiveShell,
                    env: { ...input.env }
                  }

                  if (input.initialTitle !== undefined) {
                    createInput.initialTitle = input.initialTitle
                  }

                  if (input.fallbackArgv !== undefined) {
                    createInput.fallbackArgv = [...input.fallbackArgv]
                  }

                  if (input.closeOnSuccess !== undefined) {
                    createInput.closeOnSuccess = input.closeOnSuccess
                  }

                  if (input.initialSize !== undefined) {
                    createInput.initialSize = { ...input.initialSize }
                  }

                  if (input.setupTasks !== undefined) {
                    createInput.setupTasks = input.setupTasks.map((task) => ({
                      ...task,
                      argv: [...task.argv],
                      env: { ...task.env }
                    }))
                  }

                  if (input.setupError !== undefined) {
                    createInput.setupError = input.setupError
                  }

                  yield* options.sessions.createTerminal(createInput)
                  yield* respond<'create'>(frame.id, null)
                  return
                }
                case 'inventory': {
                  const input = yield* decodeTerminalHostInput(
                    'inventory',
                    frame.input
                  )
                  yield* respond<'inventory'>(
                    frame.id,
                    yield* options.sessions.listTerminals(input.worktreeId)
                  )
                  return
                }
                case 'state': {
                  const input = yield* decodeTerminalHostInput(
                    'state',
                    frame.input
                  )
                  yield* respond<'state'>(
                    frame.id,
                    yield* options.sessions.terminalState(input.terminalId)
                  )
                  return
                }
                case 'attach': {
                  const input = yield* decodeTerminalHostInput(
                    'attach',
                    frame.input
                  )
                  yield* respond<'attach'>(
                    frame.id,
                    yield* installOutput(input.terminalId)
                  )
                  return
                }
                case 'unsubscribeOutput': {
                  const input = yield* decodeTerminalHostInput(
                    'unsubscribeOutput',
                    frame.input
                  )
                  yield* closeSubscription(
                    connection.outputScopes,
                    input.terminalId
                  )
                  yield* respond<'unsubscribeOutput'>(frame.id, null)
                  return
                }
                case 'subscribeRuntime': {
                  const input = yield* decodeTerminalHostInput(
                    'subscribeRuntime',
                    frame.input
                  )
                  yield* installRuntime(input.terminalId)
                  yield* respond<'subscribeRuntime'>(frame.id, null)
                  return
                }
                case 'unsubscribeRuntime': {
                  const input = yield* decodeTerminalHostInput(
                    'unsubscribeRuntime',
                    frame.input
                  )
                  yield* closeSubscription(
                    connection.runtimeScopes,
                    input.terminalId
                  )
                  yield* respond<'unsubscribeRuntime'>(frame.id, null)
                  return
                }
                case 'runtimeState': {
                  const input = yield* decodeTerminalHostInput(
                    'runtimeState',
                    frame.input
                  )
                  yield* respond<'runtimeState'>(
                    frame.id,
                    yield* options.sessions.runtimeState(input.terminalId)
                  )
                  return
                }
                case 'write': {
                  const input = yield* decodeTerminalHostInput(
                    'write',
                    frame.input
                  )
                  yield* options.sessions.write(
                    input.terminalId,
                    input.encoding === 'base64'
                      ? Buffer.from(input.data, 'base64')
                      : input.data,
                    input.authority
                  )
                  yield* respond<'write'>(frame.id, null)
                  return
                }
                case 'prepareQueryAuthority': {
                  const input = yield* decodeTerminalHostInput(
                    'prepareQueryAuthority',
                    frame.input
                  )
                  yield* respond<'prepareQueryAuthority'>(
                    frame.id,
                    yield* options.sessions.prepareQueryAuthority(
                      input.terminalId
                    )
                  )
                  return
                }
                case 'activateQueryAuthority': {
                  const input = yield* decodeTerminalHostInput(
                    'activateQueryAuthority',
                    frame.input
                  )
                  yield* options.sessions.activateQueryAuthority(
                    input.terminalId,
                    input.transitionId,
                    input.attachmentId,
                    input.generation,
                    input.cellSize
                  )
                  yield* respond<'activateQueryAuthority'>(frame.id, null)
                  return
                }
                case 'hostQueryAuthority': {
                  const input = yield* decodeTerminalHostInput(
                    'hostQueryAuthority',
                    frame.input
                  )
                  yield* options.sessions.useHostQueryAuthority(
                    input.terminalId
                  )
                  yield* respond<'hostQueryAuthority'>(frame.id, null)
                  return
                }
                case 'resize': {
                  const input = yield* decodeTerminalHostInput(
                    'resize',
                    frame.input
                  )
                  yield* options.sessions.resize(
                    input.terminalId,
                    input.cols,
                    input.rows
                  )
                  yield* respond<'resize'>(frame.id, null)
                  return
                }
                case 'capture': {
                  const input = yield* decodeTerminalHostInput(
                    'capture',
                    frame.input
                  )
                  yield* respond<'capture'>(
                    frame.id,
                    yield* options.sessions.captureTerminal(
                      input.terminalId,
                      input.lines
                    )
                  )
                  return
                }
                case 'rename': {
                  const input = yield* decodeTerminalHostInput(
                    'rename',
                    frame.input
                  )
                  yield* options.sessions.renameTerminal(
                    input.terminalId,
                    input.name,
                    input.updatedAt
                  )
                  yield* respond<'rename'>(frame.id, null)
                  return
                }
                case 'processes': {
                  const input = yield* decodeTerminalHostInput(
                    'processes',
                    frame.input
                  )
                  yield* respond<'processes'>(
                    frame.id,
                    yield* options.sessions.listProcesses(input.worktreeId)
                  )
                  return
                }
                case 'titleState': {
                  const input = yield* decodeTerminalHostInput(
                    'titleState',
                    frame.input
                  )
                  yield* respond<'titleState'>(
                    frame.id,
                    yield* options.sessions.terminalTitleState(input.terminalId)
                  )
                  return
                }
                case 'signal': {
                  const input = yield* decodeTerminalHostInput(
                    'signal',
                    frame.input
                  )
                  yield* options.sessions.signalTerminal(
                    input.terminalId,
                    input.signal
                  )
                  yield* respond<'signal'>(frame.id, null)
                  return
                }
                case 'kill': {
                  const input = yield* decodeTerminalHostInput(
                    'kill',
                    frame.input
                  )
                  yield* options.sessions.killTerminal(input.terminalId)
                  yield* respond<'kill'>(frame.id, null)
                  return
                }
                case 'killWorktree': {
                  const input = yield* decodeTerminalHostInput(
                    'killWorktree',
                    frame.input
                  )
                  yield* respond<'killWorktree'>(
                    frame.id,
                    yield* options.sessions.killWorktree(input.worktreeId)
                  )
                  return
                }
                case 'shutdown': {
                  yield* decodeTerminalHostInput('shutdown', frame.input)
                  const liveSessionCount = yield* options.sessions.sessionCount
                  if (liveSessionCount > 0) {
                    yield* fail(
                      frame.id,
                      'HOST_NOT_EMPTY',
                      'The terminal host still owns live or exited sessions',
                      { liveSessionCount }
                    )
                    return
                  }

                  const accepted = yield* Ref.modify(shuttingDown, (active) =>
                    active ? [false, active] : [true, true]
                  )
                  if (!accepted) {
                    yield* fail(
                      frame.id,
                      'HOST_SHUTTING_DOWN',
                      'The terminal host is shutting down'
                    )
                    return
                  }

                  yield* options.sessions.shutdown()
                  yield* respond<'shutdown'>(frame.id, null)
                  yield* Deferred.succeed(shutdown, undefined)
                }
              }
            })

          const executeRequest = (admitted: AdmittedRequest) => {
            const { frame } = admitted
            const name =
              frame.method === 'create'
                ? 'treeport.terminal_host.pty.create'
                : frame.method === 'attach'
                  ? 'treeport.terminal_host.attach'
                  : frame.method === 'kill'
                    ? 'treeport.terminal_host.pty.remove'
                    : 'treeport.terminal_host.request'
            const request = frame.trace
              ? handleRequest(frame).pipe(
                  Effect.withSpan(name, {
                    parent: Tracer.externalSpan(frame.trace),
                    attributes: {
                      'treeport.terminal_host.method': frame.method,
                      'treeport.terminal_host.queue_wait_ms':
                        Date.now() - admitted.admittedAt
                    }
                  })
                )
              : handleRequest(frame)
            return request.pipe(
              Effect.catchAll((cause) =>
                fail(frame.id, 'REQUEST_FAILED', errorMessage(cause)).pipe(
                  Effect.catchAll(() => Effect.void)
                )
              )
            )
          }

          const write = yield* socket.writer
          const writer = Effect.forever(
            Effect.gen(function* () {
              const frame = yield* Queue.take(outgoing)
              connection.queuedEventBytes = Math.max(
                0,
                connection.queuedEventBytes - frame.queuedEventBytes
              )
              yield* write(frame.encoded)
              if (
                connection.queuedEventBytes <=
                  TERMINAL_HOST_EVENT_LOW_WATERMARK &&
                connection.outputPauseScopes.size > 0
              ) {
                yield* closeSubscriptions(connection.outputPauseScopes)
              }

              if (frame.completion) {
                yield* Deferred.succeed(frame.completion, undefined)
              }
            })
          )

          const decode = makeTerminalHostFrameDecoder()
          const reader = socket.run(
            (chunk) =>
              decode(chunk).pipe(
                Effect.flatMap((frames) =>
                  Effect.forEach(frames, (frame) => {
                    if (frame.type !== 'request') {
                      connection.socket.destroy()
                      return Effect.void
                    }

                    return Queue.offer(requests, {
                      frame,
                      admittedAt: Date.now()
                    }).pipe(
                      Effect.tap((offered) =>
                        Effect.sync(() => {
                          if (!offered) {
                            connection.socket.destroy()
                          }
                        })
                      ),
                      Effect.asVoid
                    )
                  })
                ),
                Effect.tapError(() =>
                  Effect.sync(() => connection.socket.destroy())
                )
              ),
            {
              onOpen: Effect.void
            }
          )

          const worker = Effect.forever(
            Effect.gen(function* () {
              const admitted = yield* Queue.take(requests)
              const request = executeRequest(admitted)
              if (
                connection.authenticated &&
                admitted.frame.method === 'kill'
              ) {
                yield* Effect.forkScoped(request)
              } else {
                yield* request
              }
            })
          )

          yield* Effect.raceFirst(reader, Effect.raceFirst(writer, worker))
        })
      ).pipe(
        Effect.catchAllCause((cause) => {
          if (Cause.isInterruptedOnly(cause)) {
            return Effect.void
          }

          const failure = Cause.squash(cause)
          return EffectSocket.isSocketError(failure)
            ? Effect.void
            : Effect.logError('Terminal host connection failed').pipe(
                Effect.annotateLogs({ cause: errorMessage(failure) })
              )
        })
      )

    yield* Effect.forkScoped(
      socketServer
        .run(
          // SAFETY: NodeSocketServer provides the NetSocket service required by each accepted socket handler.
          (socket) => runConnection(socket) as Effect.Effect<void, never, never>
        )
        .pipe(
          Effect.catchAll((cause) =>
            Effect.logError('Terminal host socket server failed').pipe(
              Effect.annotateLogs({ cause: errorMessage(cause) })
            )
          )
        )
    )

    return { record, shutdown: Deferred.await(shutdown) }
  }).pipe(
    Effect.onError(() =>
      Effect.all(
        [
          nodePromise(() =>
            fs.rm(`${options.recordPath}.${process.pid}.tmp`, { force: true })
          ),
          nodePromise(() => fs.rm(options.socketPath, { force: true }))
        ],
        { discard: true }
      ).pipe(Effect.catchAll(() => Effect.void))
    )
  )
}
