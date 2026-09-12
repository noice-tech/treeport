import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SerializeAddon } from '@xterm/addon-serialize'
import xtermHeadless from '@xterm/headless'
import type { IDisposable, IPty } from 'node-pty'
import * as pty from 'node-pty'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FiberSet from 'effect/FiberSet'
import * as PubSub from 'effect/PubSub'
import * as Queue from 'effect/Queue'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as SynchronizedRef from 'effect/SynchronizedRef'
import {
  parseTerminalProgress,
  TERMINAL_PROGRESS_STALE_MS,
  type HostedTerminal,
  type TerminalCreateInput,
  type TerminalHostOutput,
  type TerminalHostRuntimeEvent,
  type TerminalHostSnapshot,
  type TerminalImageSnapshot,
  type TerminalLaunchSpec,
  type TerminalProcess,
  type TerminalProgress,
  type TerminalSessionState,
  type TerminalSnapshotLink,
  type TerminalTitleState
} from './contract'
import { TerminalImages } from './images'
import {
  integrateShellLaunch,
  prepareShellIntegration
} from './shell-integration'

export type { TerminalHostRuntimeEvent } from './contract'

const { Terminal } = xtermHeadless
const HOST_SCROLLBACK_LINES = 50_000
const HOST_PARSER_HIGH_WATERMARK = 1024 * 1024
const HOST_PARSER_LOW_WATERMARK = 256 * 1024
const PROCESS_TREE_KILL_GRACE_MS = 500

type HeadlessTerminal = InstanceType<typeof Terminal>
type TerminalHostAttachment = TerminalHostSnapshot & {
  output: Stream.Stream<TerminalHostOutput, unknown>
}

type PtySpawner = typeof pty.spawn
type ProcessTreeTerminator = (child: IPty) => Effect.Effect<void, unknown>

interface SshAgentDiscovery {
  readonly platform: NodeJS.Platform
  readonly launchctlPath: string
}

export class TerminalHostSessionError extends Data.TaggedError(
  'TerminalHostSessionError'
)<{ readonly message: string; readonly cause?: unknown }> {}

interface HeadlessTerminalInternals {
  _core: {
    _oscLinkService: {
      getLinkData(id: number): { uri: string } | undefined
    }
  }
}

interface HeadlessCellInternals {
  extended?: { urlId?: number }
}

type ParserCommand =
  | {
      readonly _tag: 'Output'
      readonly data: string
      readonly sequence: number
      readonly bytes: number
    }
  | {
      readonly _tag: 'Fence'
      readonly completed: Deferred.Deferred<void, TerminalHostSessionError>
    }
  | { readonly _tag: 'Stop' }

type RuntimeCommand =
  | { readonly _tag: 'Title'; readonly title: string }
  | { readonly _tag: 'TitleState'; readonly value: TerminalTitleState }
  | { readonly _tag: 'Progress'; readonly value: TerminalProgress | null }
  | { readonly _tag: 'Bell' }
  | { readonly _tag: 'Exit'; readonly exitCode: number }

interface PauseLease {
  readonly release: Effect.Effect<void>
}

interface HostedTerminalSession extends HostedTerminal {
  readonly cwd: string
  readonly specPath: string | null
  title: string | null
  commandLine: string | null
  progress: TerminalProgress | null
  progressFiber: Fiber.RuntimeFiber<void, never> | null
  bellSequence: number
  lastBellAt: string | null
  readonly pty: IPty
  readonly terminal: HeadlessTerminal
  readonly serializer: SerializeAddon
  readonly images: TerminalImages
  readonly scope: Scope.CloseableScope
  readonly parserCommands: Queue.Queue<ParserCommand>
  readonly runtimeCommands: Queue.Queue<RuntimeCommand>
  readonly output: PubSub.PubSub<TerminalHostOutput>
  readonly runtime: PubSub.PubSub<TerminalHostRuntimeEvent>
  readonly pendingFences: Set<Deferred.Deferred<void, TerminalHostSessionError>>
  outputSequence: number
  parserQueuedBytes: number
  parserPaused: boolean
  boundaryPauseCount: number
  queryAuthorityAttachmentId: string | null
  queryAuthorityGeneration: number | null
  queryTransition: { id: string; lease: PauseLease } | null
}

interface PendingCleanup {
  readonly worktreeId: string
  readonly completed: Deferred.Deferred<void, unknown>
}

export interface TerminalHostSessionsOptions {
  readonly runtimeDir: string
  readonly launcherPath: string
  readonly spawnPty?: PtySpawner
  readonly terminateProcessTree?: ProcessTreeTerminator
  readonly progressStaleMs?: number
  readonly sshAgentDiscovery?: SshAgentDiscovery
}

function effectError(cause: unknown): TerminalHostSessionError {
  return new TerminalHostSessionError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause
  })
}

function nodePromise<A>(evaluate: () => Promise<A>) {
  return Effect.tryPromise({ try: evaluate, catch: effectError })
}

function execFileEffect(
  executable: string,
  args: readonly string[],
  options?: Parameters<typeof execFile>[2]
): Effect.Effect<string, TerminalHostSessionError> {
  return Effect.async<string, TerminalHostSessionError>((resume) => {
    const child = execFile(
      executable,
      [...args],
      options ?? {},
      (error, stdout) =>
        resume(
          error
            ? Effect.fail(effectError(error))
            : Effect.succeed(String(stdout))
        )
    )
    return Effect.sync(() => child.kill('SIGKILL'))
  })
}

function processSignal(pid: number, signal: NodeJS.Signals) {
  return Effect.try({
    try: () => {
      process.kill(pid, signal)
      return true
    },
    catch: (cause) => cause
  }).pipe(
    Effect.catchAll((cause) =>
      // SAFETY: process.kill failures use Node's ErrnoException shape.
      (cause as NodeJS.ErrnoException).code === 'ESRCH'
        ? Effect.succeed(false)
        : Effect.fail(cause)
    )
  )
}

function descendantPids(rootPid: number): Effect.Effect<number[]> {
  return execFileEffect('ps', ['-axo', 'pid=,ppid=']).pipe(
    Effect.map((stdout) => {
      const rows = stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/u).map(Number))
        .filter(
          (row): row is [number, number] =>
            row.length === 2 && row.every(Number.isInteger)
        )
      const children = new Map<number, number[]>()
      for (const [pid, parentPid] of rows) {
        children.set(parentPid, [...(children.get(parentPid) ?? []), pid])
      }
      const descendants: number[] = []
      const pending = [...(children.get(rootPid) ?? [])]
      while (pending.length) {
        const pid = pending.pop()!
        descendants.push(pid)
        pending.push(...(children.get(pid) ?? []))
      }
      return descendants
    }),
    Effect.catchAll(() => Effect.succeed([]))
  )
}

const terminatePtyProcessTree: ProcessTreeTerminator = (child) =>
  Effect.gen(function* () {
    const descendants = yield* descendantPids(child.pid)
    const signalTree = (signal: NodeJS.Signals) =>
      Effect.gen(function* () {
        const groupSignaled = yield* processSignal(-child.pid, signal)
        yield* Effect.forEach([...descendants].reverse(), (pid) =>
          processSignal(pid, signal)
        )
        if (!groupSignaled) {
          yield* Effect.sync(() => child.kill(signal))
        }
      })

    yield* signalTree('SIGTERM')
    yield* Effect.sleep(PROCESS_TREE_KILL_GRACE_MS)
    yield* signalTree('SIGKILL')
  })

/**
 * Scoped detached owner of PTYs and their canonical headless emulators.
 * The separate process is intentional: node-pty process handles, parser
 * history, output fences, image uploads, and query authority are in-memory
 * state that the replacing daemon cannot reconstruct from an OS process ID.
 */
export class TerminalHostSessions {
  readonly shellIntegrationDir: string

  private constructor(
    private readonly options: Required<
      Pick<
        TerminalHostSessionsOptions,
        | 'runtimeDir'
        | 'launcherPath'
        | 'spawnPty'
        | 'terminateProcessTree'
        | 'progressStaleMs'
        | 'sshAgentDiscovery'
      >
    >,
    private readonly sessions: SynchronizedRef.SynchronizedRef<
      ReadonlyMap<string, HostedTerminalSession | null>
    >,
    private readonly cleanups: FiberSet.FiberSet<void, never>,
    private readonly pendingCleanups: Set<PendingCleanup>
  ) {
    this.shellIntegrationDir = path.join(
      options.runtimeDir,
      'terminal-shell-integration'
    )
  }

  static make(
    options: TerminalHostSessionsOptions
  ): Effect.Effect<
    TerminalHostSessions,
    TerminalHostSessionError,
    Scope.Scope
  > {
    return Effect.gen(function* () {
      const resolved = {
        runtimeDir: options.runtimeDir,
        launcherPath: options.launcherPath,
        spawnPty: options.spawnPty ?? pty.spawn,
        terminateProcessTree:
          options.terminateProcessTree ?? terminatePtyProcessTree,
        progressStaleMs: options.progressStaleMs ?? TERMINAL_PROGRESS_STALE_MS,
        sshAgentDiscovery: options.sshAgentDiscovery ?? {
          platform: process.platform,
          launchctlPath: '/bin/launchctl'
        }
      }
      const sessions = yield* SynchronizedRef.make<
        ReadonlyMap<string, HostedTerminalSession | null>
      >(new Map())
      const cleanups = yield* FiberSet.make<void, never>()
      const manager = new TerminalHostSessions(
        resolved,
        sessions,
        cleanups,
        new Set()
      )
      yield* manager.initialize()
      yield* Effect.addFinalizer(() => manager.shutdown().pipe(Effect.orDie))
      return manager
    })
  }

  initialize(): Effect.Effect<boolean, TerminalHostSessionError> {
    return Effect.all(
      [
        nodePromise(() =>
          fs.mkdir(path.join(this.options.runtimeDir, 'terminal-specs'), {
            recursive: true,
            mode: 0o700
          })
        ),
        nodePromise(() => prepareShellIntegration(this.shellIntegrationDir))
      ],
      { discard: true }
    ).pipe(Effect.as(true))
  }

  get sessionCount(): Effect.Effect<number> {
    return SynchronizedRef.get(this.sessions).pipe(
      Effect.map(
        (sessions) =>
          [...sessions.values()].filter(
            (session): session is HostedTerminalSession => session !== null
          ).length
      )
    )
  }

  createTerminal(
    input: TerminalCreateInput
  ): Effect.Effect<void, TerminalHostSessionError> {
    return Effect.gen(this, function* () {
      const reserved = yield* SynchronizedRef.modify(
        this.sessions,
        (current) => {
          if (current.has(input.terminalId)) {
            return [false, current] as const
          }

          const next = new Map(current)
          next.set(input.terminalId, null)
          return [true, next] as const
        }
      )
      if (!reserved) {
        return yield* Effect.fail(
          new TerminalHostSessionError({
            message: `Terminal already exists: ${input.terminalId}`
          })
        )
      }

      const childScope = yield* Scope.make()
      let session: HostedTerminalSession | null = null
      let retained = false
      return yield* Effect.gen(this, function* () {
        session = yield* Scope.extend(
          this.acquireSession(input, childScope),
          childScope
        )
        const ownedSession = session
        const dataDisposable = yield* Effect.try({
          try: () =>
            ownedSession.pty.onData((data) => {
              const bytes = Buffer.byteLength(data)
              ownedSession.parserQueuedBytes += bytes
              const offered = Queue.unsafeOffer(ownedSession.parserCommands, {
                _tag: 'Output',
                data,
                sequence: ++ownedSession.outputSequence,
                bytes
              })
              if (!offered) {
                ownedSession.parserQueuedBytes = Math.max(
                  0,
                  ownedSession.parserQueuedBytes - bytes
                )
                return
              }

              if (
                !ownedSession.parserPaused &&
                ownedSession.parserQueuedBytes >= HOST_PARSER_HIGH_WATERMARK
              ) {
                ownedSession.parserPaused = true
                ownedSession.pty.pause()
              }
            }),
          catch: effectError
        })
        yield* Scope.addFinalizer(
          childScope,
          Effect.sync(() => dataDisposable.dispose())
        )
        const exitDisposable = yield* Effect.try({
          try: () =>
            ownedSession.pty.onExit(({ exitCode }) => {
              ownedSession.status = 'exited'
              ownedSession.exitCode = exitCode
              ownedSession.updatedAt = new Date().toISOString()
              Queue.unsafeOffer(ownedSession.runtimeCommands, {
                _tag: 'Exit',
                exitCode
              })
            }),
          catch: effectError
        })
        yield* Scope.addFinalizer(
          childScope,
          Effect.sync(() => exitDisposable.dispose())
        )

        const installed = yield* SynchronizedRef.modify(
          this.sessions,
          (current) => {
            if (current.get(input.terminalId) !== null) {
              return [false, current] as const
            }

            const next = new Map(current)
            next.set(input.terminalId, ownedSession)
            return [true, next] as const
          }
        )
        if (!installed) {
          return yield* Effect.fail(
            new TerminalHostSessionError({
              message: 'Terminal reservation was lost'
            })
          )
        }

        retained = true
      }).pipe(
        Effect.onExit((exit) =>
          retained ? Effect.void : Scope.close(childScope, exit)
        ),
        Effect.ensuring(
          Effect.suspend(() =>
            retained
              ? Effect.void
              : SynchronizedRef.update(this.sessions, (current) => {
                  const value = current.get(input.terminalId)
                  if (value !== null && value !== session) {
                    return current
                  }

                  const next = new Map(current)
                  next.delete(input.terminalId)
                  return next
                })
          )
        )
      )
    })
  }

  private acquireSession(
    input: TerminalCreateInput,
    childScope: Scope.CloseableScope
  ): Effect.Effect<HostedTerminalSession, TerminalHostSessionError> {
    return Effect.gen(this, function* () {
      const directShell =
        input.interactiveShell &&
        input.shellCommand === null &&
        !input.initialTitle &&
        !input.fallbackArgv &&
        !input.setupTasks?.length &&
        !input.setupError
      let specPath: string | null = null
      if (!directShell) {
        const spec: TerminalLaunchSpec = {
          argv: [...input.argv],
          cwd: input.cwd,
          env: { ...input.env },
          shellIntegrationDir: this.shellIntegrationDir
        }

        if (input.initialTitle !== undefined) {
          spec.initialTitle = input.initialTitle
        }

        if (input.fallbackArgv !== undefined) {
          spec.fallbackArgv = [...input.fallbackArgv]
        }

        if (input.setupTasks !== undefined) {
          spec.setupTasks = input.setupTasks.map((task) => ({
            ...task,
            argv: [...task.argv],
            env: { ...task.env }
          }))
        }

        if (input.setupError !== undefined) {
          spec.setupError = input.setupError
        }

        specPath = path.join(
          this.options.runtimeDir,
          'terminal-specs',
          `${input.terminalId}-${crypto.randomUUID()}.json`
        )
        yield* nodePromise(() =>
          fs.writeFile(specPath!, JSON.stringify(spec), { mode: 0o600 })
        )
        yield* Scope.addFinalizer(
          childScope,
          nodePromise(() => fs.rm(specPath!, { force: true })).pipe(
            Effect.catchAll((cause) =>
              Effect.logError('Failed to remove terminal launch spec').pipe(
                Effect.annotateLogs({ path: specPath!, cause: cause.message })
              )
            )
          )
        )
      }

      const size = input.initialSize ?? { cols: 100, rows: 30 }
      const inheritedEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
      inheritedEnvironment.TERM = 'xterm-256color'
      if (
        this.options.sshAgentDiscovery.platform === 'darwin' &&
        inheritedEnvironment.SSH_AUTH_SOCK === undefined &&
        input.env.SSH_AUTH_SOCK === undefined
      ) {
        yield* execFileEffect(
          this.options.sshAgentDiscovery.launchctlPath,
          ['getenv', 'SSH_AUTH_SOCK'],
          { timeout: 1_000, killSignal: 'SIGKILL', maxBuffer: 4_096 }
        ).pipe(
          Effect.flatMap((stdout) => {
            const socket = stdout.trim()
            if (!socket) {
              return Effect.void
            }

            if (!path.isAbsolute(socket) || /\p{Cc}/u.test(socket)) {
              return Effect.fail(
                new TerminalHostSessionError({
                  message: 'Invalid launchd SSH agent socket'
                })
              )
            }

            return nodePromise(() => fs.stat(socket)).pipe(
              Effect.filterOrFail(
                (stats) => stats.isSocket(),
                () =>
                  new TerminalHostSessionError({
                    message: 'Invalid launchd SSH agent socket'
                  })
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  inheritedEnvironment.SSH_AUTH_SOCK = socket
                })
              ),
              Effect.asVoid
            )
          }),
          Effect.catchAll(() =>
            Effect.logWarning(
              'Could not discover the macOS SSH agent; continuing without SSH_AUTH_SOCK'
            )
          )
        )
      }

      const directLaunch = integrateShellLaunch(
        input.argv,
        { ...inheritedEnvironment, ...input.env },
        this.shellIntegrationDir,
        directShell
      )
      const directEnvironment = Object.fromEntries(
        Object.entries(directLaunch.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
      const terminal = new Terminal({
        cols: size.cols,
        rows: size.rows,
        scrollback: HOST_SCROLLBACK_LINES,
        allowProposedApi: true,
        disableStdin: false
      })
      yield* Scope.addFinalizer(
        childScope,
        Effect.sync(() => terminal.dispose())
      )
      const serializer = new SerializeAddon()
      // SAFETY: @xterm/headless accepts the browser addon's shared IAddon contract at runtime.
      terminal.loadAddon(serializer as never)
      yield* Scope.addFinalizer(
        childScope,
        Effect.sync(() => serializer.dispose())
      )
      const images = new TerminalImages(true)
      // SAFETY: TerminalImages implements the xterm addon lifecycle expected by loadAddon.
      terminal.loadAddon(images as never)

      const child = yield* Effect.try({
        try: () =>
          directShell
            ? this.options.spawnPty(
                directLaunch.argv[0]!,
                directLaunch.argv.slice(1),
                {
                  name: 'xterm-256color',
                  cols: size.cols,
                  rows: size.rows,
                  cwd: input.cwd,
                  env: directEnvironment
                }
              )
            : this.options.spawnPty(
                process.execPath,
                [this.options.launcherPath, specPath!],
                {
                  name: 'xterm-256color',
                  cols: size.cols,
                  rows: size.rows,
                  cwd: input.cwd,
                  env: inheritedEnvironment
                }
              ),
        catch: effectError
      })
      const parserCommands = yield* Queue.unbounded<ParserCommand>()
      const runtimeCommands = yield* Queue.unbounded<RuntimeCommand>()
      const output = yield* PubSub.unbounded<TerminalHostOutput>()
      const runtime = yield* PubSub.unbounded<TerminalHostRuntimeEvent>()
      yield* Scope.addFinalizer(
        childScope,
        Effect.all(
          [
            Queue.shutdown(parserCommands),
            Queue.shutdown(runtimeCommands),
            PubSub.shutdown(output),
            PubSub.shutdown(runtime)
          ],
          { discard: true }
        )
      )

      const session: HostedTerminalSession = {
        id: input.terminalId,
        worktreeId: input.worktreeId,
        name: input.name,
        argv: [...input.argv],
        shellCommand: input.shellCommand,
        interactiveShell: input.interactiveShell,
        closeOnSuccess: input.closeOnSuccess ?? false,
        status: 'running',
        exitCode: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        cwd: input.cwd,
        specPath,
        title: input.initialTitle ?? null,
        commandLine: input.initialTitle ?? null,
        progress: null,
        progressFiber: null,
        bellSequence: 0,
        lastBellAt: null,
        pty: child,
        terminal,
        serializer,
        images,
        scope: childScope,
        parserCommands,
        runtimeCommands,
        output,
        runtime,
        pendingFences: new Set(),
        outputSequence: 0,
        parserQueuedBytes: 0,
        parserPaused: false,
        boundaryPauseCount: 0,
        queryAuthorityAttachmentId: null,
        queryAuthorityGeneration: null,
        queryTransition: null
      }

      const terminalDisposables: IDisposable[] = [
        terminal.onData((data) => {
          if (
            session.status === 'running' &&
            session.queryAuthorityAttachmentId === null
          ) {
            session.pty.write(data)
          }
        }),
        terminal.onTitleChange((title) => {
          Queue.unsafeOffer(runtimeCommands, { _tag: 'Title', title })
        }),
        terminal.onBell(() => {
          Queue.unsafeOffer(runtimeCommands, { _tag: 'Bell' })
        }),
        terminal.parser.registerOscHandler(777, (payload) => {
          if (!payload.startsWith('command;')) {
            return false
          }

          session.commandLine =
            payload
              .slice('command;'.length)
              .replace(/\p{Cc}/gu, '')
              .trim()
              .slice(0, 256) || null
          Queue.unsafeOffer(runtimeCommands, {
            _tag: 'TitleState',
            value: {
              terminalTitle: session.title,
              currentCommand: session.pty.process || null,
              commandLine: session.commandLine
            }
          })
          return true
        }),
        terminal.parser.registerOscHandler(9, (payload) => {
          const progress = parseTerminalProgress(payload)
          if (progress === undefined) {
            return false
          }

          Queue.unsafeOffer(runtimeCommands, {
            _tag: 'Progress',
            value: progress
          })
          return true
        })
      ]
      yield* Scope.addFinalizer(
        childScope,
        Effect.sync(() => {
          for (const disposable of terminalDisposables) {
            disposable.dispose()
          }
        })
      )
      yield* Scope.addFinalizer(
        childScope,
        Effect.gen(function* () {
          if (session.progressFiber) {
            yield* Fiber.interrupt(session.progressFiber)
            session.progressFiber = null
          }

          if (session.queryTransition) {
            yield* session.queryTransition.lease.release
            session.queryTransition = null
          }

          const unavailable = new TerminalHostSessionError({
            message: 'Terminal is unavailable'
          })
          for (const fence of session.pendingFences) {
            yield* Deferred.fail(fence, unavailable)
          }
          session.pendingFences.clear()
        })
      )

      yield* Effect.forkIn(this.parserWorker(session), childScope)
      yield* Effect.forkIn(this.runtimeWorker(session), childScope)
      return session
    })
  }

  private parserWorker(session: HostedTerminalSession): Effect.Effect<void> {
    return Effect.forever(
      Effect.gen(this, function* () {
        const command = yield* Queue.take(session.parserCommands)
        if (command._tag === 'Stop') {
          return yield* Effect.interrupt
        }

        if (command._tag === 'Fence') {
          session.pendingFences.delete(command.completed)
          yield* Deferred.succeed(command.completed, undefined)
          return
        }

        yield* Effect.async<void>((resume) => {
          session.terminal.write(command.data, () => resume(Effect.void))
        })

        session.parserQueuedBytes = Math.max(
          0,
          session.parserQueuedBytes - command.bytes
        )
        yield* PubSub.publish(session.output, {
          data: command.data,
          sequence: command.sequence
        })
        if (
          session.parserPaused &&
          session.parserQueuedBytes <= HOST_PARSER_LOW_WATERMARK
        ) {
          session.parserPaused = false
          if (
            session.boundaryPauseCount === 0 &&
            session.status === 'running'
          ) {
            session.pty.resume()
          }
        }
      })
    )
  }

  private runtimeWorker(session: HostedTerminalSession): Effect.Effect<void> {
    return Effect.forever(
      Effect.gen(this, function* () {
        const command = yield* Queue.take(session.runtimeCommands)
        switch (command._tag) {
          case 'Title':
            session.title = command.title
            yield* PubSub.publish(session.runtime, {
              title: command.title,
              titleState: {
                terminalTitle: command.title,
                currentCommand: session.pty.process || null,
                commandLine: session.commandLine
              }
            })
            return
          case 'TitleState':
            yield* PubSub.publish(session.runtime, {
              titleState: command.value
            })
            return
          case 'Bell':
            session.bellSequence += 1
            session.lastBellAt = new Date().toISOString()
            yield* PubSub.publish(session.runtime, {
              bell: { sequence: session.bellSequence, at: session.lastBellAt }
            })
            return
          case 'Progress':
            if (session.progressFiber) {
              yield* Fiber.interrupt(session.progressFiber)
              session.progressFiber = null
            }

            session.progress = command.value
            yield* PubSub.publish(session.runtime, { progress: command.value })
            if (command.value !== null) {
              session.progressFiber = yield* Effect.forkIn(
                Effect.sleep(this.options.progressStaleMs).pipe(
                  Effect.zipRight(
                    Effect.sync(() => {
                      session.progress = null
                    })
                  ),
                  Effect.zipRight(
                    PubSub.publish(session.runtime, { progress: null })
                  ),
                  Effect.asVoid
                ),
                session.scope
              )
            }

            return
          case 'Exit':
            if (session.progressFiber) {
              yield* Fiber.interrupt(session.progressFiber)
              session.progressFiber = null
            }

            session.progress = null
            session.status = 'exited'
            session.exitCode = command.exitCode
            session.updatedAt = new Date().toISOString()
            if (session.specPath) {
              yield* nodePromise(() =>
                fs.rm(session.specPath!, { force: true })
              ).pipe(
                Effect.catchAll((cause) =>
                  Effect.logError('Failed to remove terminal launch spec').pipe(
                    Effect.annotateLogs({
                      path: session.specPath!,
                      cause: cause.message
                    })
                  )
                )
              )
            }

            yield* PubSub.publish(session.runtime, {
              exitCode: command.exitCode
            })
        }
      })
    )
  }

  private session(
    terminalId: string
  ): Effect.Effect<HostedTerminalSession | null> {
    return SynchronizedRef.get(this.sessions).pipe(
      Effect.map((sessions) => sessions.get(terminalId) ?? null)
    )
  }

  private requireSession(
    terminalId: string
  ): Effect.Effect<HostedTerminalSession, TerminalHostSessionError> {
    return this.session(terminalId).pipe(
      Effect.filterOrFail(
        (session): session is HostedTerminalSession => session !== null,
        () =>
          new TerminalHostSessionError({ message: 'Terminal is unavailable' })
      )
    )
  }

  private makePauseLease(session: HostedTerminalSession): PauseLease {
    session.boundaryPauseCount += 1
    if (session.boundaryPauseCount === 1) {
      session.pty.pause()
    }

    let active = true
    return {
      release: Effect.sync(() => {
        if (!active) {
          return
        }

        active = false
        session.boundaryPauseCount = Math.max(0, session.boundaryPauseCount - 1)
        if (
          session.status === 'running' &&
          session.boundaryPauseCount === 0 &&
          !session.parserPaused
        ) {
          session.pty.resume()
        }
      })
    }
  }

  private drainParser(
    session: HostedTerminalSession
  ): Effect.Effect<void, TerminalHostSessionError> {
    return Effect.gen(function* () {
      const completed = yield* Deferred.make<void, TerminalHostSessionError>()
      session.pendingFences.add(completed)
      const offered = yield* Queue.offer(session.parserCommands, {
        _tag: 'Fence',
        completed
      })
      if (!offered) {
        session.pendingFences.delete(completed)
        return yield* Effect.fail(
          new TerminalHostSessionError({ message: 'Terminal parser is closed' })
        )
      }

      return yield* Deferred.await(completed)
    })
  }

  private withBoundary<A, E, R>(
    session: HostedTerminalSession,
    operation: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> {
    return Effect.acquireUseRelease(
      Effect.sync(() => this.makePauseLease(session)),
      () => operation,
      (lease) => lease.release
    )
  }

  size(
    terminalId: string
  ): Effect.Effect<{ cols: number; rows: number } | null> {
    return this.session(terminalId).pipe(
      Effect.map((session) =>
        session
          ? { cols: session.terminal.cols, rows: session.terminal.rows }
          : null
      )
    )
  }

  runtimeState(terminalId: string): Effect.Effect<{
    title: string | null
    status: HostedTerminal['status']
    progress: TerminalProgress | null
    bell: { sequence: number; at: string } | null
  } | null> {
    return this.session(terminalId).pipe(
      Effect.map((session) =>
        session
          ? {
              title: session.title,
              status: session.status,
              progress: session.progress,
              bell:
                session.lastBellAt === null
                  ? null
                  : {
                      sequence: session.bellSequence,
                      at: session.lastBellAt
                    }
            }
          : null
      )
    )
  }

  snapshot(
    terminalId: string
  ): Effect.Effect<
    Omit<TerminalHostAttachment, 'output'> | null,
    TerminalHostSessionError
  > {
    return Effect.gen(this, function* () {
      const session = yield* this.session(terminalId)
      if (!session) {
        return null
      }

      return yield* this.withBoundary(
        session,
        Effect.gen(this, function* () {
          yield* this.drainParser(session)
          const current = yield* this.session(terminalId)
          if (current !== session) {
            return null
          }

          const links: TerminalSnapshotLink[] = []
          // SAFETY: xterm's runtime object exposes the OSC link service used to serialize link metadata.
          const terminalInternals = Object(
            session.terminal
          ) as HeadlessTerminalInternals
          for (const [bufferName, buffer] of [
            ['normal', session.terminal.buffer.normal],
            ['alternate', session.terminal.buffer.alternate]
          ] as const) {
            for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
              const line = buffer.getLine(lineIndex)
              if (!line) {
                continue
              }

              let activeLink: { id: number; startColumn: number } | null = null
              for (let column = 0; column <= line.length; column += 1) {
                const cell =
                  column < line.length ? line.getCell(column) : undefined
                // SAFETY: xterm cells expose extended OSC-link metadata on their internal representation.
                const linkId = cell
                  ? (Object(cell) as HeadlessCellInternals).extended?.urlId
                  : undefined

                if (activeLink !== null && linkId === activeLink.id) {
                  continue
                }

                if (activeLink) {
                  const data =
                    terminalInternals._core._oscLinkService.getLinkData(
                      activeLink.id
                    )
                  if (
                    data?.uri &&
                    data.uri.length <= 4_096 &&
                    links.length < 10_000
                  ) {
                    links.push({
                      buffer: bufferName,
                      uri: data.uri,
                      line: lineIndex,
                      startColumn: activeLink.startColumn,
                      endColumn: column
                    })
                  }
                }

                activeLink = linkId ? { id: linkId, startColumn: column } : null
              }
            }
          }

          const snapshot = {
            data: session.serializer.serialize({
              scrollback: HOST_SCROLLBACK_LINES
            }),
            links,
            fence: session.outputSequence,
            cols: session.terminal.cols,
            rows: session.terminal.rows
          }
          const images: TerminalImageSnapshot | null = yield* nodePromise(() =>
            session.images.snapshot()
          )
          return { ...snapshot, images }
        })
      )
    })
  }

  attach(
    terminalId: string
  ): Effect.Effect<
    TerminalHostAttachment | null,
    TerminalHostSessionError,
    Scope.Scope
  > {
    return Effect.gen(this, function* () {
      const session = yield* this.session(terminalId)
      if (!session) {
        return null
      }

      const subscription = yield* PubSub.subscribe(session.output)
      const snapshot = yield* this.snapshot(terminalId)
      if (!snapshot) {
        return null
      }

      return { ...snapshot, output: Stream.fromQueue(subscription) }
    })
  }

  runtimeEvents(
    terminalId: string
  ): Stream.Stream<TerminalHostRuntimeEvent, TerminalHostSessionError> {
    return Stream.unwrapScoped(
      Effect.gen(this, function* () {
        const session = yield* this.session(terminalId)
        if (!session) {
          return Stream.empty
        }

        const subscription = yield* PubSub.subscribe(session.runtime)
        return Stream.fromQueue(subscription)
      })
    )
  }

  pauseOutput(terminalId: string): Effect.Effect<boolean, never, Scope.Scope> {
    return Effect.acquireRelease(
      this.session(terminalId).pipe(
        Effect.map((session) => (session ? this.makePauseLease(session) : null))
      ),
      (lease) => lease?.release ?? Effect.void
    ).pipe(Effect.map((lease) => lease !== null))
  }

  write(
    terminalId: string,
    data: string | Buffer,
    authority: { attachmentId: string; generation: number }
  ): Effect.Effect<void> {
    return this.session(terminalId).pipe(
      Effect.tap((session) =>
        Effect.sync(() => {
          if (
            session?.status === 'running' &&
            session.queryAuthorityAttachmentId === authority.attachmentId &&
            session.queryAuthorityGeneration === authority.generation &&
            session.queryTransition === null
          ) {
            session.pty.write(data)
          }
        })
      ),
      Effect.asVoid
    )
  }

  prepareQueryAuthority(
    terminalId: string
  ): Effect.Effect<
    { transitionId: string; fence: number },
    TerminalHostSessionError
  > {
    return Effect.gen(this, function* () {
      const session = yield* this.requireSession(terminalId)
      if (session.status !== 'running') {
        return yield* Effect.fail(
          new TerminalHostSessionError({ message: 'Terminal is unavailable' })
        )
      }

      if (session.queryTransition) {
        return yield* Effect.fail(
          new TerminalHostSessionError({
            message: 'A terminal query authority change is already pending'
          })
        )
      }

      const lease = this.makePauseLease(session)
      let retained = false
      return yield* Effect.gen(this, function* () {
        yield* this.drainParser(session)
        const current = yield* this.session(terminalId)
        if (current !== session) {
          return yield* Effect.fail(
            new TerminalHostSessionError({ message: 'Terminal is unavailable' })
          )
        }

        session.queryAuthorityAttachmentId = null
        session.queryAuthorityGeneration = null
        session.terminal.options.disableStdin = false
        const id = crypto.randomUUID()
        session.queryTransition = { id, lease }
        retained = true
        return { transitionId: id, fence: session.outputSequence }
      }).pipe(Effect.onExit(() => (retained ? Effect.void : lease.release)))
    })
  }

  activateQueryAuthority(
    terminalId: string,
    transitionId: string,
    attachmentId: string,
    generation: number,
    cellSize: { width: number; height: number } | null = null
  ): Effect.Effect<void, TerminalHostSessionError> {
    return Effect.gen(this, function* () {
      const session = yield* this.requireSession(terminalId)
      const transition = session.queryTransition
      if (
        session.status !== 'running' ||
        !transition ||
        transition.id !== transitionId
      ) {
        return yield* Effect.fail(
          new TerminalHostSessionError({
            message: 'Terminal query authority transition is unavailable'
          })
        )
      }

      if (cellSize) {
        session.images.setCellSize(cellSize)
      }

      session.terminal.options.disableStdin = true
      session.queryAuthorityAttachmentId = attachmentId
      session.queryAuthorityGeneration = generation
      session.queryTransition = null
      yield* transition.lease.release
    })
  }

  useHostQueryAuthority(
    terminalId: string
  ): Effect.Effect<void, TerminalHostSessionError> {
    return Effect.gen(this, function* () {
      const session = yield* this.session(terminalId)
      if (!session || session.status !== 'running') {
        return
      }

      if (session.queryTransition) {
        const transition = session.queryTransition
        session.queryTransition = null
        session.terminal.options.disableStdin = false
        session.queryAuthorityAttachmentId = null
        session.queryAuthorityGeneration = null
        yield* transition.lease.release
        return
      }

      yield* this.withBoundary(
        session,
        Effect.gen(this, function* () {
          yield* this.drainParser(session)
          if ((yield* this.session(terminalId)) !== session) {
            return
          }

          session.terminal.options.disableStdin = false
          session.queryAuthorityAttachmentId = null
          session.queryAuthorityGeneration = null
        })
      )
    })
  }

  restoreHostQueryAuthority(): Effect.Effect<void, TerminalHostSessionError> {
    return SynchronizedRef.get(this.sessions).pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(sessions.keys(), (terminalId) =>
          this.useHostQueryAuthority(terminalId)
        )
      ),
      Effect.asVoid
    )
  }

  resize(
    terminalId: string,
    cols: number,
    rows: number
  ): Effect.Effect<void, TerminalHostSessionError> {
    return Effect.gen(this, function* () {
      const session = yield* this.session(terminalId)
      if (!session || session.status !== 'running') {
        return
      }

      yield* this.withBoundary(
        session,
        Effect.gen(this, function* () {
          yield* this.drainParser(session)
          if ((yield* this.session(terminalId)) !== session) {
            return
          }

          session.pty.resize(cols, rows)
          session.terminal.resize(cols, rows)
        })
      )
    })
  }

  listTerminals(worktreeId: string): Effect.Effect<HostedTerminal[]> {
    return SynchronizedRef.get(this.sessions).pipe(
      Effect.map((sessions) =>
        [...sessions.values()]
          .filter(
            (session): session is HostedTerminalSession =>
              session !== null && session.worktreeId === worktreeId
          )
          .map((session) => ({
            id: session.id,
            worktreeId: session.worktreeId,
            name: session.name,
            argv: [...session.argv],
            shellCommand: session.shellCommand,
            interactiveShell: session.interactiveShell,
            closeOnSuccess: session.closeOnSuccess,
            status: session.status,
            exitCode: session.exitCode,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt
          }))
      )
    )
  }

  terminalState(terminalId: string): Effect.Effect<TerminalSessionState> {
    return this.session(terminalId).pipe(
      Effect.map((session) =>
        session
          ? { status: session.status, exitCode: session.exitCode }
          : { status: 'missing' as const, exitCode: null }
      )
    )
  }

  terminalSize(
    terminalId: string
  ): Effect.Effect<{ cols: number; rows: number } | null> {
    return this.size(terminalId)
  }

  captureTerminal(
    terminalId: string,
    lines: number
  ): Effect.Effect<string | null> {
    return Effect.gen(this, function* () {
      const session = yield* this.session(terminalId)
      if (!session) {
        return null
      }

      yield* Effect.async<void>((resume) =>
        session.terminal.write('', () => resume(Effect.void))
      )
      const buffer = session.terminal.buffer.active
      const content: string[] = []
      for (let index = 0; index < buffer.length; index += 1) {
        content.push(buffer.getLine(index)?.translateToString(true) ?? '')
      }
      while (content.length && !content.at(-1)?.trim()) {
        content.pop()
      }
      return content.slice(-lines).join('\n')
    })
  }

  renameTerminal(
    terminalId: string,
    name: string,
    updatedAt: string
  ): Effect.Effect<void> {
    return this.session(terminalId).pipe(
      Effect.tap((session) =>
        Effect.sync(() => {
          if (session) {
            session.name = name
            session.updatedAt = updatedAt
          }
        })
      ),
      Effect.asVoid
    )
  }

  listProcesses(worktreeId: string): Effect.Effect<TerminalProcess[]> {
    return SynchronizedRef.get(this.sessions).pipe(
      Effect.map((sessions) =>
        [...sessions.values()]
          .filter(
            (session): session is HostedTerminalSession =>
              session !== null &&
              session.worktreeId === worktreeId &&
              session.status === 'running'
          )
          .map((session) => ({
            pid: session.pty.pid,
            terminalId: session.id
          }))
      )
    )
  }

  terminalTitleState(
    terminalId: string
  ): Effect.Effect<TerminalTitleState | null> {
    return this.session(terminalId).pipe(
      Effect.map((session) =>
        session
          ? {
              terminalTitle: session.title,
              currentCommand: session.pty.process || null,
              commandLine: session.commandLine
            }
          : null
      )
    )
  }

  signalTerminal(
    terminalId: string,
    signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'
  ): Effect.Effect<void> {
    return this.session(terminalId).pipe(
      Effect.tap((session) =>
        Effect.sync(() => {
          if (session?.status === 'running') {
            session.pty.kill(signal)
          }
        })
      ),
      Effect.asVoid
    )
  }

  killTerminal(
    terminalId: string
  ): Effect.Effect<void, TerminalHostSessionError> {
    return this.session(terminalId).pipe(
      Effect.flatMap((session) =>
        session ? this.destroy(session) : Effect.void
      )
    )
  }

  killWorktree(
    worktreeId: string
  ): Effect.Effect<string[], TerminalHostSessionError> {
    return Effect.gen(this, function* () {
      const sessions = [
        ...(yield* SynchronizedRef.get(this.sessions)).values()
      ].filter(
        (session): session is HostedTerminalSession =>
          session !== null && session.worktreeId === worktreeId
      )
      const terminalIds = sessions.map((session) => session.id)
      const started = yield* Effect.forEach(sessions, (session) =>
        this.beginDestroy(session)
      )
      const pending = [...this.pendingCleanups]
        .filter((cleanup) => cleanup.worktreeId === worktreeId)
        .map((cleanup) => cleanup.completed)
      yield* Effect.forEach([...started, ...pending], Deferred.await, {
        concurrency: 'unbounded'
      }).pipe(Effect.mapError(effectError))
      return terminalIds
    })
  }

  shutdown(): Effect.Effect<void, TerminalHostSessionError> {
    return Effect.gen(this, function* () {
      const sessions = [
        ...(yield* SynchronizedRef.get(this.sessions)).values()
      ].filter((session): session is HostedTerminalSession => session !== null)
      const started = yield* Effect.forEach(sessions, (session) =>
        this.beginDestroy(session)
      )
      const pending = [...this.pendingCleanups].map(
        (cleanup) => cleanup.completed
      )
      yield* Effect.forEach([...started, ...pending], Deferred.await, {
        concurrency: 'unbounded'
      }).pipe(Effect.mapError(effectError))
      yield* FiberSet.awaitEmpty(this.cleanups)
    })
  }

  private destroy(
    session: HostedTerminalSession
  ): Effect.Effect<void, TerminalHostSessionError> {
    return this.beginDestroy(session).pipe(
      Effect.flatMap(Deferred.await),
      Effect.mapError(effectError)
    )
  }

  private beginDestroy(
    session: HostedTerminalSession
  ): Effect.Effect<Deferred.Deferred<void, unknown>> {
    return Effect.gen(this, function* () {
      const removed = yield* SynchronizedRef.modify(
        this.sessions,
        (current) => {
          if (current.get(session.id) !== session) {
            return [false, current] as const
          }

          const next = new Map(current)
          next.delete(session.id)
          return [true, next] as const
        }
      )
      if (!removed) {
        const done = yield* Deferred.make<void, unknown>()
        yield* Deferred.succeed(done, undefined)
        return done
      }

      yield* Scope.close(session.scope, Exit.void)
      const completed = yield* Deferred.make<void, unknown>()
      const cleanup: PendingCleanup = {
        worktreeId: session.worktreeId,
        completed
      }
      this.pendingCleanups.add(cleanup)
      yield* FiberSet.run(
        this.cleanups,
        Effect.all(
          [
            session.specPath
              ? nodePromise(() => fs.rm(session.specPath!, { force: true }))
              : Effect.void,
            this.options.terminateProcessTree(session.pty)
          ],
          { discard: true, concurrency: 'unbounded' }
        ).pipe(
          Effect.exit,
          Effect.tap((result) => Deferred.done(completed, result)),
          Effect.ensuring(
            Effect.sync(() => this.pendingCleanups.delete(cleanup))
          ),
          Effect.asVoid
        )
      )
      return completed
    })
  }
}

export function makeTerminalHostSessions(
  options: TerminalHostSessionsOptions
): Effect.Effect<TerminalHostSessions, TerminalHostSessionError, Scope.Scope> {
  return TerminalHostSessions.make(options)
}
