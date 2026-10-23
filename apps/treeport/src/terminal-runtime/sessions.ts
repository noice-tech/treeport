import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
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
  TERMINAL_BACKGROUND,
  TERMINAL_FOREGROUND,
  TERMINAL_IMAGE_STORAGE_BYTES
} from '../ghostty-vt/ghostty-vt'
import { loadGhosttyVtModule } from '../ghostty-vt/node'
import {
  TERMINAL_COMMAND_OSC,
  TERMINAL_PROGRESS_STALE_MS,
  type HostedTerminal,
  type TerminalCreateInput,
  type TerminalHostOutput,
  type TerminalHostRuntimeEvent,
  type TerminalHostSnapshot,
  type TerminalLaunchSpec,
  type TerminalProcess,
  type TerminalProgress,
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
// Bounds unfinished VT input a snapshot carries, such as a partial image upload.
const HOST_CONTINUATION_BYTES = 64 * 1024 * 1024
const PROGRESS_STATES = [
  null,
  'normal',
  'error',
  'indeterminate',
  'paused'
] as const
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
  | { readonly _tag: 'Title'; readonly title: string }
  | { readonly _tag: 'TitleState'; readonly value: TerminalTitleState }
  | {
      readonly _tag: 'Progress'
      readonly value: TerminalProgress | null
      readonly at: number
    }
  | { readonly _tag: 'Bell' }
  | { readonly _tag: 'Exit'; readonly exitCode: number; readonly at: number }

interface PauseLease {
  readonly release: Effect.Effect<void>
}

interface HostedTerminalSession extends Omit<HostedTerminal, 'status'> {
  status: 'running' | 'exited'
  readonly cwd: string
  readonly specPath: string | null
  title: string | null
  commandLine: string | null
  progress: TerminalProgress | null
  progressFiber: Fiber.RuntimeFiber<void, never> | null
  bellSequence: number
  lastBellAt: string | null
  readonly pty: IPty | PersistentSession
  replaying: boolean
  processingSequence: number
  processingTime: number
  readonly terminal: GhosttyTerminal
  // Suppresses the host's query replies, for example while a viewer answers.
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

/** Replaceable terminal engine. Production PTYs belong to independent session
 * processes; closing this engine detaches them. Direct PTY injection is retained
 * for isolated emulator checks and the pre-migration host entrypoint. */
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
            argv: [...input.argv],
            shellCommand: input.shellCommand,
            interactiveShell: input.interactiveShell,
            closeOnSuccess: input.closeOnSuccess ?? false,
            closeOnExit: input.closeOnExit ?? false,
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
            argv: [...input.argv],
            fallbackArgv: input.fallbackArgv
              ? [...input.fallbackArgv]
              : undefined,
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
        // Discovery is authoritative before readiness; attachment/replay is
        // not a prerequisite for serving the application or other terminals.
        yield* background
          ? Effect.forkIn(restore, this.recoveryScope).pipe(Effect.asVoid)
          : restore
      })
        .pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              // Unreadable metadata cannot safely be assigned to a tree. Keep a global
              // inventory barrier, not an authoritative empty result or a startup crash.
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
            // A vanished keeper cannot be revived by spawning its command.
            // Keep the reconstructed screen accessible and report unknown exit
            // status if no exit record survived. Do not manufacture success.
            ownedSession.status = 'exited'
            ownedSession.exitCode = owner.exitCode
            Queue.unsafeOffer(ownedSession.runtimeCommands, {
              _tag: 'Progress',
              value: null,
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
          // The launcher's atomic sidecar is authoritative even while the engine
          // is detached. Poll only until completion (or final hosted exit), so
          // neither a missed notification nor journal rotation can lose it.
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
        input.interactiveShell &&
        input.shellCommand === null &&
        !input.initialTitle &&
        !input.fallbackArgv &&
        !input.setupTasks?.length &&
        !input.setupError
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
      // xterm supports RGB colors; TERM alone makes apps fall back to 256 colors.
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
      const ghosttyModule = yield* nodePromise(loadGhosttyVtModule)
      // Parser callbacks run synchronously inside terminal.write, which only
      // happens after the session below is assigned.
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
              hosted.bellSequence += 1
              hosted.lastBellAt = new Date(hosted.processingTime).toISOString()
              return
            }

            Queue.unsafeOffer(hosted.runtimeCommands, { _tag: 'Bell' })
          },
          titleChanged: () => {
            if (hosted) {
              Queue.unsafeOffer(hosted.runtimeCommands, {
                _tag: 'Title',
                title: terminal.title()
              })
            }
          },
          progress: (state, value) => {
            if (!hosted) {
              return
            }

            const progressState = PROGRESS_STATES[state] ?? null
            Queue.unsafeOffer(hosted.runtimeCommands, {
              _tag: 'Progress',
              value: progressState && {
                state: progressState,
                value: value < 0 ? null : Math.min(100, value)
              },
              at: hosted.processingTime
            })
          },
          unknownOsc: (content) => {
            const prefix = `${TERMINAL_COMMAND_OSC};command;`
            if (!hosted || !content.startsWith(prefix)) {
              return
            }

            hosted.commandLine =
              content
                .slice(prefix.length)
                .replace(/\p{Cc}/gu, '')
                .trim()
                .slice(0, 256) || null
            Queue.unsafeOffer(hosted.runtimeCommands, {
              _tag: 'TitleState',
              value: {
                terminalTitle: hosted.title,
                currentCommand: hosted.pty.process || null,
                commandLine: hosted.commandLine
              }
            })
          },
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
        argv: [...input.argv],
        shellCommand: input.shellCommand,
        interactiveShell: input.interactiveShell,
        closeOnSuccess: input.closeOnSuccess ?? false,
        closeOnExit: input.closeOnExit ?? false,
        status: 'running',
        exitCode: null,
        commandExitCode: null,
        createdAt: input.createdAt,
        updatedAt: retainedMetadata?.updatedAt ?? input.createdAt,
        cwd: input.cwd,
        specPath,
        title: input.initialTitle ?? null,
        commandLine: input.initialTitle ?? null,
        progress: null,
        progressFiber: null,
        bellSequence: 0,
        lastBellAt: null,
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
      return session
    })
  }

  private parserWorker(session: HostedTerminalSession): Effect.Effect<void> {
    return Effect.forever(
      Effect.gen(this, function* () {
        // A PTY can deliver image-heavy redraws in thousands of 1 KiB chunks.
        // Drain already queued output together; never wait to fill a batch or
        // parse across a snapshot/authority fence.
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
            // Advance metadata between records so replayed bells, progress,
            // and query replies retain their original timestamps and
            // processed-sequence fence.
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
          // Preserve owner sequences: subscribers use them to distinguish
          // canonical snapshot contents from the live suffix.
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
          case 'Progress': {
            if (session.progressFiber) {
              yield* Fiber.interrupt(session.progressFiber)
              session.progressFiber = null
            }

            const remainingMs = Math.max(
              0,
              this.options.progressStaleMs -
                Math.max(0, Date.now() - command.at)
            )
            session.progress = remainingMs > 0 ? command.value : null
            yield* PubSub.publish(session.runtime, {
              progress: session.progress
            })
            if (session.progress !== null) {
              session.progressFiber = yield* Effect.forkIn(
                Effect.sleep(remainingMs).pipe(
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
          }
          case 'Exit':
            // The launcher commits its child result before exiting. Read it
            // before the session-exit event stops product runtime subscriptions.
            yield* this.observeCommandExit(session).pipe(
              Effect.catchAll((error) => Effect.logError(error.message))
            )
            if (session.progressFiber) {
              yield* Fiber.interrupt(session.progressFiber)
              session.progressFiber = null
            }

            session.progress = null
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
        // Completion may have been replayed before subscriptions could attach.
        // Publish the recovered state once, then continue with live events.
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
              // Acknowledge only after the keeper admits this chunk into its
              // bounded PTY writer, propagating backpressure to the browser.
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
        // The keeper has already paused PTY output. Keep its IPC stream readable:
        // a viewer can resize before completing this authority handshake, and
        // resize/status replies share the stream with output. Pausing it would
        // deadlock resize behind the lease that activation needs to release.
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
          // The owner is paused during authority transfer. Read its marker
          // acknowledgement without allowing new PTY output to overtake it.
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
            argv: [...session.argv],
            shellCommand: session.shellCommand,
            interactiveShell: session.interactiveShell,
            closeOnSuccess: session.closeOnSuccess,
            closeOnExit: session.closeOnExit,
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

      if (session.pty instanceof PersistentSession) {
        const owner = session.pty
        yield* nodePromise(() => owner.refreshStatus()).pipe(Effect.orDie)
      }

      return {
        terminalTitle: session.title,
        currentCommand: session.pty.process || null,
        commandLine: session.commandLine
      }
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
        // Keep ownership visible if termination fails. A later worktree close
        // must retry/fail, not report success from an already emptied map.
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
          // Stop the writer before removing its result, including direct PTYs.
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
