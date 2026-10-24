import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import * as EffectSocket from '@effect/platform/Socket'
import * as NodeSocket from '@effect/platform-node/NodeSocket'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Either from 'effect/Either'
import * as Exit from 'effect/Exit'
import * as PubSub from 'effect/PubSub'
import * as Queue from 'effect/Queue'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as SynchronizedRef from 'effect/SynchronizedRef'
import type {
  HostedTerminal,
  TerminalAttachmentBackend,
  TerminalHostAttachment,
  TerminalHostOutput,
  TerminalHostRuntimeEvent,
  TerminalProcess,
  TerminalSessionBackend,
  TerminalSessionState,
  TerminalTitleState,
  TerminalTraceContext
} from './core/terminal'
import {
  decodeTerminalHostRecord,
  decodeTerminalHostResult,
  encodeTerminalHostFrame,
  makeTerminalHostFrameDecoder,
  TerminalHostConnectionError,
  TerminalHostDisconnected,
  TerminalHostRequestError,
  TerminalHostRequestTimeout,
  type TerminalHostClientError,
  type TerminalHostCreateInput,
  type TerminalHostEventFrame,
  type TerminalHostRecord,
  type TerminalHostRequestFrame,
  type TerminalHostRequestInput,
  type TerminalHostResult,
  type TerminalHostResponseFrame,
  type TerminalHostResults
} from '../terminal-runtime/api'
import { inspectLegacyTerminalHost } from '../terminal-runtime/legacy-host'
import { prepareSessionKeeper } from '@treeport/session-keeper'
import { startTerminalEngineWorker } from './terminal-engine-worker'

const TERMINAL_HOST_REQUEST_TIMEOUT_MS = 30_000
const LEGACY_HOST_STOP_TIMEOUT_MS = 10_000

interface TerminalHostPaths {
  readonly hostKey: string
  readonly socketPath: string
  readonly recordPath: string
  readonly tokenPath: string
  readonly hostRuntimeDir: string
}

interface OutputRoute {
  readonly pubsub: PubSub.PubSub<TerminalHostOutput>
  references: number
}

interface RuntimeRoute {
  readonly pubsub: PubSub.PubSub<TerminalHostRuntimeEvent>
  references: number
  subscribed: boolean
}

interface RouteLock {
  readonly semaphore: Effect.Semaphore
  users: number
}

type PendingRequest = Deferred.Deferred<
  TerminalHostResult,
  TerminalHostClientError
>

export interface TerminalHostClientOptions {
  readonly dataDir: string
  readonly runtimeDir: string
  readonly launcherPath: string
  readonly engineWorkerPath: string
  readonly environment?: NodeJS.ProcessEnv
  readonly sessionExecutable: string
  readonly journalLimitBytes?: number | undefined
}

function connectionError(cause: unknown): TerminalHostConnectionError {
  return new TerminalHostConnectionError({ cause })
}

function nodePromise<A>(evaluate: () => Promise<A>) {
  return Effect.tryPromise({ try: evaluate, catch: connectionError })
}

function terminalHostPaths(
  dataDir: string,
  runtimeDir: string
): TerminalHostPaths {
  const hostKey = crypto
    .createHash('sha256')
    .update(path.resolve(dataDir))
    .digest('hex')
    .slice(0, 20)
  const engineDirectory = path.join(runtimeDir, 'terminal-engine')
  return {
    hostKey,
    socketPath: path.join(
      os.tmpdir(),
      `treeport-${process.getuid?.() ?? 'user'}`,
      `terminal-engine-${hostKey}.sock`
    ),
    recordPath: path.join(engineDirectory, `terminal-host-${hostKey}.json`),
    tokenPath: path.join(dataDir, 'terminal-host.token'),
    hostRuntimeDir: path.join(engineDirectory, `terminal-host-${hostKey}`)
  }
}

function readOrCreateToken(
  tokenPath: string
): Effect.Effect<string, TerminalHostConnectionError> {
  return Effect.gen(function* () {
    const created = crypto.randomBytes(32).toString('base64url')
    yield* nodePromise(() =>
      fs.writeFile(tokenPath, `${created}\n`, { flag: 'wx', mode: 0o600 })
    ).pipe(
      Effect.catchAll((failure) =>
        // SAFETY: Node filesystem failures expose the standard ErrnoException code.
        (failure.cause as NodeJS.ErrnoException).code === 'EEXIST'
          ? Effect.void
          : Effect.fail(failure)
      )
    )
    yield* nodePromise(() => fs.chmod(tokenPath, 0o600))
    return (yield* nodePromise(() => fs.readFile(tokenPath, 'utf8'))).trim()
  })
}

interface TerminalHostDiscovery {
  readonly record: TerminalHostRecord | null
  readonly missing: boolean
  readonly invalid: boolean
}

function readRecord(recordPath: string): Effect.Effect<TerminalHostDiscovery> {
  return Effect.gen(function* () {
    const source = yield* Effect.either(
      nodePromise(() => fs.readFile(recordPath, 'utf8'))
    )
    if (Either.isLeft(source)) {
      // SAFETY: Node filesystem failures expose their standard code on ErrnoException.
      const code = (source.left.cause as NodeJS.ErrnoException).code
      return {
        record: null,
        missing: code === 'ENOENT',
        invalid: code !== 'ENOENT'
      }
    }

    const parsed = yield* Effect.either(
      Effect.try({
        // SAFETY: JSON may contain any shape; the runtime-owned decoder validates it below.
        try: () => JSON.parse(source.right) as unknown,
        catch: connectionError
      })
    )
    if (Either.isLeft(parsed)) {
      return { record: null, missing: false, invalid: true }
    }

    const decoded = yield* Effect.either(decodeTerminalHostRecord(parsed.right))
    return Either.isLeft(decoded)
      ? { record: null, missing: false, invalid: true }
      : { record: decoded.right, missing: false, invalid: false }
  })
}

function processExists(pid: number): Effect.Effect<boolean> {
  return Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return true
    } catch (cause) {
      // SAFETY: process.kill reports permission failures using Node's ErrnoException shape.
      return (cause as NodeJS.ErrnoException).code === 'EPERM'
    }
  })
}

function isDefinitiveConnectionFailure(
  error: TerminalHostClientError
): boolean {
  return (
    error._tag === 'TerminalHostRequestError' &&
    ['AUTH_FAILED', 'HOST_MISMATCH', 'UNSUPPORTED_HOST'].includes(error.code)
  )
}

function isStaleSocketFailure(error: TerminalHostClientError): boolean {
  let cause: unknown = error
  while (
    (cause instanceof TerminalHostConnectionError ||
      EffectSocket.isSocketError(cause)) &&
    'cause' in cause
  ) {
    cause = cause.cause
  }
  // SAFETY: Nested Node socket failures expose their platform error through ErrnoException.code.
  const code = (cause as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

/** Scoped daemon-side connection to one terminal engine. */
export class TerminalHostClient
  implements TerminalSessionBackend, TerminalAttachmentBackend
{
  private readonly routeLocks = new Map<string, RouteLock>()

  private constructor(
    readonly record: TerminalHostRecord,
    private readonly outgoing: Queue.Queue<Buffer>,
    private readonly pending: SynchronizedRef.SynchronizedRef<
      ReadonlyMap<string, PendingRequest>
    >,
    private readonly outputRoutes: Map<string, OutputRoute>,
    private readonly runtimeRoutes: Map<string, RuntimeRoute>,
    private readonly closed: SynchronizedRef.SynchronizedRef<boolean>
  ) {}

  static connect(
    socketPath: string,
    token: string,
    hostKey: string,
    expectedHostId?: string
  ): Effect.Effect<TerminalHostClient, TerminalHostClientError, Scope.Scope> {
    return Effect.gen(function* () {
      const connectionScope = yield* Scope.make()
      const acquired = yield* Effect.exit(
        Scope.extend(
          TerminalHostClient.acquire(
            socketPath,
            token,
            hostKey,
            expectedHostId
          ),
          connectionScope
        )
      )
      if (Exit.isFailure(acquired)) {
        yield* Scope.close(connectionScope, acquired)
        return yield* Effect.failCause(acquired.cause)
      }

      yield* Effect.addFinalizer(() => Scope.close(connectionScope, Exit.void))
      return acquired.value
    })
  }

  private static acquire(
    socketPath: string,
    token: string,
    hostKey: string,
    expectedHostId: string | undefined
  ): Effect.Effect<TerminalHostClient, TerminalHostClientError, Scope.Scope> {
    return Effect.gen(function* () {
      const socket = yield* NodeSocket.makeNet({
        path: socketPath,
        openTimeout: '5 seconds'
      }).pipe(Effect.mapError(connectionError))
      const outgoing = yield* Effect.acquireRelease(
        Queue.unbounded<Buffer>(),
        Queue.shutdown
      )
      const pending = yield* SynchronizedRef.make<
        ReadonlyMap<string, PendingRequest>
      >(new Map())
      const closed = yield* SynchronizedRef.make(false)
      const provisionalRecord: TerminalHostRecord = {
        hostId: '',
        hostKey,
        pid: 1,
        socketPath,
        startedAt: ''
      }
      const client = new TerminalHostClient(
        provisionalRecord,
        outgoing,
        pending,
        new Map(),
        new Map(),
        closed
      )

      const disconnected = new TerminalHostDisconnected({
        message: 'Terminal host connection closed'
      })
      const close = client.closeWith(disconnected)
      yield* Effect.addFinalizer(() => close)

      const write = yield* socket.writer
      yield* Effect.forkScoped(
        Effect.forever(Queue.take(outgoing).pipe(Effect.flatMap(write))).pipe(
          Effect.mapError(connectionError),
          Effect.tapError((cause) =>
            Effect.logDebug('Terminal host writer stopped').pipe(
              Effect.annotateLogs({ cause: String(cause) })
            )
          ),
          Effect.tapError((cause) => client.closeWith(cause)),
          Effect.ensuring(close),
          Effect.ignore
        )
      )

      const decode = makeTerminalHostFrameDecoder()
      let noDelay = false
      // SAFETY: NodeSocket.run supplies NetSocket to its handler internally, so the forked socket effect has no external requirement.
      yield* Effect.forkScoped(
        socket
          .run(
            (chunk) =>
              Effect.gen(function* () {
                if (!noDelay) {
                  const raw = yield* NodeSocket.NetSocket
                  raw.setNoDelay(true)
                  noDelay = true
                }

                return yield* decode(chunk).pipe(
                  Effect.flatMap((frames) =>
                    Effect.forEach(
                      frames,
                      (frame) => {
                        if (frame.type === 'response') {
                          return client.receiveResponse(frame)
                        }

                        if (frame.type === 'event') {
                          return client.receiveEvent(frame)
                        }

                        return client.closeWith(
                          new TerminalHostDisconnected({
                            message:
                              'Terminal host sent a request to its client'
                          })
                        )
                      },
                      { discard: true }
                    )
                  )
                )
              }),
            { onOpen: Effect.void }
          )
          .pipe(
            Effect.mapError(connectionError),
            Effect.tapError((cause) =>
              Effect.logDebug('Terminal host reader stopped').pipe(
                Effect.annotateLogs({ cause: String(cause) })
              )
            ),
            Effect.tapError((cause) => client.closeWith(cause)),
            Effect.ensuring(close),
            Effect.ignore
          ) as Effect.Effect<void>
      )

      const handshake = yield* client.request('handshake', { token, hostKey })
      if (expectedHostId && handshake.hostId !== expectedHostId) {
        return yield* Effect.fail(
          new TerminalHostRequestError({
            code: 'HOST_MISMATCH',
            message:
              'The terminal host identifier differs from its discovery record'
          })
        )
      }

      Object.assign(client.record, handshake)
      return client
    })
  }

  initialize(): Effect.Effect<boolean> {
    return Effect.succeed(true)
  }

  createTerminal(
    input: TerminalHostCreateInput,
    trace?: TerminalTraceContext
  ): Effect.Effect<void, TerminalHostClientError> {
    return this.request('create', input, trace).pipe(Effect.asVoid)
  }

  listTerminals(
    worktreeId: string
  ): Effect.Effect<HostedTerminal[], TerminalHostClientError> {
    return this.request('inventory', { worktreeId })
  }

  terminalState(
    terminalId: string
  ): Effect.Effect<TerminalSessionState, TerminalHostClientError> {
    return this.request('state', { terminalId })
  }

  attach(
    terminalId: string,
    trace?: TerminalTraceContext
  ): Effect.Effect<
    TerminalHostAttachment | null,
    TerminalHostClientError,
    Scope.Scope
  > {
    return Effect.gen(this, function* () {
      // Releases take the route lock, and a scope that is already closed runs
      // a new finalizer immediately. Register releases outside the lock.
      const route = yield* Effect.acquireRelease(
        this.withRouteLock(
          terminalId,
          Effect.gen(this, function* () {
            let route = this.outputRoutes.get(terminalId)
            if (!route) {
              route = {
                pubsub: yield* PubSub.unbounded<TerminalHostOutput>(),
                references: 0
              }
              this.outputRoutes.set(terminalId, route)
            }

            route.references += 1
            return route
          })
        ),
        (route) => this.releaseOutputRoute(terminalId, route)
      )
      return yield* this.withRouteLock(
        terminalId,
        Effect.gen(this, function* () {
          const subscription = yield* PubSub.subscribe(route.pubsub)
          const snapshot = yield* this.request('attach', { terminalId }, trace)
          if (!snapshot) {
            return null
          }

          return {
            data: snapshot.data,
            format: snapshot.format,
            fence: snapshot.fence,
            cols: snapshot.cols,
            rows: snapshot.rows,
            output: Stream.fromQueue(subscription).pipe(
              Stream.filter((event) => event.sequence > snapshot.fence)
            )
          }
        })
      )
    })
  }

  runtimeEvents(
    terminalId: string
  ): Stream.Stream<TerminalHostRuntimeEvent, TerminalHostClientError> {
    return Stream.unwrapScoped(
      Effect.gen(this, function* () {
        const route = yield* Effect.acquireRelease(
          this.withRouteLock(
            terminalId,
            Effect.gen(this, function* () {
              let route = this.runtimeRoutes.get(terminalId)
              if (!route) {
                route = {
                  pubsub: yield* PubSub.unbounded<TerminalHostRuntimeEvent>(),
                  references: 0,
                  subscribed: false
                }
                this.runtimeRoutes.set(terminalId, route)
              }

              route.references += 1
              return route
            })
          ),
          (route) => this.releaseRuntimeRoute(terminalId, route)
        )
        const subscription = yield* PubSub.subscribe(route.pubsub)
        yield* this.withRouteLock(
          terminalId,
          Effect.gen(this, function* () {
            if (!route.subscribed) {
              yield* this.request('subscribeRuntime', { terminalId })
              route.subscribed = true
            }
          })
        )
        return Stream.fromQueue(subscription)
      })
    )
  }

  runtimeState(terminalId: string) {
    return this.request('runtimeState', { terminalId })
  }

  write(
    terminalId: string,
    data: string | Buffer,
    authority: { attachmentId: string; generation: number }
  ): Effect.Effect<void, TerminalHostClientError> {
    return this.request('write', {
      terminalId,
      data: Buffer.isBuffer(data) ? data.toString('base64') : data,
      encoding: Buffer.isBuffer(data) ? 'base64' : 'utf8',
      authority
    }).pipe(Effect.asVoid)
  }

  prepareQueryAuthority(terminalId: string) {
    return this.request('prepareQueryAuthority', { terminalId })
  }

  activateQueryAuthority(
    terminalId: string,
    transitionId: string,
    attachmentId: string,
    generation: number,
    cellSize: { width: number; height: number } | null = null
  ) {
    const input: TerminalHostRequestInput<'activateQueryAuthority'> = {
      terminalId,
      transitionId,
      attachmentId,
      generation
    }
    Object.assign(input, { cellSize })
    return this.request('activateQueryAuthority', input).pipe(Effect.asVoid)
  }

  useHostQueryAuthority(terminalId: string) {
    return this.request('hostQueryAuthority', { terminalId }).pipe(
      Effect.asVoid
    )
  }

  resize(terminalId: string, cols: number, rows: number) {
    return this.request('resize', { terminalId, cols, rows }).pipe(
      Effect.asVoid
    )
  }

  captureTerminal(terminalId: string, lines: number) {
    return this.request('capture', { terminalId, lines })
  }

  renameTerminal(terminalId: string, name: string, updatedAt: string) {
    return this.request('rename', { terminalId, name, updatedAt }).pipe(
      Effect.asVoid
    )
  }

  listProcesses(
    worktreeId: string
  ): Effect.Effect<TerminalProcess[], TerminalHostClientError> {
    return this.request('processes', { worktreeId })
  }

  terminalTitleState(
    terminalId: string
  ): Effect.Effect<TerminalTitleState | null, TerminalHostClientError> {
    return this.request('titleState', { terminalId })
  }

  signalTerminal(
    terminalId: string,
    signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'
  ) {
    return this.request('signal', { terminalId, signal }).pipe(Effect.asVoid)
  }

  killTerminal(terminalId: string, trace?: TerminalTraceContext) {
    return this.request('kill', { terminalId }, trace).pipe(Effect.asVoid)
  }

  killWorktree(
    worktreeId: string
  ): Effect.Effect<string[], TerminalHostClientError> {
    return this.request('killWorktree', { worktreeId })
  }

  shutdownIfEmpty() {
    return this.request('shutdown', { ifEmpty: true }).pipe(Effect.asVoid)
  }

  private request<Method extends keyof TerminalHostResults>(
    method: Method,
    input: TerminalHostRequestInput<Method>,
    _trace?: TerminalTraceContext
  ): Effect.Effect<TerminalHostResults[Method], TerminalHostClientError> {
    return Effect.gen(this, function* () {
      if (yield* SynchronizedRef.get(this.closed)) {
        return yield* Effect.fail(
          new TerminalHostDisconnected({
            message: 'Terminal host connection is closed'
          })
        )
      }

      const id = crypto.randomUUID()
      const response = yield* Deferred.make<
        TerminalHostResult,
        TerminalHostClientError
      >()
      yield* SynchronizedRef.update(this.pending, (current) => {
        const next = new Map(current)
        next.set(id, response)
        return next
      })
      const frame: TerminalHostRequestFrame = {
        type: 'request',
        id,
        method,
        input
      }
      if (_trace) {
        Object.assign(frame, { trace: _trace })
      }

      const encoded = yield* encodeTerminalHostFrame(frame)
      const offered = yield* Queue.offer(this.outgoing, encoded)
      if (!offered) {
        return yield* Effect.fail(
          new TerminalHostDisconnected({
            message: 'Terminal host connection is closed'
          })
        )
      }

      return yield* Deferred.await(response).pipe(
        // Input is allowed to wait for a slow PTY. Disconnects still fail
        // pending requests; a deadline must never cause an input retry.
        method === 'write'
          ? (effect) => effect
          : Effect.timeoutFail({
              duration: TERMINAL_HOST_REQUEST_TIMEOUT_MS,
              onTimeout: () => new TerminalHostRequestTimeout({ method })
            }),
        Effect.flatMap((result) => decodeTerminalHostResult(method, result)),
        Effect.ensuring(
          SynchronizedRef.update(this.pending, (current) => {
            if (current.get(id) !== response) {
              return current
            }

            const next = new Map(current)
            next.delete(id)
            return next
          })
        )
      )
    })
  }

  private receiveResponse(
    frame: TerminalHostResponseFrame
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const pending = yield* SynchronizedRef.modify(this.pending, (current) => {
        const request = current.get(frame.id) ?? null
        if (!request) {
          return [null, current] as const
        }

        const next = new Map(current)
        next.delete(frame.id)
        return [request, next] as const
      })
      if (!pending) {
        return
      }

      if (frame.error) {
        yield* Deferred.fail(
          pending,
          new TerminalHostRequestError({ ...frame.error })
        )
        return
      }

      if (frame.result === undefined) {
        yield* Deferred.fail(
          pending,
          new TerminalHostDisconnected({
            message: 'Terminal host response omitted its result'
          })
        )
        yield* this.closeWith(
          new TerminalHostDisconnected({
            message: 'Terminal host response omitted its result'
          })
        )
        return
      }

      yield* Deferred.succeed(pending, frame.result)
    })
  }

  private receiveEvent(frame: TerminalHostEventFrame): Effect.Effect<void> {
    if (frame.event === 'output') {
      const route = this.outputRoutes.get(frame.data.terminalId)
      return route
        ? PubSub.publish(route.pubsub, {
            data: frame.data.output,
            sequence: frame.data.sequence
          }).pipe(Effect.asVoid)
        : Effect.void
    }

    const route = this.runtimeRoutes.get(frame.data.terminalId)
    return route
      ? PubSub.publish(route.pubsub, frame.data.value).pipe(Effect.asVoid)
      : Effect.void
  }

  // Route changes and their subscription requests are ordered per terminal,
  // so one slow terminal cannot stall attachments to every other terminal.
  private withRouteLock<A, E, R>(
    terminalId: string,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const lock = this.routeLocks.get(terminalId) ?? {
          semaphore: Effect.unsafeMakeSemaphore(1),
          users: 0
        }
        lock.users += 1
        this.routeLocks.set(terminalId, lock)
        return lock
      }),
      (lock) => lock.semaphore.withPermits(1)(effect),
      (lock) =>
        Effect.sync(() => {
          lock.users -= 1
          if (lock.users === 0) {
            this.routeLocks.delete(terminalId)
          }
        })
    )
  }

  private releaseOutputRoute(
    terminalId: string,
    route: OutputRoute
  ): Effect.Effect<void> {
    return this.withRouteLock(
      terminalId,
      Effect.gen(this, function* () {
        if (this.outputRoutes.get(terminalId) !== route) {
          return
        }

        route.references = Math.max(0, route.references - 1)
        if (route.references > 0) {
          return
        }

        this.outputRoutes.delete(terminalId)
        yield* PubSub.shutdown(route.pubsub)
        yield* this.request('unsubscribeOutput', { terminalId }).pipe(
          Effect.timeout('1 second'),
          Effect.catchAll((cause) =>
            Effect.logWarning('Failed to unsubscribe terminal output').pipe(
              Effect.annotateLogs({ terminalId, cause: String(cause) })
            )
          ),
          Effect.asVoid
        )
      })
    )
  }

  private releaseRuntimeRoute(
    terminalId: string,
    route: RuntimeRoute
  ): Effect.Effect<void> {
    return this.withRouteLock(
      terminalId,
      Effect.gen(this, function* () {
        if (this.runtimeRoutes.get(terminalId) !== route) {
          return
        }

        route.references = Math.max(0, route.references - 1)
        if (route.references > 0) {
          return
        }

        this.runtimeRoutes.delete(terminalId)
        yield* PubSub.shutdown(route.pubsub)
        yield* this.request('unsubscribeRuntime', { terminalId }).pipe(
          Effect.timeout('1 second'),
          Effect.catchAll((cause) =>
            Effect.logWarning('Failed to unsubscribe terminal runtime').pipe(
              Effect.annotateLogs({ terminalId, cause: String(cause) })
            )
          ),
          Effect.asVoid
        )
      })
    )
  }

  private closeWith(failure: TerminalHostClientError): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const first = yield* SynchronizedRef.modify(this.closed, (closed) =>
        closed ? [false, closed] : [true, true]
      )
      if (!first) {
        return
      }

      const pending = yield* SynchronizedRef.modify(
        this.pending,
        (current) => [[...current.values()], new Map()] as const
      )
      yield* Effect.forEach(pending, (request) =>
        Deferred.fail(request, failure)
      )
      yield* Effect.forEach(this.outputRoutes.values(), (route) =>
        PubSub.shutdown(route.pubsub)
      )
      yield* Effect.forEach(this.runtimeRoutes.values(), (route) =>
        PubSub.shutdown(route.pubsub)
      )
      this.outputRoutes.clear()
      this.runtimeRoutes.clear()
      yield* Queue.shutdown(this.outgoing)
    })
  }
}

/** Acquires the engine, starting its worker unless a live one is recorded. */
export function connectOrStartTerminalHost(
  options: TerminalHostClientOptions
): Effect.Effect<TerminalHostClient, TerminalHostClientError, Scope.Scope> {
  return Effect.gen(function* () {
    // A legacy host's PTYs cannot move to keepers. Refuse to start while it
    // may own terminals, so they are never hidden or reported as cleaned up.
    const legacy = yield* nodePromise(() =>
      inspectLegacyTerminalHost(options.dataDir, options.runtimeDir)
    )
    if (legacy.reason !== null) {
      return yield* Effect.fail(
        new TerminalHostRequestError({
          code: 'UNSUPPORTED_HOST',
          message: `${legacy.reason} ${legacy.next ?? ''}`.trim()
        })
      )
    }

    if (legacy.running && legacy.record && legacy.token) {
      const record = legacy.record
      // The host itself refuses this shutdown if it owns any session.
      yield* Effect.scoped(
        TerminalHostClient.connect(
          record.socketPath,
          legacy.token,
          record.hostKey,
          record.hostId
        ).pipe(Effect.flatMap((host) => host.shutdownIfEmpty()))
      )
      // It deletes the shared token file on exit; wait before reading it.
      const deadline = Date.now() + LEGACY_HOST_STOP_TIMEOUT_MS
      while (yield* processExists(record.pid)) {
        if (Date.now() >= deadline) {
          return yield* Effect.fail(
            connectionError(
              new Error(
                `Idle terminal host PID ${record.pid} accepted shutdown but did not exit.`
              )
            )
          )
        }

        yield* Effect.sleep(50)
      }
    } else if (legacy.record) {
      yield* nodePromise(() =>
        Promise.all([
          fs.rm(legacy.recordPath, { force: true }),
          fs.rm(legacy.socketPath, { force: true })
        ])
      )
    }

    const paths = terminalHostPaths(options.dataDir, options.runtimeDir)
    yield* Effect.all(
      [
        nodePromise(() =>
          fs.mkdir(options.dataDir, { recursive: true, mode: 0o700 })
        ),
        nodePromise(() =>
          fs.mkdir(path.dirname(paths.recordPath), {
            recursive: true,
            mode: 0o700
          })
        ),
        nodePromise(() =>
          fs.mkdir(path.dirname(paths.socketPath), {
            recursive: true,
            mode: 0o700
          })
        ),
        nodePromise(() =>
          fs.mkdir(paths.hostRuntimeDir, { recursive: true, mode: 0o700 })
        )
      ],
      { discard: true, concurrency: 'unbounded' }
    )
    yield* nodePromise(() => fs.chmod(path.dirname(paths.socketPath), 0o700))
    const discovery = yield* readRecord(paths.recordPath)
    const record = discovery.record

    if (discovery.invalid) {
      return yield* Effect.fail(
        connectionError(
          new Error(
            'The terminal host discovery record is invalid. Treeport will not replace the host or unlink its socket.'
          )
        )
      )
    }

    let token = ''
    if (record) {
      token = yield* readOrCreateToken(paths.tokenPath)
      if (
        record.hostKey !== paths.hostKey ||
        record.socketPath !== paths.socketPath
      ) {
        return yield* Effect.fail(
          connectionError(
            new Error(
              'The terminal host discovery record does not identify this installation. Treeport will not replace it.'
            )
          )
        )
      }

      const connected = yield* Effect.either(
        TerminalHostClient.connect(
          record.socketPath,
          token,
          paths.hostKey,
          record.hostId
        )
      )
      if (Either.isRight(connected)) {
        return connected.right
      }

      const failure = connected.left
      if (isDefinitiveConnectionFailure(failure)) {
        return yield* Effect.fail(failure)
      }

      if (Number.isInteger(record.pid) && (yield* processExists(record.pid))) {
        return yield* Effect.fail(
          connectionError(
            new Error(
              `Terminal host PID ${record.pid} exists but its socket is unavailable. Treeport will not signal it.`
            )
          )
        )
      }

      if (isStaleSocketFailure(failure)) {
        // Keep the dead host's record until its replacement atomically publishes
        // a new one. If startup is interrupted, the next attempt still has
        // positive identity evidence instead of treating absence as safety.
        yield* nodePromise(() => fs.rm(paths.socketPath, { force: true }))
      } else {
        return yield* Effect.fail(
          connectionError(
            new Error(
              'The terminal host socket answered unexpectedly. Treeport will not replace it.'
            )
          )
        )
      }
    } else if (discovery.missing) {
      const socketStats = yield* nodePromise(() =>
        fs.lstat(paths.socketPath)
      ).pipe(
        Effect.catchAll((failure) =>
          // SAFETY: Node filesystem failures expose their standard code on ErrnoException.
          (failure.cause as NodeJS.ErrnoException).code === 'ENOENT'
            ? Effect.succeed(null)
            : Effect.fail(failure)
        )
      )
      if (socketStats) {
        // A missing record is no evidence that the socket is unowned, but a
        // refused connection is: a listening host always accepts. This daemon
        // holds the data directory lock that the host key derives from, so no
        // other host can bind this path between the probe and the unlink.
        const refused =
          socketStats.isSocket() &&
          (yield* Effect.async<boolean>((resume) => {
            const socket = net.createConnection(paths.socketPath)
            socket.once('connect', () => {
              socket.destroy()
              resume(Effect.succeed(false))
            })
            socket.once('error', (cause: NodeJS.ErrnoException) => {
              socket.destroy()
              resume(
                Effect.succeed(
                  cause.code === 'ECONNREFUSED' || cause.code === 'ENOENT'
                )
              )
            })
            return Effect.sync(() => socket.destroy())
          }))
        if (!refused) {
          return yield* Effect.fail(
            connectionError(
              new Error(
                'A terminal host socket exists without a valid discovery record. Treeport will not connect to, unlink, or replace it.'
              )
            )
          )
        }

        yield* nodePromise(() => fs.rm(paths.socketPath, { force: true }))
      }

      token = yield* readOrCreateToken(paths.tokenPath)
    }

    const hostId = crypto.randomUUID()
    const sessionExecutable = yield* nodePromise(() =>
      prepareSessionKeeper(
        options.sessionExecutable,
        path.join(paths.hostRuntimeDir, 'keepers')
      )
    )
    // Workers die with the daemon; only raw PTY keepers detach. Keep emulator
    // parsing and snapshots off the HTTP/browser-control event loop.
    yield* startTerminalEngineWorker(
      options.engineWorkerPath,
      {
        runtimeDir: paths.hostRuntimeDir,
        launcherPath: options.launcherPath,
        sessionExecutable,
        journalLimitBytes: options.journalLimitBytes,
        hostId,
        hostKey: paths.hostKey,
        token,
        socketPath: paths.socketPath,
        recordPath: paths.recordPath
      },
      options.environment ?? process.env
    )
    return yield* TerminalHostClient.connect(
      paths.socketPath,
      token,
      paths.hostKey,
      hostId
    )
  })
}
