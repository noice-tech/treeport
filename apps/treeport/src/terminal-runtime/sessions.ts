import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from 'node-pty'
import * as pty from 'node-pty'
import { z } from 'zod'
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
  GhosttyTerminal,
  type GhosttyProgramStatus,
  TERMINAL_BACKGROUND,
  TERMINAL_FOREGROUND,
  TERMINAL_IMAGE_STORAGE_BYTES
} from '../ghostty-vt/ghostty-vt'
import { loadGhosttyVtModule } from '../ghostty-vt/node'
import {
  TERMINAL_PROGRESS_STALE_MS,
  type HostedTerminal,
  type TerminalCreateInput,
  type TerminalHostOutput,
  type TerminalHostRuntimeEvent,
  type TerminalHostSnapshot,
  type TerminalActivity,
  type TerminalAttention,
  type TerminalLaunchSpec,
  type TerminalProcess,
  type TerminalSessionState,
  type TerminalTitleState
} from './contract'
import { PersistentSession } from './session-client'
import { decodeTerminalEngineMetadata } from './api'
import {
  integrateShellLaunch,
  prepareShellIntegration
} from './shell-integration'

export type { TerminalHostRuntimeEvent } from './contract'

const HOST_SCROLLBACK_LINES = 50_000

const HOST_CONTINUATION_BYTES = 64 * 1024 * 1024

const IDLE_ACTIVITY: TerminalActivity = {
  state: 'idle',
  kind: null,
  progress: null,
  app: null,
  message: null,
  since: null
}

const PROGRAM_STATUS_RECORDS = 64

const PROGRAM_STATUS_RANK = ['blocked', 'error', 'working', 'done', 'idle']
const HOST_PARSER_HIGH_WATERMARK = 1024 * 1024
const HOST_PARSER_LOW_WATERMARK = 256 * 1024
const PROCESS_TREE_KILL_GRACE_MS = 500

const engineMarkerSchema = z.object({
  type: z.literal('cell-size'),
  width: z.number().min(1).max(100),
  height: z.number().min(1).max(200)
})

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

type ParserCommand =
  | {
      readonly _tag: 'Output'
      readonly data: string
      readonly sequence: number
      readonly bytes: number
      readonly at: number
    }
  | {
      readonly _tag: 'Fence'
      readonly completed: Deferred.Deferred<void, TerminalHostSessionError>
    }
  | { readonly _tag: 'Resize'; readonly cols: number; readonly rows: number }
  | {
      readonly _tag: 'CellSize'
      readonly width: number
      readonly height: number
    }
  | { readonly _tag: 'Stop' }

type RuntimeCommand =
  | { readonly _tag: 'TitleState' }
  | {
      readonly _tag: 'Progress'
      readonly state: 'idle' | 'working' | 'error'
      readonly progress: number | null
      readonly at: number
    }
  | { readonly _tag: 'Bell'; readonly at: number; readonly batch: number }
  | {
      readonly _tag: 'ProgramStatus'
      readonly report: GhosttyProgramStatus
      readonly at: number
      readonly batch: number
      readonly replaying: boolean
    }
  | {
      readonly _tag: 'Prompt'
      readonly at: number
      readonly batch: number
      readonly replaying: boolean
    }
  | { readonly _tag: 'Reset' }
  | { readonly _tag: 'Exit'; readonly exitCode: number; readonly at: number }

type ProgramStatusRecord = Omit<TerminalActivity, 'since'>

interface PauseLease {
  readonly release: Effect.Effect<void>
}

interface HostedTerminalSession extends Omit<HostedTerminal, 'status'> {
  status: 'running' | 'exited'
  readonly cwd: string
  readonly specPath: string | null
  readonly shellName: string
  title: string | null
  commandTitle: string | null
  commandRunning: boolean | null
  commandLine: string | null
  foreground: string | null
  pwd: string | null
  activity: TerminalActivity
  progressFiber: Fiber.RuntimeFiber<void, never> | null
  statusRecords: Map<string, ProgramStatusRecord> | null
  attention: TerminalAttention | null
  attentionBatch: number
  readonly pty: IPty | PersistentSession
  replaying: boolean
  processingSequence: number
  processingTime: number
  readonly terminal: GhosttyTerminal
  stdinDisabled: boolean
  cellSize: { width: number; height: number }
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
  readonly sessionExecutable?: string | undefined
  readonly journalLimitBytes?: number | undefined
}

const INTERPRETERS =
  /^(?:node|nodejs|bun|deno|python[\d.]*|ruby|perl|php|sh|bash|zsh|fish|dash)$/u

function describeCommand(argv: readonly string[]): string | null {
  const [executable = '', ...rest] = argv
  const name = path.basename(executable).replace(/^-/u, '')

  const script = INTERPRETERS.test(name)
    ? rest.findIndex((argument) => !argument.startsWith('-'))
    : -1

  const shown =
    script >= 0 &&
    !rest
      .slice(0, script)
      .some((option) => ['-c', '-e', '-m', '--eval'].includes(option))
      ? [path.basename(rest[script]!), ...rest.slice(script + 1)]
      : [name, ...rest]

  return (
    shown
      .join(' ')
      .replace(/\p{Cc}/gu, '')
      .trim()
      .slice(0, 256) || null
  )
}

function describeForeground(session: HostedTerminalSession): string | null {
  const argv =
    session.pty instanceof PersistentSession &&
    session.pty.commandLine.length > 0
      ? session.pty.commandLine
      : [session.pty.process]

  const executable = path.basename(argv[0] ?? '').replace(/^-/u, '')

  return executable && executable !== session.shellName
    ? describeCommand(argv)
    : null
}

function describeDirectory(value: string): string | null {
  const location = value.startsWith('kitty-shell-cwd://')
    ? value.slice(value.indexOf('/', 'kitty-shell-cwd://'.length))
    : value.startsWith('file:')
      ? URL.canParse(value)
        ? Buffer.from(
            new URL(value).pathname.replace(/%([0-9a-f]{2})/giu, (_, hex) =>
              String.fromCharCode(Number.parseInt(hex, 16))
            ),
            'latin1'
          ).toString('utf8')
        : null
      : value

  if (!location) {
    return null
  }

  const home = os.homedir()

  return location === home || location.startsWith(`${home}/`)
    ? `~${location.slice(home.length)}`
    : location
}

function titleState(session: HostedTerminalSession): TerminalTitleState {
  if (session.commandRunning === false) {
    return {
      title: session.pwd ?? session.title,
      command: null,
      running: false
    }
  }

  const command = session.foreground ?? session.commandLine

  return {
    title: session.commandRunning
      ? (session.commandTitle ?? command)
      : (session.title ?? command),
    command,
    running: session.commandRunning
  }
}

function raiseAttention(
  session: HostedTerminalSession,
  reason: TerminalAttention['reason'],
  at: number,
  batch: number
): boolean {
  if (session.attention && session.attentionBatch === batch) {
    if (session.attention.reason !== 'bell' || reason === 'bell') {
      return false
    }

    session.attention = { ...session.attention, reason }

    return true
  }

  session.attentionBatch = batch
  session.attention = {
    sequence: (session.attention?.sequence ?? 0) + 1,
    at: new Date(at).toISOString(),
    reason
  }

  return true
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

interface UnavailableSession {
  completed: Deferred.Deferred<void>
  terminal: HostedTerminal & { status: 'unavailable'; recoveryPending: boolean }
  directory: string
  recovering: boolean
}

export class TerminalHostSessions {
  private readonly unavailable = new Map<string, UnavailableSession>()
  private readonly unidentified = new Map<string, string>()
  private readonly restoring = new Set<string>()

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
    private readonly pendingCleanups: Set<PendingCleanup>,
    private readonly recoveryScope: Scope.Scope,
    private readonly persistentOptions: Pick<
      TerminalHostSessionsOptions,
      'sessionExecutable' | 'journalLimitBytes'
    >
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
        runtimeDir: path.resolve(options.runtimeDir),
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
        new Set(),
        yield* Scope.Scope,
        options
      )

      yield* Effect.addFinalizer(() => manager.shutdown().pipe(Effect.orDie))
      yield* manager.initialize()

      if (options.sessionExecutable !== undefined) {
        const directory = path.join(resolved.runtimeDir, 'sessions')
        yield* nodePromise(() =>
          fs.mkdir(directory, { recursive: true, mode: 0o700 })
        )
        const names = yield* nodePromise(() => fs.readdir(directory))

        for (const name of names.sort()) {
          if (!/^[a-f0-9]{40}$/u.test(name)) {
            continue
          }

          yield* manager.restoreSession(path.join(directory, name), true)
        }
      }

      return manager
    })
  }

  private restoreSession(
    directory: string,
    background = false
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.restoring.has(directory)) {
        return Effect.void
      }

      this.restoring.add(directory)

      return Effect.gen(this, function* () {
        const owner = yield* nodePromise(() =>
          PersistentSession.open(
            directory,
            this.persistentOptions.journalLimitBytes
          )
        )

        const { input } = yield* decodeTerminalEngineMetadata(
          owner.manifest.metadata
        ).pipe(Effect.mapError(effectError))

        if (
          path.basename(directory) !==
          crypto
            .createHash('sha256')
            .update(input.terminalId)
            .digest('hex')
            .slice(0, 40)
        ) {
          return yield* Effect.fail(
            effectError(
              new Error('Session metadata does not identify its directory')
            )
          )
        }

        if (yield* this.session(input.terminalId)) {
          return
        }

        const previous = this.unavailable.get(input.terminalId)

        if (previous?.recovering) {
          return
        }

        const recovery: UnavailableSession = {
          completed: yield* Deferred.make<void>(),
          directory,
          recovering: true,
          terminal: {
            id: input.terminalId,
            worktreeId: input.worktreeId,
            name: input.name,
            command: input.command,
            afterExit: input.afterExit,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
            status: 'unavailable' as const,
            unavailableReason: 'Restoring retained terminal',
            recoveryPending: true,
            exitCode: null,
            commandExitCode: null
          } satisfies HostedTerminal
        }

        this.unavailable.set(input.terminalId, recovery)

        const restore = this.createTerminal(
          {
            ...input,
            setupTasks: input.setupTasks?.map((task) => ({
              ...task,
              argv: [...task.argv]
            }))
          },
          owner
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.unavailable.delete(input.terminalId)
              this.unidentified.delete(directory)
            })
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              recovery.terminal.unavailableReason = error.message
            })
          ),
          Effect.ensuring(
            Effect.sync(() => {
              recovery.recovering = false
              recovery.terminal.recoveryPending = false
            }).pipe(
              Effect.zipRight(Deferred.succeed(recovery.completed, undefined))
            )
          )
        )

        yield* background
          ? Effect.forkIn(restore, this.recoveryScope).pipe(Effect.asVoid)
          : restore
      })
        .pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              this.unidentified.set(directory, error.message)
            })
          )
        )
        .pipe(
          Effect.ensuring(Effect.sync(() => this.restoring.delete(directory)))
        )
    })
  }

  private recoveryBarrier(
    worktreeId: string | null
  ): Effect.Effect<void, TerminalHostSessionError> {
    const unknown = this.unidentified.entries().next().value

    const unavailable = [...this.unavailable.values()].find(
      (value) => worktreeId === null || value.terminal.worktreeId === worktreeId
    )

    return unknown || unavailable
      ? Effect.fail(
          new TerminalHostSessionError({
            message: unknown
              ? `Unidentified retained session ${unknown[0]}: ${unknown[1]}`
              : `Terminal ${unavailable!.terminal.id} is unavailable: ${unavailable!.terminal.unavailableReason}`
          })
        )
      : Effect.void
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
            (session): session is HostedTerminalSession =>
              session !== null && !this.unavailable.has(session.id)
          ).length +
          this.unavailable.size +
          this.unidentified.size
      )
    )
  }

  createTerminal(
    input: TerminalCreateInput,
    retainedOwner: PersistentSession | null = null
  ): Effect.Effect<void, TerminalHostSessionError> {
    return Effect.gen(this, function* () {
      if (!retainedOwner && this.unavailable.has(input.terminalId)) {
        return yield* Effect.fail(
          new TerminalHostSessionError({
            message:
              'Retained terminal ownership is unresolved; refusing duplicate creation'
          })
        )
      }

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
      let hosted: HostedTerminalSession | null = null
      let retained = false

      return yield* Effect.gen(this, function* () {
        hosted = yield* Scope.extend(
          this.acquireSession(input, childScope, retainedOwner),
          childScope
        )
        const ownedSession = hosted

        const dataDisposable = yield* Effect.try({
          try: () =>
            ownedSession.pty.onData((data) => {
              const bytes = Buffer.byteLength(data)
              ownedSession.parserQueuedBytes += bytes

              const offered = Queue.unsafeOffer(ownedSession.parserCommands, {
                _tag: 'Output',
                data,
                sequence: (ownedSession.outputSequence =
                  ownedSession.pty instanceof PersistentSession
                    ? ownedSession.pty.sequence
                    : ownedSession.outputSequence + 1),
                bytes,
                at:
                  ownedSession.pty instanceof PersistentSession
                    ? ownedSession.pty.recordTime
                    : Date.now()
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

              const at =
                ownedSession.pty instanceof PersistentSession
                  ? ownedSession.pty.recordTime
                  : Date.now()

              ownedSession.updatedAt = new Date(at).toISOString()
              Queue.unsafeOffer(ownedSession.runtimeCommands, {
                _tag: 'Exit',
                exitCode,
                at
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

        if (ownedSession.pty instanceof PersistentSession) {
          const owner = ownedSession.pty

          const resizeDisposable = owner.onResize((cols, rows) => {
            ownedSession.outputSequence = owner.sequence
            Queue.unsafeOffer(ownedSession.parserCommands, {
              _tag: 'Resize',
              cols,
              rows
            })
          })

          yield* Scope.addFinalizer(
            childScope,
            Effect.sync(() => resizeDisposable.dispose())
          )

          const markerDisposable = owner.onMarker((data) => {
            const marker = engineMarkerSchema.parse(JSON.parse(data))
            ownedSession.outputSequence = owner.sequence
            Queue.unsafeOffer(ownedSession.parserCommands, {
              _tag: 'CellSize',
              width: marker.width,
              height: marker.height
            })
          })

          yield* Scope.addFinalizer(
            childScope,
            Effect.sync(() => markerDisposable.dispose())
          )
          yield* nodePromise(() => owner.connect())
          yield* nodePromise(() => owner.ready)
          owner.pause()
          yield* this.drainParser(ownedSession).pipe(
            Effect.catchAll((error) =>
              owner.fault
                ? Effect.logWarning(error.message)
                : Effect.fail(error)
            )
          )

          if (owner.archived) {
            ownedSession.status = 'exited'
            ownedSession.exitCode = owner.exitCode
            Queue.unsafeOffer(ownedSession.runtimeCommands, {
              _tag: 'Progress',
              state: 'idle',
              progress: null,
              at: Date.now()
            })
            yield* Effect.logWarning(
              owner.startupAborted
                ? `Terminal startup for ${input.terminalId} was aborted before command admission; recovered its retained diagnostic.`
                : `Session keeper for ${input.terminalId} is gone; recovered retained output as an exited terminal. Its final output or exit status may be incomplete.`
            )
          }

          ownedSession.replaying = false
          ownedSession.stdinDisabled =
            owner.archived || ownedSession.status !== 'running'
          owner.resume()
          yield* nodePromise(() => owner.activate())
        }

        if (ownedSession.specPath) {
          const observeCommand = this.observeCommandExit(ownedSession)
          yield* observeCommand

          if (ownedSession.commandExitCode === null) {
            yield* Effect.forkIn(
              Effect.gen(function* () {
                while (ownedSession.commandExitCode === null) {
                  const exited = ownedSession.status === 'exited'
                  yield* observeCommand

                  if (exited) {
                    return
                  }

                  yield* Effect.sleep(250)
                }
              }).pipe(
                Effect.catchAll((error) =>
                  Effect.logError(
                    'Failed to observe launched command exit'
                  ).pipe(
                    Effect.annotateLogs({
                      terminalId: input.terminalId,
                      cause: error.message
                    })
                  )
                )
              ),
              childScope
            )
          }
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

                  if (value !== null && value !== hosted) {
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
    childScope: Scope.CloseableScope,
    retainedOwner: PersistentSession | null
  ): Effect.Effect<HostedTerminalSession, TerminalHostSessionError> {
    return Effect.gen(this, function* () {
      const directShell =
        input.command === null && !input.setupTasks?.length && !input.setupError

      const retainedMetadata = retainedOwner
        ? yield* decodeTerminalEngineMetadata(
            retainedOwner.manifest.metadata
          ).pipe(Effect.mapError(effectError))
        : null

      let specPath: string | null = retainedMetadata?.launchSpecPath ?? null

      if (
        specPath &&
        path.dirname(path.resolve(specPath)) !==
          path.join(this.options.runtimeDir, 'terminal-specs')
      ) {
        return yield* Effect.fail(
          new TerminalHostSessionError({
            message: 'Session launch spec is outside its installation'
          })
        )
      }

      if (!directShell && !retainedOwner) {
        const spec: TerminalLaunchSpec = {
          shell: input.shell,
          command: input.command,
          afterExit: input.afterExit,
          cwd: input.cwd,
          env: { ...input.env },
          shellIntegrationDir: this.shellIntegrationDir
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
          `${crypto.createHash('sha256').update(input.terminalId).digest('hex').slice(0, 40)}-${crypto.randomUUID()}.json`
        )
        yield* nodePromise(() =>
          fs.writeFile(specPath!, JSON.stringify(spec), { mode: 0o600 })
        )

        if (this.persistentOptions.sessionExecutable === undefined) {
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
      }

      const size = retainedOwner
        ? {
            cols: retainedOwner.manifest.cols,
            rows: retainedOwner.manifest.rows
          }
        : (input.initialSize ?? { cols: 100, rows: 30 })

      const inheritedEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )

      inheritedEnvironment.TERM = 'xterm-256color'
      // EXTERNAL: xterm supports RGB colors; TERM alone makes apps fall back to 256 colors.
      inheritedEnvironment.COLORTERM = 'truecolor'

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
        [input.shell, '-l'],
        { ...inheritedEnvironment, ...input.env },
        this.shellIntegrationDir,
        directShell
      )

      const directEnvironment = Object.fromEntries(
        Object.entries(directLaunch.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )

      const ghosttyModule = yield* nodePromise(loadGhosttyVtModule)
      let hosted: HostedTerminalSession | null = null

      const terminal = GhosttyTerminal.create(
        ghosttyModule,
        size.cols,
        size.rows,
        {
          scrollbackLines: HOST_SCROLLBACK_LINES,
          continuationBytes: HOST_CONTINUATION_BYTES,
          imageStorageBytes: TERMINAL_IMAGE_STORAGE_BYTES,
          foreground: TERMINAL_FOREGROUND,
          background: TERMINAL_BACKGROUND
        },
        {
          writePty: (data) => {
            if (
              hosted &&
              hosted.status === 'running' &&
              !hosted.stdinDisabled &&
              (!hosted.replaying ||
                (hosted.pty instanceof PersistentSession &&
                  hosted.processingSequence > hosted.pty.processedSequence)) &&
              hosted.queryAuthorityAttachmentId === null
            ) {
              hosted.pty.write(Buffer.from(data).toString())
            }
          },
          bell: () => {
            if (!hosted) {
              return
            }

            if (hosted.replaying) {
              raiseAttention(
                hosted,
                'bell',
                hosted.processingTime,
                hosted.processingSequence
              )

              return
            }

            Queue.unsafeOffer(hosted.runtimeCommands, {
              _tag: 'Bell',
              at: hosted.processingTime,
              batch: hosted.processingSequence
            })
          },
          titleChanged: () => {
            if (hosted) {
              hosted.title = terminal.title() || null

              if (hosted.commandRunning) {
                hosted.commandTitle = hosted.title
              }

              Queue.unsafeOffer(hosted.runtimeCommands, { _tag: 'TitleState' })
            }
          },
          pwdChanged: () => {
            if (hosted) {
              hosted.pwd = describeDirectory(terminal.pwd())
              Queue.unsafeOffer(hosted.runtimeCommands, { _tag: 'TitleState' })
            }
          },
          semanticPrompt: (event) => {
            const command =
              event.command
                .replace(/\p{Cc}/gu, '')
                .trim()
                .slice(0, 256) || null

            // EXTERNAL: Programs such as pi mark their own message zones with
            // bare 133;A/B/C. Only a shell reports a command line or an exit.
            if (
              !hosted ||
              (event.kind === 'outputStart'
                ? !command
                : event.kind !== 'commandEnd')
            ) {
              return
            }

            hosted.commandRunning = event.kind === 'outputStart'
            hosted.commandTitle = null
            hosted.foreground = null
            hosted.commandLine = hosted.commandRunning ? command : null
            Queue.unsafeOffer(hosted.runtimeCommands, { _tag: 'TitleState' })

            if (event.kind === 'commandEnd') {
              Queue.unsafeOffer(hosted.runtimeCommands, {
                _tag: 'Prompt',
                at: hosted.processingTime,
                batch: hosted.processingSequence,
                replaying: hosted.replaying
              })
            }
          },
          progress: (state, value) => {
            if (!hosted) {
              return
            }

            const progressState =
              (['idle', 'working', 'error', 'working', 'working'] as const)[
                state
              ] ?? 'idle'

            Queue.unsafeOffer(hosted.runtimeCommands, {
              _tag: 'Progress',
              state: progressState,
              progress:
                progressState === 'working' && value >= 0
                  ? Math.min(100, value)
                  : null,
              at: hosted.processingTime
            })
          },
          programStatus: (report) => {
            if (hosted) {
              Queue.unsafeOffer(hosted.runtimeCommands, {
                _tag: 'ProgramStatus',
                report,
                at: hosted.processingTime,
                batch: hosted.processingSequence,
                replaying: hosted.replaying
              })
            }
          },
          reset: () => {
            if (hosted) {
              Queue.unsafeOffer(hosted.runtimeCommands, { _tag: 'Reset' })
            }
          },
          unknownOsc: null,
          renderHold: null,
          clipboardWrite: null
        }
      )

      yield* Scope.addFinalizer(
        childScope,
        Effect.sync(() => terminal.dispose())
      )

      const child: IPty | PersistentSession =
        retainedOwner ??
        (this.persistentOptions.sessionExecutable !== undefined
          ? yield* nodePromise(() =>
              PersistentSession.create({
                directory: path.join(
                  this.options.runtimeDir,
                  'sessions',
                  crypto
                    .createHash('sha256')
                    .update(input.terminalId)
                    .digest('hex')
                    .slice(0, 40)
                ),
                executable: this.persistentOptions.sessionExecutable!,
                terminalId: input.terminalId,
                journalLimitBytes: this.persistentOptions.journalLimitBytes,
                argv: directShell
                  ? directLaunch.argv
                  : [process.execPath, this.options.launcherPath, specPath!],
                cwd: input.cwd,
                env: directShell ? directEnvironment : inheritedEnvironment,
                cols: size.cols,
                rows: size.rows,
                metadata: JSON.stringify({
                  ...input,
                  engineVersion: 1,
                  launchSpecPath: specPath,
                  updatedAt: input.createdAt
                })
              })
            )
          : yield* Effect.try({
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
            }))

      if (child instanceof PersistentSession) {
        yield* Scope.addFinalizer(
          childScope,
          Effect.sync(() => child.dispose())
        )
      }

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
        command: input.command,
        afterExit: input.afterExit,
        status: 'running',
        exitCode: null,
        commandExitCode: null,
        createdAt: input.createdAt,
        updatedAt: retainedMetadata?.updatedAt ?? input.createdAt,
        cwd: input.cwd,
        specPath,
        shellName: path.basename(input.shell).replace(/^-/u, ''),
        title: null,
        commandTitle: null,
        commandRunning: null,
        commandLine: null,
        foreground: null,
        pwd: null,
        activity: IDLE_ACTIVITY,
        progressFiber: null,
        statusRecords: null,
        attention: null,
        attentionBatch: -1,
        pty: child,
        replaying: child instanceof PersistentSession,
        processingSequence: 0,
        processingTime: Date.now(),
        terminal,
        stdinDisabled: false,
        cellSize: { width: 0, height: 0 },
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

      hosted = session

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
      yield* Effect.forkIn(this.foregroundWorker(session), childScope)

      return session
    })
  }

  private parserWorker(session: HostedTerminalSession): Effect.Effect<void> {
    return Effect.forever(
      Effect.gen(this, function* () {
        const commands = Array.from(
          yield* Queue.takeBetween(session.parserCommands, 1, 256)
        )

        for (let index = 0; index < commands.length;) {
          const command = commands[index]!

          if (command._tag === 'Stop') {
            return yield* Effect.interrupt
          }

          if (command._tag === 'CellSize') {
            session.cellSize = { width: command.width, height: command.height }
            session.terminal.resize(
              session.terminal.cols,
              session.terminal.rows,
              command.width,
              command.height
            )
            index++
            continue
          }

          if (command._tag === 'Resize') {
            session.terminal.resize(
              command.cols,
              command.rows,
              session.cellSize.width,
              session.cellSize.height
            )
            index++
            continue
          }

          if (command._tag === 'Fence') {
            session.pendingFences.delete(command.completed)
            yield* Deferred.succeed(command.completed, undefined)
            index++
            continue
          }

          const batch: Array<Extract<ParserCommand, { _tag: 'Output' }>> = []
          let bytes = 0

          while (index < commands.length) {
            const next = commands[index]!

            if (
              next._tag !== 'Output' ||
              (session.replaying &&
                session.pty instanceof PersistentSession &&
                batch.length > 0 &&
                batch[0]!.sequence <= session.pty.processedSequence &&
                next.sequence > session.pty.processedSequence)
            ) {
              break
            }

            batch.push(next)
            bytes += next.bytes
            index++
          }

          if (session.replaying && session.pty instanceof PersistentSession) {
            for (const output of batch) {
              session.processingSequence = output.sequence
              session.processingTime = output.at
              session.terminal.write(output.data)
            }
          } else {
            session.processingSequence = batch.at(-1)!.sequence
            session.processingTime = batch.at(-1)!.at
            session.terminal.write(batch.map((output) => output.data).join(''))
          }

          if (
            session.pty instanceof PersistentSession &&
            session.processingSequence > session.pty.processedSequence
          ) {
            session.pty.markProcessed(session.processingSequence)
          }

          session.parserQueuedBytes = Math.max(
            0,
            session.parserQueuedBytes - bytes
          )

          for (const output of batch) {
            yield* PubSub.publish(session.output, {
              data: output.data,
              sequence: output.sequence
            })
          }

          if (
            session.parserPaused &&
            session.parserQueuedBytes <= HOST_PARSER_LOW_WATERMARK
          ) {
            session.parserPaused = false

            if (
              session.boundaryPauseCount === 0 &&
              (session.status === 'running' ||
                session.pty instanceof PersistentSession)
            ) {
              session.pty.resume()
            }
          }
        }
      })
    )
  }

  private observeCommandExit(
    session: HostedTerminalSession
  ): Effect.Effect<void, TerminalHostSessionError> {
    return Effect.gen(function* () {
      if (!session.specPath || session.commandExitCode != null) {
        return
      }

      const source = yield* nodePromise(() =>
        fs
          .readFile(`${session.specPath}.result`, 'utf8')
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
              return null
            }

            throw error
          })
      )

      if (source === null || session.commandExitCode != null) {
        return
      }

      const exitCode = yield* Effect.try({
        try: () => z.int().parse(JSON.parse(source)),
        catch: effectError
      })

      session.commandExitCode = exitCode
      yield* PubSub.publish(session.runtime, { commandExitCode: exitCode })
    })
  }

  private refreshForeground(
    session: HostedTerminalSession
  ): Effect.Effect<void> {
    return Effect.gen(function* () {
      if (session.pty instanceof PersistentSession) {
        const owner = session.pty
        yield* nodePromise(() => owner.refreshStatus()).pipe(Effect.ignore)
      }

      const foreground = describeForeground(session)

      if (foreground !== session.foreground) {
        session.foreground = foreground
        Queue.unsafeOffer(session.runtimeCommands, { _tag: 'TitleState' })
      }
    })
  }

  private foregroundWorker(
    session: HostedTerminalSession
  ): Effect.Effect<void> {
    return Effect.forever(
      Effect.gen(this, function* () {
        yield* Effect.sleep('1 second')

        if (session.status === 'running' && session.commandRunning !== false) {
          yield* this.refreshForeground(session)
        }
      })
    )
  }

  private runtimeWorker(session: HostedTerminalSession): Effect.Effect<void> {
    return Effect.forever(
      Effect.gen(this, function* () {
        const command = yield* Queue.take(session.runtimeCommands)

        switch (command._tag) {
          case 'TitleState':
            yield* PubSub.publish(session.runtime, {
              titleState: titleState(session)
            })

            return
          case 'Bell':
            if (raiseAttention(session, 'bell', command.at, command.batch)) {
              yield* PubSub.publish(session.runtime, {
                attention: session.attention!
              })
            }

            return
          case 'ProgramStatus': {
            if (session.progressFiber) {
              yield* Fiber.interrupt(session.progressFiber)
              session.progressFiber = null
            }

            const records =
              session.statusRecords ?? new Map<string, ProgramStatusRecord>()

            session.statusRecords = records
            const { report } = command

            if (report.state === 'clear') {
              for (const id of records.keys()) {
                if (
                  report.id === '' ||
                  id === report.id ||
                  id.startsWith(`${report.id}/`)
                ) {
                  records.delete(id)
                }
              }
            } else {
              records.delete(report.id)
              records.set(report.id, {
                state: report.state,
                kind: report.kind,
                progress: report.progress,
                app: report.app || null,
                message:
                  report.message.replace(/\p{Cf}/gu, '').slice(0, 2048) || null
              })

              if (records.size > PROGRAM_STATUS_RECORDS) {
                records.delete(records.keys().next().value!)
              }
            }

            yield* this.applyProgramStatus(session, command)

            return
          }

          case 'Prompt':
            if (session.statusRecords) {
              for (const [id, record] of session.statusRecords) {
                if (record.state === 'working' || record.state === 'blocked') {
                  session.statusRecords.delete(id)
                }
              }

              yield* this.applyProgramStatus(session, command)
            }

            return
          case 'Reset':
            session.statusRecords = null

            return
          case 'Progress': {
            if (session.statusRecords) {
              return
            }

            if (session.progressFiber) {
              yield* Fiber.interrupt(session.progressFiber)
              session.progressFiber = null
            }

            const remainingMs = Math.max(
              0,
              this.options.progressStaleMs -
                Math.max(0, Date.now() - command.at)
            )

            const state = remainingMs > 0 ? command.state : 'idle'
            session.activity = {
              ...IDLE_ACTIVITY,
              state,
              progress: remainingMs > 0 ? command.progress : null,
              since:
                state === session.activity.state
                  ? session.activity.since
                  : new Date(command.at).toISOString()
            }
            yield* PubSub.publish(session.runtime, {
              activity: session.activity
            })

            if (state !== 'idle') {
              session.progressFiber = yield* Effect.forkIn(
                Effect.sleep(remainingMs).pipe(
                  Effect.zipRight(
                    Effect.sync(() => {
                      session.activity = {
                        ...IDLE_ACTIVITY,
                        since: new Date().toISOString()
                      }
                    })
                  ),
                  Effect.zipRight(
                    Effect.suspend(() =>
                      PubSub.publish(session.runtime, {
                        activity: session.activity
                      })
                    )
                  ),
                  Effect.asVoid
                ),
                session.scope
              )
            }

            return
          }

          case 'Exit':
            yield* this.observeCommandExit(session).pipe(
              Effect.catchAll((error) => Effect.logError(error.message))
            )

            if (session.progressFiber) {
              yield* Fiber.interrupt(session.progressFiber)
              session.progressFiber = null
            }

            if (session.activity.state !== 'idle') {
              session.activity = {
                ...IDLE_ACTIVITY,
                since: new Date(command.at).toISOString()
              }
            }

            session.status = 'exited'
            session.exitCode = command.exitCode
            session.updatedAt = new Date(command.at).toISOString()

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

  private applyProgramStatus(
    session: HostedTerminalSession,
    source: { at: number; batch: number; replaying: boolean }
  ): Effect.Effect<void> {
    return Effect.gen(function* () {
      const records =
        session.statusRecords ?? new Map<string, ProgramStatusRecord>()

      let top: [string, ProgramStatusRecord] | null = null

      for (const entry of records) {
        if (
          !top ||
          PROGRAM_STATUS_RANK.indexOf(entry[1].state) <=
            PROGRAM_STATUS_RANK.indexOf(top[1].state)
        ) {
          top = entry
        }
      }

      let app = top?.[1].app ?? null

      for (let id = top?.[0] ?? ''; app === null && id !== '';) {
        id = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : ''
        app = records.get(id)?.app ?? null
      }

      const previous = session.activity
      const next = top ? { ...top[1], app } : IDLE_ACTIVITY
      session.activity = {
        ...next,
        since:
          next.state === previous.state
            ? previous.since
            : new Date(source.at).toISOString()
      }

      if (
        session.activity.state !== previous.state ||
        session.activity.kind !== previous.kind ||
        session.activity.progress !== previous.progress ||
        session.activity.app !== previous.app ||
        session.activity.message !== previous.message
      ) {
        yield* PubSub.publish(session.runtime, { activity: session.activity })
      }

      const { state } = session.activity

      if (
        (state === 'done' || state === 'blocked' || state === 'error') &&
        (state !== previous.state ||
          session.activity.kind !== previous.kind ||
          session.activity.message !== previous.message) &&
        raiseAttention(session, state, source.at, source.batch) &&
        !source.replaying
      ) {
        yield* PubSub.publish(session.runtime, {
          attention: session.attention!
        })
      }
    })
  }

  private session(
    terminalId: string
  ): Effect.Effect<HostedTerminalSession | null> {
    return SynchronizedRef.get(this.sessions).pipe(
      Effect.map((sessions) =>
        this.unavailable.has(terminalId)
          ? null
          : (sessions.get(terminalId) ?? null)
      )
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
          (session.status === 'running' ||
            session.pty instanceof PersistentSession) &&
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
      if (session.pty instanceof PersistentSession && session.pty.fault) {
        return yield* Effect.fail(effectError(session.pty.fault))
      }

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
    activity: TerminalActivity
    attention: TerminalAttention | null
  } | null> {
    return this.session(terminalId).pipe(
      Effect.map((session) =>
        session
          ? {
              title: titleState(session).title,
              status: session.status,
              activity: session.activity,
              attention: session.attention
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

          return {
            data: Buffer.from(session.terminal.snapshot()).toString('base64'),
            format: 'ghostty' as const,
            fence: session.outputSequence,
            cols: session.terminal.cols,
            rows: session.terminal.rows
          }
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
      const recovery = this.unavailable.get(terminalId)

      if (recovery?.recovering) {
        yield* Deferred.await(recovery.completed)
      }

      const unavailable = this.unavailable.get(terminalId)

      if (unavailable) {
        return yield* Effect.fail(
          new TerminalHostSessionError({
            message:
              unavailable.terminal.unavailableReason ??
              'Terminal recovery is unavailable'
          })
        )
      }

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
        const recovery = this.unavailable.get(terminalId)

        if (recovery?.recovering) {
          yield* Deferred.await(recovery.completed)
        }

        const session = yield* this.session(terminalId)

        if (!session) {
          return Stream.empty
        }

        const subscription = yield* PubSub.subscribe(session.runtime)
        const live = Stream.fromQueue(subscription)

        const restored: TerminalHostRuntimeEvent = {
          commandExitCode: session.commandExitCode ?? null
        }

        if (session.status === 'exited') {
          restored.exitCode = session.exitCode
        }

        return recovery ? Stream.concat(Stream.succeed(restored), live) : live
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
  ): Effect.Effect<void, TerminalHostSessionError> {
    return this.session(terminalId).pipe(
      Effect.tap((session) =>
        Effect.gen(function* () {
          if (
            session?.status === 'running' &&
            session.queryAuthorityAttachmentId === authority.attachmentId &&
            session.queryAuthorityGeneration === authority.generation &&
            session.queryTransition === null
          ) {
            const pty = session.pty

            if (pty instanceof PersistentSession) {
              yield* nodePromise(() => pty.writeAndWait(data))
            } else {
              pty.write(data)
            }
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

      const owner =
        session.pty instanceof PersistentSession ? session.pty : null

      if (owner) {
        yield* Effect.uninterruptible(nodePromise(() => owner.pauseOwner(true)))
      }

      const lease = this.makePauseLease(session)

      if (owner) {
        owner.resume()
      }

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
        session.stdinDisabled = false
        const id = crypto.randomUUID()
        session.queryTransition = { id, lease }
        retained = true

        return { transitionId: id, fence: session.outputSequence }
      }).pipe(
        Effect.onExit(() =>
          retained
            ? Effect.void
            : lease.release.pipe(
                Effect.andThen(
                  owner
                    ? nodePromise(() => owner.pauseOwner(false)).pipe(
                        Effect.catchAll(() => Effect.void)
                      )
                    : Effect.void
                )
              )
        )
      )
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
        if (session.pty instanceof PersistentSession) {
          const owner = session.pty
          owner.resume()
          yield* nodePromise(() =>
            owner.recordMarker(
              JSON.stringify({ type: 'cell-size', ...cellSize })
            )
          )
          yield* this.drainParser(session)
        } else {
          session.cellSize = cellSize
          session.terminal.resize(
            session.terminal.cols,
            session.terminal.rows,
            cellSize.width,
            cellSize.height
          )
        }
      }

      session.stdinDisabled = true
      session.queryAuthorityAttachmentId = attachmentId
      session.queryAuthorityGeneration = generation
      session.queryTransition = null
      yield* transition.lease.release

      if (session.pty instanceof PersistentSession) {
        const owner = session.pty
        yield* nodePromise(() => owner.pauseOwner(false))
      }
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
        session.stdinDisabled = false
        session.queryAuthorityAttachmentId = null
        session.queryAuthorityGeneration = null
        yield* transition.lease.release

        if (session.pty instanceof PersistentSession) {
          const owner = session.pty
          yield* nodePromise(() => owner.pauseOwner(false))
        }

        return
      }

      yield* this.withBoundary(
        session,
        Effect.gen(this, function* () {
          yield* this.drainParser(session)

          if ((yield* this.session(terminalId)) !== session) {
            return
          }

          session.stdinDisabled = false
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

      if (!session) {
        return
      }

      if (session.pty instanceof PersistentSession) {
        const owner = session.pty
        yield* nodePromise(() => owner.resizeAndWait(cols, rows))
        yield* this.drainParser(session)

        return
      }

      yield* this.withBoundary(
        session,
        Effect.gen(this, function* () {
          yield* this.drainParser(session)

          if ((yield* this.session(terminalId)) !== session) {
            return
          }

          if (session.status === 'running') {
            session.pty.resize(cols, rows)
          }

          session.terminal.resize(cols, rows)
        })
      )
    })
  }

  listTerminals(
    worktreeId: string
  ): Effect.Effect<HostedTerminal[], TerminalHostSessionError> {
    if (this.unidentified.size > 0) {
      return this.recoveryBarrier(null).pipe(Effect.as([]))
    }

    return SynchronizedRef.get(this.sessions).pipe(
      Effect.map((sessions) =>
        [...sessions.values()]
          .filter(
            (session): session is HostedTerminalSession =>
              session !== null &&
              session.worktreeId === worktreeId &&
              !this.unavailable.has(session.id)
          )
          .map<HostedTerminal>((session) => ({
            id: session.id,
            worktreeId: session.worktreeId,
            name: session.name,
            command: session.command,
            afterExit: session.afterExit,
            status: session.status,
            exitCode: session.exitCode,
            commandExitCode: session.commandExitCode ?? null,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt
          }))
          .concat(
            [...this.unavailable.values()]
              .filter((value) => value.terminal.worktreeId === worktreeId)
              .map((value) => value.terminal)
          )
      )
    )
  }

  terminalState(terminalId: string): Effect.Effect<TerminalSessionState> {
    const recovery = this.unavailable.get(terminalId)

    return (
      recovery ? this.restoreSession(recovery.directory) : Effect.void
    ).pipe(
      Effect.zipRight(this.session(terminalId)),
      Effect.map(
        (session) =>
          this.unavailable.get(terminalId)?.terminal ??
          (session
            ? {
                status: session.status,
                exitCode: session.exitCode,
                commandExitCode: session.commandExitCode ?? null
              }
            : { status: 'missing' as const, exitCode: null })
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

      const content = session.terminal
        .text()
        .split('\n')
        .map((line) => line.trimEnd())

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
        Effect.gen(function* () {
          if (!session) {
            return
          }

          if (session.pty instanceof PersistentSession) {
            const owner = session.pty

            const { input } = yield* decodeTerminalEngineMetadata(
              owner.manifest.metadata
            ).pipe(Effect.orDie)

            const metadata = JSON.stringify({
              ...input,
              engineVersion: 1,
              name,
              launchSpecPath: session.specPath,
              updatedAt
            })

            yield* nodePromise(() => owner.setMetadata(metadata)).pipe(
              Effect.orDie
            )
            owner.manifest.metadata = metadata
          }

          session.name = name
          session.updatedAt = updatedAt
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
              session.status === 'running' &&
              !this.unavailable.has(session.id)
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
    return Effect.gen(this, function* () {
      const session = yield* this.session(terminalId)

      if (!session) {
        return null
      }

      if (session.commandRunning !== false) {
        yield* this.refreshForeground(session)
      }

      return titleState(session)
    })
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
    const recovery = this.unavailable.get(terminalId)

    if (recovery || this.unidentified.size > 0) {
      return this.recoveryBarrier(recovery?.terminal.worktreeId ?? null)
    }

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
      yield* this.recoveryBarrier(worktreeId)

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

      if (this.persistentOptions.sessionExecutable !== undefined) {
        yield* SynchronizedRef.set(this.sessions, new Map())
        yield* Effect.forEach(
          sessions,
          (session) =>
            Effect.gen(this, function* () {
              if (session.pty instanceof PersistentSession) {
                const owner = session.pty
                owner.pause()
                yield* this.drainParser(session).pipe(
                  Effect.catchAll(() => Effect.void)
                )
                owner.resume()
                const fence = session.processingSequence
                yield* nodePromise(() => owner.flushRequests(fence)).pipe(
                  Effect.catchAll(() => Effect.void)
                )
              }

              yield* Scope.close(session.scope, Exit.void)
            }),
          { discard: true }
        )
        yield* FiberSet.awaitEmpty(this.cleanups)

        return
      }

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
  ): Effect.Effect<Deferred.Deferred<void, unknown>, TerminalHostSessionError> {
    return Effect.gen(this, function* () {
      if ((yield* this.session(session.id)) !== session) {
        const done = yield* Deferred.make<void, unknown>()
        yield* Deferred.succeed(done, undefined)

        return done
      }

      if (session.pty instanceof PersistentSession) {
        const owner = session.pty
        yield* nodePromise(() => owner.terminate())
      }

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
        (session.pty instanceof PersistentSession
          ? Effect.void
          : this.options.terminateProcessTree(session.pty)
        ).pipe(
          Effect.zipRight(
            session.specPath
              ? nodePromise(() =>
                  Promise.all(
                    ['', '.result', '.result.tmp'].map((suffix) =>
                      fs.rm(`${session.specPath}${suffix}`, { force: true })
                    )
                  )
                )
              : Effect.void
          ),
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
