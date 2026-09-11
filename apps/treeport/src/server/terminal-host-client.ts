import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
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
  TERMINAL_HOST_PROTOCOL_VERSION,
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
} from './terminal-host-protocol'

const TERMINAL_HOST_REQUEST_TIMEOUT_MS = 30_000
const TERMINAL_HOST_START_TIMEOUT_MS = 10_000

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
}

type PendingRequest = Deferred.Deferred<
  TerminalHostResult,
  TerminalHostClientError
>

export interface TerminalHostClientOptions {
  readonly dataDir: string
  readonly runtimeDir: string
  readonly launcherPath: string
  readonly hostEntryPath: string
  readonly hostExecutable?: string
  readonly hostArguments?: string[]
  readonly environment?: NodeJS.ProcessEnv
  readonly spawnHost?: typeof spawn
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
  const ipcDirectory = path.join(
    os.tmpdir(),
    `treeport-${process.getuid?.() ?? 'user'}`
  )
  return {
    hostKey,
    socketPath: path.join(ipcDirectory, `terminal-${hostKey}.sock`),
    recordPath: path.join(runtimeDir, `terminal-host-${hostKey}.json`),
    tokenPath: path.join(dataDir, 'terminal-host.token'),
    hostRuntimeDir: path.join(runtimeDir, `terminal-host-${hostKey}`)
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

function readRecord(
  recordPath: string
): Effect.Effect<TerminalHostRecord | null> {
  return nodePromise<unknown>(async () =>
    JSON.parse(await fs.readFile(recordPath, 'utf8'))
  ).pipe(
    Effect.flatMap(decodeTerminalHostRecord),
    Effect.catchAll(() => Effect.succeed(null))
  )
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
    ['AUTH_FAILED', 'HOST_MISMATCH', 'INCOMPATIBLE_PROTOCOL'].includes(
      error.code
    )
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

/** Scoped daemon-side connection to one detached terminal host. */
export class TerminalHostClient
  implements TerminalSessionBackend, TerminalAttachmentBackend
{
  private constructor(
    readonly record: TerminalHostRecord,
    private readonly outgoing: Queue.Queue<Buffer>,
    private readonly pending: SynchronizedRef.SynchronizedRef<
      ReadonlyMap<string, PendingRequest>
    >,
    private readonly outputRoutes: Map<string, OutputRoute>,
    private readonly runtimeRoutes: Map<string, RuntimeRoute>,
    private readonly routeMutex: Effect.Semaphore,
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
    expectedHostId?: string
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
      const routeMutex = yield* Effect.makeSemaphore(1)
      const provisionalRecord: TerminalHostRecord = {
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
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
        routeMutex,
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
                        const explicitProtocolFailure =
                          frame.type === 'response' &&
                          frame.error?.code === 'INCOMPATIBLE_PROTOCOL'
                        if (
                          frame.protocolVersion !==
                            TERMINAL_HOST_PROTOCOL_VERSION &&
                          !explicitProtocolFailure
                        ) {
                          return client.closeWith(
                            new TerminalHostRequestError({
                              code: 'INCOMPATIBLE_PROTOCOL',
                              message: `Terminal host sent protocol ${frame.protocolVersion}; daemon expects ${TERMINAL_HOST_PROTOCOL_VERSION}`,
                              hostProtocolVersion: frame.protocolVersion
                            })
                          )
                        }

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

      const handshake = yield* client.request('handshake', {
        token,
        hostKey,
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION
      })
      if (expectedHostId && handshake.hostId !== expectedHostId) {
        return yield* Effect.fail(
          new TerminalHostRequestError({
            code: 'HOST_MISMATCH',
            message:
              'The terminal host identifier differs from its discovery record'
          })
        )
      }

      client.supportsTraceContext = handshake.traceContext === true
      Object.assign(client.record, handshake)
      return client
    })
  }

  private supportsTraceContext = false

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
    return this.routeMutex.withPermits(1)(
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

        const ownedRoute = route
        yield* Effect.addFinalizer(() =>
          this.releaseOutputRoute(terminalId, ownedRoute)
        )
        const subscription = yield* PubSub.subscribe(route.pubsub)
        const snapshot = yield* this.request('attach', { terminalId }, trace)
        if (!snapshot) {
          return null
        }

        return {
          ...snapshot,
          links: snapshot.links ?? [],
          images: snapshot.images ?? null,
          output: Stream.fromQueue(subscription).pipe(
            Stream.filter((event) => event.sequence > snapshot.fence)
          )
        }
      })
    )
  }

  runtimeEvents(
    terminalId: string
  ): Stream.Stream<TerminalHostRuntimeEvent, TerminalHostClientError> {
    return Stream.unwrapScoped(
      this.routeMutex.withPermits(1)(
        Effect.gen(this, function* () {
          let route = this.runtimeRoutes.get(terminalId)
          const first = !route
          if (!route) {
            route = {
              pubsub: yield* PubSub.unbounded<TerminalHostRuntimeEvent>(),
              references: 0
            }
            this.runtimeRoutes.set(terminalId, route)
          }

          route.references += 1
          const ownedRoute = route
          yield* Effect.addFinalizer(() =>
            this.releaseRuntimeRoute(terminalId, ownedRoute)
          )
          if (first) {
            yield* this.request('subscribeRuntime', { terminalId })
          }

          const subscription = yield* PubSub.subscribe(route.pubsub)
          return Stream.fromQueue(subscription)
        })
      )
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
    return this.request('activateQueryAuthority', {
      terminalId,
      transitionId,
      attachmentId,
      generation,
      cellSize
    }).pipe(Effect.asVoid)
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

  killWorktree(worktreeId: string) {
    return this.request('killWorktree', { worktreeId })
  }

  shutdownIfEmpty() {
    return this.request('shutdown', { ifEmpty: true }).pipe(Effect.asVoid)
  }

  private request<Method extends keyof TerminalHostResults>(
    method: Method,
    input: TerminalHostRequestInput<Method>,
    trace?: TerminalTraceContext
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
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
        type: 'request',
        id,
        method,
        input
      }
      if (trace && this.supportsTraceContext) {
        frame.trace = trace
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
        Effect.timeoutFail({
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

  private releaseOutputRoute(
    terminalId: string,
    route: OutputRoute
  ): Effect.Effect<void> {
    return this.routeMutex.withPermits(1)(
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
    return this.routeMutex.withPermits(1)(
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

/** Acquires an existing host or safely starts and connects to a detached one. */
export function connectOrStartTerminalHost(
  options: TerminalHostClientOptions
): Effect.Effect<TerminalHostClient, TerminalHostClientError, Scope.Scope> {
  return Effect.gen(function* () {
    const paths = terminalHostPaths(options.dataDir, options.runtimeDir)
    yield* Effect.all(
      [
        nodePromise(() =>
          fs.mkdir(options.dataDir, { recursive: true, mode: 0o700 })
        ),
        nodePromise(() =>
          fs.mkdir(options.runtimeDir, { recursive: true, mode: 0o700 })
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
    const token = yield* readOrCreateToken(paths.tokenPath)
    const record = yield* readRecord(paths.recordPath)

    if (record) {
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

      if (
        record.hostKey === paths.hostKey &&
        record.socketPath === paths.socketPath &&
        isStaleSocketFailure(failure)
      ) {
        yield* Effect.all(
          [
            nodePromise(() => fs.rm(paths.recordPath, { force: true })),
            nodePromise(() => fs.rm(paths.socketPath, { force: true }))
          ],
          { discard: true }
        )
      } else if (
        record.hostKey !== paths.hostKey ||
        record.socketPath !== paths.socketPath
      ) {
        return yield* Effect.fail(
          connectionError(
            new Error('The terminal host discovery record is invalid')
          )
        )
      } else {
        return yield* Effect.fail(
          connectionError(
            new Error(
              'The terminal host socket answered unexpectedly. Treeport will not replace it.'
            )
          )
        )
      }
    } else {
      const connected = yield* Effect.either(
        TerminalHostClient.connect(paths.socketPath, token, paths.hostKey)
      )
      if (Either.isRight(connected)) {
        return connected.right
      }

      const failure = connected.left
      if (isDefinitiveConnectionFailure(failure)) {
        return yield* Effect.fail(failure)
      }

      if (!isStaleSocketFailure(failure)) {
        return yield* Effect.fail(
          connectionError(
            new Error(
              'An unidentified terminal host socket answered unexpectedly. Treeport will not replace it.'
            )
          )
        )
      }

      yield* nodePromise(() => fs.rm(paths.socketPath, { force: true }))
    }

    const hostId = crypto.randomUUID()
    const spawnHost = options.spawnHost ?? spawn
    const child: ChildProcess = yield* Effect.try({
      try: () =>
        spawnHost(
          options.hostExecutable ?? process.execPath,
          [...(options.hostArguments ?? []), options.hostEntryPath],
          {
            detached: true,
            stdio: 'ignore',
            env: {
              ...(options.environment ?? process.env),
              TREEPORT_TERMINAL_HOST_RUNTIME_DIR: paths.hostRuntimeDir,
              TREEPORT_TERMINAL_HOST_LAUNCHER: options.launcherPath,
              TREEPORT_TERMINAL_HOST_ID: hostId,
              TREEPORT_TERMINAL_HOST_KEY: paths.hostKey,
              TREEPORT_TERMINAL_HOST_TOKEN: token,
              TREEPORT_TERMINAL_HOST_SOCKET: paths.socketPath,
              TREEPORT_TERMINAL_HOST_RECORD: paths.recordPath
            }
          }
        ),
      catch: connectionError
    })
    child.unref()

    const childExit = yield* Deferred.make<never, TerminalHostClientError>()
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const onError = (cause: Error) =>
          Deferred.unsafeDone(childExit, Effect.fail(connectionError(cause)))
        const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
          Deferred.unsafeDone(
            childExit,
            Effect.fail(
              connectionError(
                new Error(
                  `Terminal host exited before startup (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
                )
              )
            )
          )
        child.once('error', onError)
        child.once('exit', onExit)
        return { onError, onExit }
      }),
      () => {
        const connect = Effect.gen(function* () {
          const deadline = Date.now() + TERMINAL_HOST_START_TIMEOUT_MS
          let lastError: TerminalHostClientError = connectionError(
            new Error('The terminal host socket is unavailable')
          )
          while (Date.now() < deadline) {
            const connected = yield* Effect.either(
              TerminalHostClient.connect(
                paths.socketPath,
                token,
                paths.hostKey,
                hostId
              )
            )
            if (Either.isRight(connected)) {
              return connected.right
            }

            lastError = connected.left
            if (isDefinitiveConnectionFailure(lastError)) {
              return yield* Effect.fail(lastError)
            }

            yield* Effect.sleep(50)
          }
          return yield* Effect.fail(
            connectionError(
              new Error(
                `Terminal host did not start: ${
                  lastError instanceof Error
                    ? lastError.message
                    : String(lastError)
                }`
              )
            )
          )
        })
        return Effect.raceFirst(connect, Deferred.await(childExit))
      },
      ({ onError, onExit }) =>
        Effect.sync(() => {
          child.off('error', onError)
          child.off('exit', onExit)
        })
    )
  })
}
