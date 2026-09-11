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
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Scope from 'effect/Scope'
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

// Request responses naturally apply backpressure through Effect Socket. Pause
// terminal producers when live events build up, while retaining a hard bound in
// case a producer cannot be paused or a single event is unexpectedly large.
const TERMINAL_HOST_EVENT_HIGH_WATERMARK = 4 * 1024 * 1024
const TERMINAL_HOST_EVENT_LOW_WATERMARK = 1024 * 1024
const TERMINAL_HOST_MAX_QUEUED_EVENT_BYTES = 16 * 1024 * 1024

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

class TerminalHostRequestFailure extends Data.TaggedError(
  'TerminalHostRequestFailure'
)<{
  readonly cause: unknown
}> {}

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
  readonly decoder: TerminalHostFrameDecoder
  readonly outputUnsubscribes: Map<string, () => void>
  readonly runtimeUnsubscribes: Map<string, () => void>
  readonly outputPauseReleases: Map<string, () => void>
  readonly requests: Queue.Queue<AdmittedRequest>
  readonly outgoing: Queue.Queue<OutboundFrame>
  queuedEventBytes: number
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function startTerminalHostServer(
  options: TerminalHostServerOptions
): Promise<{
  record: TerminalHostRecord
  close(): Promise<void>
}> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => options.sessions.initialize(),
        catch: (cause) => cause
      })

      const record: TerminalHostRecord = {
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
        hostId: options.hostId,
        hostKey: options.hostKey,
        pid: options.pid ?? process.pid,
        socketPath: options.socketPath,
        startedAt: options.startedAt ?? new Date().toISOString()
      }
      const serverScope = yield* Scope.make()
      let shuttingDown = false

      const attempt = <A>(
        evaluate: () => A | Promise<A>
      ): Effect.Effect<A, TerminalHostRequestFailure> =>
        Effect.tryPromise({
          try: async () => evaluate(),
          catch: (cause) => new TerminalHostRequestFailure({ cause })
        })

      const enqueueResponse = (
        connection: HostConnection,
        frame: TerminalHostResponseFrame
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const completion = yield* Deferred.make<void>()
          const offered = yield* Queue.offer(connection.outgoing, {
            encoded: encodeTerminalHostFrame(frame),
            queuedEventBytes: 0,
            completion
          })
          if (!offered) {
            return yield* Effect.interrupt
          }

          yield* Deferred.await(completion)
        })

      const sendEvent = (
        connection: HostConnection,
        frame: TerminalHostEventFrame
      ): boolean => {
        if (connection.socket.destroyed) {
          return false
        }

        let encoded: Buffer
        try {
          encoded = encodeTerminalHostFrame(frame)
        } catch {
          connection.socket.destroy()
          return false
        }

        if (
          connection.queuedEventBytes + encoded.byteLength >
          TERMINAL_HOST_MAX_QUEUED_EVENT_BYTES
        ) {
          connection.socket.destroy()
          return false
        }

        connection.queuedEventBytes += encoded.byteLength
        if (
          Queue.unsafeOffer(connection.outgoing, {
            encoded,
            queuedEventBytes: encoded.byteLength,
            completion: null
          })
        ) {
          if (
            frame.event === 'output' &&
            connection.queuedEventBytes >= TERMINAL_HOST_EVENT_HIGH_WATERMARK &&
            !connection.outputPauseReleases.has(frame.data.terminalId)
          ) {
            const release = options.sessions.pauseOutput(frame.data.terminalId)
            if (release) {
              connection.outputPauseReleases.set(frame.data.terminalId, release)
            }
          }

          return true
        }

        connection.queuedEventBytes = Math.max(
          0,
          connection.queuedEventBytes - encoded.byteLength
        )
        connection.socket.destroy()
        return false
      }

      const respond = <Method extends keyof TerminalHostResults>(
        connection: HostConnection,
        id: string,
        result: TerminalHostResults[Method]
      ) =>
        enqueueResponse(connection, {
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
        enqueueResponse(connection, {
          protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
          type: 'response',
          id,
          result: null,
          error: { code, message, ...details }
        })

      const rejectConnection = (
        connection: HostConnection,
        response: Effect.Effect<void>
      ) =>
        response.pipe(
          Effect.zipRight(
            Effect.sync(() => {
              connection.socket.destroy()
            })
          )
        )

      const handleRequest = (
        connection: HostConnection,
        frame: TerminalHostRequestFrame
      ): Effect.Effect<void, TerminalHostRequestFailure> =>
        Effect.gen(function* () {
          if (frame.protocolVersion !== TERMINAL_HOST_PROTOCOL_VERSION) {
            yield* fail(
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
              yield* rejectConnection(
                connection,
                fail(
                  connection,
                  frame.id,
                  'AUTH_REQUIRED',
                  'Handshake is required'
                )
              )
              return
            }

            const input = yield* attempt(() =>
              terminalHostInputSchemas.handshake.parse(frame.input)
            )
            if (!tokensMatch(input.token ?? '', options.token)) {
              yield* rejectConnection(
                connection,
                fail(
                  connection,
                  frame.id,
                  'AUTH_FAILED',
                  'Authentication failed'
                )
              )
              return
            }

            if (input.hostKey !== options.hostKey) {
              yield* rejectConnection(
                connection,
                fail(
                  connection,
                  frame.id,
                  'HOST_MISMATCH',
                  'Terminal host key differs'
                )
              )
              return
            }

            if (input.protocolVersion !== TERMINAL_HOST_PROTOCOL_VERSION) {
              yield* fail(
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
            yield* respond<'handshake'>(connection, frame.id, {
              ...record,
              liveSessionCount: options.sessions.sessionCount,
              traceContext: true
            })
            return
          }

          if (shuttingDown) {
            yield* fail(
              connection,
              frame.id,
              'HOST_SHUTTING_DOWN',
              'The terminal host is shutting down'
            )
            return
          }

          switch (frame.method) {
            case 'handshake':
              yield* fail(
                connection,
                frame.id,
                'ALREADY_AUTHENTICATED',
                'Handshake is complete'
              )
              return
            case 'create':
              yield* attempt(() =>
                options.sessions.createTerminal(
                  terminalHostInputSchemas.create.parse(frame.input)
                )
              )
              yield* respond<'create'>(connection, frame.id, null)
              return
            case 'inventory': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.inventory.parse(frame.input)
              )
              const terminals = yield* attempt(() =>
                options.sessions.listTerminals(input.worktreeId)
              )
              yield* respond<'inventory'>(connection, frame.id, terminals)
              return
            }
            case 'state': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.state.parse(frame.input)
              )
              const state = yield* attempt(() =>
                options.sessions.terminalState(input.terminalId)
              )
              yield* respond<'state'>(connection, frame.id, state)
              return
            }
            case 'attach': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.attach.parse(frame.input)
              )
              connection.outputUnsubscribes.get(input.terminalId)?.()
              const unsubscribe = yield* attempt(() =>
                options.sessions.subscribeOutput(
                  input.terminalId,
                  (output, sequence) => {
                    sendEvent(connection, {
                      protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
                      type: 'event',
                      event: 'output',
                      data: { terminalId: input.terminalId, output, sequence }
                    })
                  }
                )
              )
              connection.outputUnsubscribes.set(input.terminalId, unsubscribe)
              const snapshot = yield* attempt(() =>
                options.sessions.snapshot(input.terminalId)
              )
              if (snapshot === null) {
                unsubscribe()
                connection.outputUnsubscribes.delete(input.terminalId)
              }

              yield* respond<'attach'>(connection, frame.id, snapshot)
              return
            }
            case 'unsubscribeOutput': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.unsubscribeOutput.parse(frame.input)
              )
              connection.outputUnsubscribes.get(input.terminalId)?.()
              connection.outputUnsubscribes.delete(input.terminalId)
              yield* respond<'unsubscribeOutput'>(connection, frame.id, null)
              return
            }
            case 'subscribeRuntime': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.subscribeRuntime.parse(frame.input)
              )
              connection.runtimeUnsubscribes.get(input.terminalId)?.()
              const unsubscribe = yield* attempt(() =>
                options.sessions.subscribeRuntime(input.terminalId, (value) => {
                  sendEvent(connection, {
                    protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
                    type: 'event',
                    event: 'runtime',
                    data: { terminalId: input.terminalId, value }
                  })
                })
              )
              connection.runtimeUnsubscribes.set(input.terminalId, unsubscribe)
              yield* respond<'subscribeRuntime'>(connection, frame.id, null)
              return
            }
            case 'unsubscribeRuntime': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.unsubscribeRuntime.parse(frame.input)
              )
              connection.runtimeUnsubscribes.get(input.terminalId)?.()
              connection.runtimeUnsubscribes.delete(input.terminalId)
              yield* respond<'unsubscribeRuntime'>(connection, frame.id, null)
              return
            }
            case 'runtimeState': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.runtimeState.parse(frame.input)
              )
              const state = yield* attempt(() =>
                options.sessions.runtimeState(input.terminalId)
              )
              yield* respond<'runtimeState'>(connection, frame.id, state)
              return
            }
            case 'write': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.write.parse(frame.input)
              )
              yield* attempt(() =>
                options.sessions.write(
                  input.terminalId,
                  input.encoding === 'base64'
                    ? Buffer.from(input.data, 'base64')
                    : input.data,
                  input.authority
                )
              )
              yield* respond<'write'>(connection, frame.id, null)
              return
            }
            case 'prepareQueryAuthority': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.prepareQueryAuthority.parse(
                  frame.input
                )
              )
              const transition = yield* attempt(() =>
                options.sessions.prepareQueryAuthority(input.terminalId)
              )
              yield* respond<'prepareQueryAuthority'>(
                connection,
                frame.id,
                transition
              )
              return
            }
            case 'activateQueryAuthority': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.activateQueryAuthority.parse(
                  frame.input
                )
              )
              yield* attempt(() =>
                options.sessions.activateQueryAuthority(
                  input.terminalId,
                  input.transitionId,
                  input.attachmentId,
                  input.generation,
                  input.cellSize
                )
              )
              yield* respond<'activateQueryAuthority'>(
                connection,
                frame.id,
                null
              )
              return
            }
            case 'hostQueryAuthority': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.hostQueryAuthority.parse(frame.input)
              )
              yield* attempt(() =>
                options.sessions.useHostQueryAuthority(input.terminalId)
              )
              yield* respond<'hostQueryAuthority'>(connection, frame.id, null)
              return
            }
            case 'resize': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.resize.parse(frame.input)
              )
              yield* attempt(() =>
                options.sessions.resize(
                  input.terminalId,
                  input.cols,
                  input.rows
                )
              )
              yield* respond<'resize'>(connection, frame.id, null)
              return
            }
            case 'capture': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.capture.parse(frame.input)
              )
              const capture = yield* attempt(() =>
                options.sessions.captureTerminal(input.terminalId, input.lines)
              )
              yield* respond<'capture'>(connection, frame.id, capture)
              return
            }
            case 'rename': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.rename.parse(frame.input)
              )
              yield* attempt(() =>
                options.sessions.renameTerminal(
                  input.terminalId,
                  input.name,
                  input.updatedAt
                )
              )
              yield* respond<'rename'>(connection, frame.id, null)
              return
            }
            case 'processes': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.processes.parse(frame.input)
              )
              const processes = yield* attempt(() =>
                options.sessions.listProcesses(input.worktreeId)
              )
              yield* respond<'processes'>(connection, frame.id, processes)
              return
            }
            case 'titleState': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.titleState.parse(frame.input)
              )
              const state = yield* attempt(() =>
                options.sessions.terminalTitleState(input.terminalId)
              )
              yield* respond<'titleState'>(connection, frame.id, state)
              return
            }
            case 'signal': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.signal.parse(frame.input)
              )
              yield* attempt(() =>
                options.sessions.signalTerminal(input.terminalId, input.signal)
              )
              yield* respond<'signal'>(connection, frame.id, null)
              return
            }
            case 'kill': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.kill.parse(frame.input)
              )
              yield* attempt(() =>
                options.sessions.killTerminal(input.terminalId)
              )
              yield* respond<'kill'>(connection, frame.id, null)
              return
            }
            case 'killWorktree': {
              const input = yield* attempt(() =>
                terminalHostInputSchemas.killWorktree.parse(frame.input)
              )
              const terminalIds = yield* attempt(() =>
                options.sessions.killWorktree(input.worktreeId)
              )
              yield* respond<'killWorktree'>(connection, frame.id, terminalIds)
              return
            }
            case 'shutdown':
              yield* attempt(() =>
                terminalHostInputSchemas.shutdown.parse(frame.input)
              )
              if (options.sessions.sessionCount > 0) {
                yield* fail(
                  connection,
                  frame.id,
                  'HOST_NOT_EMPTY',
                  'The terminal host still owns live or exited sessions',
                  { liveSessionCount: options.sessions.sessionCount }
                )
                return
              }

              shuttingDown = true
              yield* attempt(() => options.sessions.shutdown()).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    shuttingDown = false
                  })
                )
              )
              yield* respond<'shutdown'>(connection, frame.id, null)
              setImmediate(() => {
                Effect.runFork(
                  Effect.tryPromise({
                    try: async () => {
                      await close()
                      await options.onShutdown?.()
                    },
                    catch: (cause) => cause
                  }).pipe(
                    Effect.catchAll((cause) =>
                      Effect.sync(() => {
                        console.error(
                          '[Treeport terminal host] Requested shutdown failed:',
                          errorMessage(cause)
                        )
                      })
                    )
                  )
                )
              })
          }
        })

      const executeRequest = (
        connection: HostConnection,
        admitted: AdmittedRequest
      ): Effect.Effect<void> => {
        const { frame } = admitted
        const evaluate = () => handleRequest(connection, frame)
        const request =
          frame.trace && options.trace
            ? Effect.tryPromise({
                try: (signal) =>
                  options.trace!(
                    frame.method === 'create'
                      ? 'treeport.terminal_host.pty.create'
                      : frame.method === 'attach'
                        ? 'treeport.terminal_host.attach'
                        : frame.method === 'kill'
                          ? 'treeport.terminal_host.pty.remove'
                          : 'treeport.terminal_host.request',
                    frame.trace!,
                    {
                      'treeport.terminal_host.method': frame.method,
                      'treeport.terminal_host.queue_wait_ms':
                        Date.now() - admitted.admittedAt
                    },
                    async () => {
                      const result = await Effect.runPromiseExit(evaluate(), {
                        signal
                      })
                      if (Exit.isFailure(result)) {
                        throw Cause.squash(result.cause)
                      }

                      return result.value
                    }
                  ),
                catch: (cause) =>
                  cause instanceof TerminalHostRequestFailure
                    ? cause
                    : new TerminalHostRequestFailure({ cause })
              })
            : evaluate()

        return request.pipe(
          Effect.catchTag('TerminalHostRequestFailure', (failure) =>
            fail(
              connection,
              frame.id,
              'REQUEST_FAILED',
              errorMessage(failure.cause)
            )
          )
        )
      }

      const runConnection = (
        socket: EffectSocket.Socket
      ): Effect.Effect<void, never, NodeSocket.NetSocket> =>
        Effect.scoped(
          Effect.gen(function* () {
            const netSocket = yield* NodeSocket.NetSocket
            netSocket.setNoDelay(true)
            const requests = yield* Effect.acquireRelease(
              Queue.unbounded<AdmittedRequest>(),
              Queue.shutdown
            )
            const outgoing = yield* Effect.acquireRelease(
              Queue.unbounded<OutboundFrame>(),
              Queue.shutdown
            )
            const connection: HostConnection = {
              socket: netSocket,
              authenticated: false,
              decoder: new TerminalHostFrameDecoder(),
              outputUnsubscribes: new Map(),
              runtimeUnsubscribes: new Map(),
              outputPauseReleases: new Map(),
              requests,
              outgoing,
              queuedEventBytes: 0
            }

            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                connection.queuedEventBytes = 0
                for (const unsubscribe of connection.outputUnsubscribes.values()) {
                  unsubscribe()
                }
                for (const unsubscribe of connection.runtimeUnsubscribes.values()) {
                  unsubscribe()
                }
                for (const release of connection.outputPauseReleases.values()) {
                  release()
                }
                connection.outputUnsubscribes.clear()
                connection.runtimeUnsubscribes.clear()
                connection.outputPauseReleases.clear()
                if (connection.authenticated) {
                  yield* Effect.tryPromise({
                    try: () => options.sessions.restoreHostQueryAuthority(),
                    catch: (cause) => cause
                  }).pipe(
                    Effect.catchAll((cause) =>
                      Effect.sync(() => {
                        console.error(
                          '[Treeport terminal host] Failed to restore query authority after a client disconnected:',
                          errorMessage(cause)
                        )
                      })
                    )
                  )
                }
              })
            )
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                netSocket.destroy()
              })
            )

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
                  connection.outputPauseReleases.size > 0
                ) {
                  for (const release of connection.outputPauseReleases.values()) {
                    release()
                  }
                  connection.outputPauseReleases.clear()
                }

                if (frame.completion) {
                  yield* Deferred.succeed(frame.completion, undefined)
                }
              })
            )
            const reader = socket.run((chunk) => {
              let frames: ReturnType<TerminalHostFrameDecoder['push']>
              try {
                frames = connection.decoder.push(
                  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                )
              } catch {
                netSocket.destroy()
                return
              }

              for (const frame of frames) {
                if (
                  frame.type !== 'request' ||
                  !Queue.unsafeOffer(requests, {
                    frame,
                    admittedAt: Date.now()
                  })
                ) {
                  netSocket.destroy()
                  return
                }
              }
            })
            const worker = Effect.forever(
              Effect.gen(function* () {
                const admitted = yield* Queue.take(requests)
                const request = executeRequest(connection, admitted)
                if (
                  connection.authenticated &&
                  admitted.frame.method === 'kill'
                ) {
                  // Kill starts after preceding control work but does not block
                  // unrelated requests while physical process cleanup finishes.
                  yield* Effect.forkScoped(request)
                } else {
                  yield* request
                }
              })
            )

            yield* Effect.all([reader, writer, worker], {
              concurrency: 'unbounded',
              discard: true
            })
          })
        ).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              if (Cause.isInterruptedOnly(cause)) {
                return
              }

              const failure = Cause.squash(cause)
              if (!EffectSocket.isSocketError(failure)) {
                console.error(
                  '[Treeport terminal host] Connection failed:',
                  errorMessage(failure)
                )
              }
            })
          )
        )

      const socketServer = yield* NodeSocketServer.make({
        path: options.socketPath
      }).pipe(
        Scope.extend(serverScope),
        Effect.onError(() => Scope.close(serverScope, Exit.void))
      )
      const serverFiber = Effect.runFork(
        socketServer
          .run(
            // SAFETY: NodeSocketServer provides its accepted NetSocket to every
            // handler even though the public handler declaration erases it.
            (socket) =>
              runConnection(socket) as Effect.Effect<void, never, never>
          )
          .pipe(
            Effect.catchAll((cause) =>
              Effect.sync(() => {
                console.error(
                  '[Treeport terminal host] Socket server failed:',
                  errorMessage(cause)
                )
              })
            )
          )
      )
      let closePromise: Promise<void> | null = null

      function close(): Promise<void> {
        closePromise ??= Effect.runPromise(
          Effect.gen(function* () {
            yield* Fiber.interrupt(serverFiber)
            yield* Scope.close(serverScope, Exit.void)
            const ownsRecord = yield* Effect.tryPromise({
              try: async () => {
                const value = await fs.readFile(options.recordPath, 'utf8')
                const parsed = terminalHostRecordSchema.safeParse(
                  JSON.parse(value)
                )
                return parsed.success && parsed.data.hostId === options.hostId
              },
              catch: () => false
            }).pipe(Effect.catchAll(() => Effect.succeed(false)))
            if (ownsRecord) {
              yield* Effect.tryPromise({
                try: () => fs.rm(options.recordPath, { force: true }),
                catch: (cause) => cause
              })
            }

            yield* Effect.tryPromise({
              try: () => fs.rm(options.socketPath, { force: true }),
              catch: (cause) => cause
            })
          })
        )
        return closePromise
      }

      const temporaryRecordPath = `${options.recordPath}.${process.pid}.tmp`
      yield* Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => fs.chmod(options.socketPath, 0o600),
          catch: (cause) => cause
        })
        yield* Effect.tryPromise({
          try: () =>
            fs.writeFile(temporaryRecordPath, `${JSON.stringify(record)}\n`, {
              mode: 0o600
            }),
          catch: (cause) => cause
        })
        yield* Effect.tryPromise({
          try: () => fs.rename(temporaryRecordPath, options.recordPath),
          catch: (cause) => cause
        })
      }).pipe(
        Effect.onError(() =>
          Effect.promise(async () => {
            await fs.rm(temporaryRecordPath, { force: true }).catch(() => {})
            await close().catch(() => {})
          })
        )
      )

      return { record, close }
    })
  )
}
