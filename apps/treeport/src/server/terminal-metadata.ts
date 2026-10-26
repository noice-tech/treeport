import path from 'node:path'
import type {
  ProductEvent,
  TerminalActivity,
  TerminalAttentionReason,
  TerminalProgram,
  TerminalRecord,
  TerminalRuntimeMetadata,
  WorktreeRecord
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import type { TreeportService } from './core/index'
import { DomainError } from './core/index'
import { DatabasePort } from './core/database'
import type { ApplicationServices } from './core/services/infrastructure/application-runtime'
import {
  DatabaseTerminalAttentionStateStore,
  type TerminalAttentionState,
  type TerminalAttentionStateStore
} from './core/terminal-attention-state-store'
import type { TerminalTitleState } from './core/terminal'
import type { TerminalAttachmentBackend } from './core/terminal'

const PROGRAM_COMMANDS = new Map<string, TerminalProgram>([
  ['pi', 'pi'],
  ['claude', 'claude'],
  ['codex', 'codex']
])

const IDLE_ACTIVITY: TerminalActivity = {
  state: 'idle',
  kind: null,
  progress: null,
  app: null,
  message: null,
  since: null
}

type MetadataListener = (metadata: TerminalRuntimeMetadata) => void

interface TerminalMetadataEntry extends TerminalRuntimeMetadata {
  worktreeId: string
  status: TerminalRecord['status']
  commandExitCode: number | null
  terminalTitle: string | null
  currentCommand: string | null
  commandLine: string | null
  launchCommandLine: string | null
  runtimeScope: Scope.CloseableScope | null
  acknowledgedAttentionSequence: number
}

export function acquireTerminalMetadataManager(
  service: TreeportService,
  terminalHost: TerminalAttachmentBackend,
  attentionStateStore?: TerminalAttentionStateStore
): Effect.Effect<
  TerminalMetadataManager,
  never,
  Scope.Scope | ApplicationServices
> {
  return Effect.gen(function* () {
    const store =
      attentionStateStore ??
      new DatabaseTerminalAttentionStateStore(yield* DatabasePort)

    const manager = new TerminalMetadataManager(service, terminalHost, store)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => manager.dispose()).pipe(
        Effect.ensuring(manager.drain())
      )
    )
    yield* manager.initialize()

    return manager
  }).pipe(Effect.orDie)
}

export class TerminalMetadataManager {
  private readonly entries = new Map<string, TerminalMetadataEntry>()
  private readonly listeners = new Map<string, Set<MetadataListener>>()
  private readonly attentionListeners = new Set<
    (metadata: TerminalRuntimeMetadata) => void
  >()
  private readonly attentionDeletionVersions = new Map<string, number>()
  private readonly persistedAttention = new Map<
    string,
    TerminalAttentionState
  >()
  private readonly attentionStateStore: TerminalAttentionStateStore
  private initialized = false
  private unsubscribeEvents: (() => void) | null = null
  private disposed = false

  constructor(
    private readonly service: TreeportService,
    private readonly terminalHost: TerminalAttachmentBackend,
    attentionStateStore: TerminalAttentionStateStore
  ) {
    this.attentionStateStore = attentionStateStore
  }

  initialize(): Effect.Effect<void, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      if (this.initialized) {
        return
      }

      this.initialized = true
      const states = yield* this.attentionStateStore.load().pipe(Effect.orDie)

      for (const state of states) {
        this.persistedAttention.set(state.terminalId, state)
      }

      this.unsubscribeEvents = this.service.events.subscribe((event) =>
        this.handleProductEvent(event)
      )
      const projects = yield* this.service.projects.listProjects()
      yield* Effect.all(
        projects.flatMap((project) =>
          project.worktrees.flatMap((worktree) =>
            worktree.terminals.map((terminal) =>
              this.trackTerminal(terminal, worktree)
            )
          )
        ),
        { concurrency: 'unbounded' }
      )
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          this.initialized = false
        })
      )
    )
  }

  get(terminalId: string): TerminalRuntimeMetadata {
    const entry = this.entries.get(terminalId)

    return entry
      ? this.metadata(entry)
      : {
          terminalId,
          title: null,
          program: null,
          activity: IDLE_ACTIVITY,
          attention: null
        }
  }

  snapshot(): TerminalRuntimeMetadata[] {
    return [...this.entries.values()].map((entry) => this.metadata(entry))
  }

  subscribe(terminalId: string, listener: MetadataListener): () => void {
    const listeners =
      this.listeners.get(terminalId) ?? new Set<MetadataListener>()

    listeners.add(listener)
    this.listeners.set(terminalId, listeners)

    return () => {
      listeners.delete(listener)

      if (!listeners.size) {
        this.listeners.delete(terminalId)
      }
    }
  }

  subscribeLiveAttention(
    listener: (metadata: TerminalRuntimeMetadata) => void
  ): () => void {
    this.attentionListeners.add(listener)

    return () => {
      this.attentionListeners.delete(listener)
    }
  }

  trackTerminal(
    terminal: TerminalRecord,
    _worktree: WorktreeRecord
  ): Effect.Effect<void, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      if (this.disposed) {
        return
      }

      let entry = this.entries.get(terminal.id)

      if (!entry) {
        const launchCommandLine =
          terminal.command
            ?.replace(/\p{Cc}/gu, '')
            .trim()
            .slice(0, 256) || null

        const persisted = this.persistedAttention.get(terminal.id)

        const attention =
          persisted?.worktreeId === terminal.worktreeId
            ? {
                sequence: persisted.sequence,
                at: persisted.occurredAt,
                unread: persisted.unread,
                reason: persisted.reason
              }
            : null

        this.attentionDeletionVersions.set(
          terminal.id,
          (this.attentionDeletionVersions.get(terminal.id) ?? 0) + 1
        )
        entry = {
          terminalId: terminal.id,
          worktreeId: terminal.worktreeId,
          status: terminal.status,
          commandExitCode: terminal.commandExitCode ?? null,
          title: launchCommandLine,
          program: null,
          hasForegroundProcess: terminal.status === 'running' ? null : false,
          activity: IDLE_ACTIVITY,
          attention,
          terminalTitle: null,
          currentCommand: null,
          commandLine: null,
          launchCommandLine,
          runtimeScope: null,
          acknowledgedAttentionSequence: attention
            ? attention.unread
              ? attention.sequence - 1
              : attention.sequence
            : 0
        }
        this.entries.set(terminal.id, entry)
      } else {
        entry.worktreeId = terminal.worktreeId
        entry.status = terminal.status
        entry.commandExitCode = terminal.commandExitCode ?? null
        this.reconcileTitleState(entry, {
          terminalTitle: entry.terminalTitle,
          currentCommand: entry.currentCommand,
          commandLine: entry.commandLine
        })
      }

      if (entry.status === 'running') {
        yield* this.startRuntime(entry)
      } else {
        this.stopRuntime(entry)
      }
    })
  }

  acknowledgeAttention(
    terminalId: string,
    sequence: number
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    return this.service.terminalMetadataMutation(
      terminalId,
      Effect.gen(this, function* () {
        const entry = this.entries.get(terminalId)

        if (!entry) {
          return yield* Effect.fail(
            new DomainError(
              'TERMINAL_NOT_FOUND',
              `Terminal not found: ${terminalId}`,
              404
            )
          )
        }

        const latestSequence = entry.attention?.sequence ?? 0

        if (sequence > latestSequence) {
          return yield* Effect.fail(
            new DomainError(
              'ATTENTION_SEQUENCE_AHEAD',
              'Attention acknowledgement is ahead of the latest observed attention',
              409
            )
          )
        }

        if (sequence <= entry.acknowledgedAttentionSequence) {
          return
        }

        if (
          entry.attention &&
          sequence === latestSequence &&
          entry.attention.unread
        ) {
          yield* this.attentionStateStore
            .markRead(terminalId, sequence)
            .pipe(
              Effect.orDie,
              Effect.withSpan('treeport.terminal.attention.acknowledge.persist')
            )
          yield* Effect.sync(() => {
            const persisted = this.persistedAttention.get(terminalId)

            if (persisted?.sequence === sequence) {
              this.persistedAttention.set(terminalId, {
                ...persisted,
                unread: false
              })
            }

            if (this.entries.get(terminalId) === entry) {
              entry.attention = { ...entry.attention!, unread: false }
              entry.acknowledgedAttentionSequence = sequence
              this.publish(entry)
            }
          }).pipe(
            Effect.withSpan('treeport.terminal.attention.acknowledge.publish')
          )

          return
        }

        yield* Effect.sync(() => {
          entry.acknowledgedAttentionSequence = sequence
        })
      })
    )
  }

  removeTerminal(terminalId: string): void {
    const entry = this.entries.get(terminalId)

    if (!entry && !this.persistedAttention.has(terminalId)) {
      return
    }

    this.entries.delete(terminalId)

    if (entry) {
      this.stopRuntime(entry)
    }

    const deletionVersion =
      (this.attentionDeletionVersions.get(terminalId) ?? 0) + 1

    this.attentionDeletionVersions.set(terminalId, deletionVersion)
    this.service.forkApplicationEffect(
      this.service
        .terminalMetadataMutation(
          terminalId,
          Effect.gen(this, function* () {
            if (
              this.attentionDeletionVersions.get(terminalId) !== deletionVersion
            ) {
              return
            }

            yield* this.attentionStateStore
              .delete(terminalId)
              .pipe(Effect.orDie)
            yield* Effect.sync(() => {
              this.persistedAttention.delete(terminalId)
            })
          })
        )
        .pipe(
          Effect.catchAll((error) =>
            Effect.logError(
              `Failed to delete terminal attention state for ${terminalId}`
            ).pipe(Effect.annotateLogs({ cause: String(error) }))
          )
        )
    )

    if (entry) {
      const cleared = {
        terminalId,
        title: null,
        program: null,
        activity: IDLE_ACTIVITY,
        attention: null
      } satisfies TerminalRuntimeMetadata

      this.listeners.get(terminalId)?.forEach((listener) => listener(cleared))
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = null

    for (const entry of this.entries.values()) {
      this.stopRuntime(entry)
    }

    this.entries.clear()
    this.listeners.clear()
    this.attentionListeners.clear()
  }

  drain(): Effect.Effect<void, never, ApplicationServices> {
    return this.service.drainTerminalMetadataMutations()
  }

  private handleProductEvent(event: ProductEvent): void {
    if (event.type === 'terminal.removed') {
      this.removeTerminal(event.data.terminalId)

      return
    }

    if (event.type === 'worktree.removed') {
      for (const entry of [...this.entries.values()]) {
        if (entry.worktreeId === event.data.worktreeId) {
          this.removeTerminal(entry.terminalId)
        }
      }

      return
    }

    if (
      event.type !== 'terminal.created' &&
      event.type !== 'terminal.updated'
    ) {
      return
    }

    const { terminalId } = event.data
    this.service.forkApplicationEffect(
      Effect.gen(this, function* () {
        const terminal =
          event.type === 'terminal.created'
            ? event.data.terminal
            : yield* this.service.terminals.getTerminal(terminalId)

        const worktree = yield* this.service.projects.getWorktree(
          terminal.worktreeId
        )

        yield* this.trackTerminal(terminal, worktree)
      }).pipe(
        Effect.catchAll((error) => {
          if (
            error instanceof DomainError &&
            error.code === 'TERMINAL_NOT_FOUND'
          ) {
            return Effect.sync(() => this.removeTerminal(terminalId))
          }

          return Effect.logError(
            `Failed to refresh terminal metadata for ${terminalId}`
          ).pipe(Effect.annotateLogs({ cause: String(error) }))
        })
      )
    )
  }

  private startRuntime(
    entry: TerminalMetadataEntry
  ): Effect.Effect<void, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      if (entry.runtimeScope) {
        return
      }

      const runtimeScope = yield* Scope.make()
      entry.runtimeScope = runtimeScope
      yield* Effect.forkIn(
        Stream.runForEach(
          this.terminalHost.runtimeEvents(entry.terminalId),
          (event) =>
            Effect.gen(this, function* () {
              if (event.commandExitCode != null) {
                entry.commandExitCode = event.commandExitCode
                this.reconcileTitleState(entry, {
                  terminalTitle: entry.terminalTitle,
                  currentCommand: entry.currentCommand,
                  commandLine: entry.commandLine
                })
              }

              if (event.titleState) {
                this.reconcileTitleState(entry, event.titleState)
              } else if (event.title !== undefined) {
                entry.terminalTitle = event.title
                this.update(entry, { title: event.title })
              }

              if (event.activity) {
                this.update(entry, { activity: event.activity })
              }

              if (event.attention) {
                yield* this.recordAttention(entry, event.attention, true)
              }

              if ('exitCode' in event || event.commandExitCode != null) {
                if ('exitCode' in event) {
                  entry.status = 'exited'
                  this.stopRuntime(entry)
                }

                this.service.forkApplicationEffect(
                  this.service.terminals
                    .refreshTerminalStatus(entry.terminalId, false)
                    .pipe(
                      Effect.catchAll((error) => {
                        if (
                          error instanceof DomainError &&
                          error.code === 'TERMINAL_NOT_FOUND'
                        ) {
                          return Effect.void
                        }

                        return Effect.logError(
                          `Failed to refresh terminal completion ${entry.terminalId}`
                        ).pipe(Effect.annotateLogs({ cause: String(error) }))
                      }),
                      Effect.asVoid
                    )
                )
              }
            })
        ).pipe(
          Effect.catchAll((error) =>
            Effect.logError(
              `Terminal runtime stream failed for ${entry.terminalId}`
            ).pipe(Effect.annotateLogs({ cause: String(error) }))
          )
        ),
        runtimeScope
      )
      yield* Effect.yieldNow()

      const [state, titleState] = yield* Effect.all([
        this.terminalHost.runtimeState(entry.terminalId),
        this.terminalHost.terminalTitleState(entry.terminalId)
      ])

      if (this.entries.get(entry.terminalId) !== entry) {
        return
      }

      if (state) {
        this.update(entry, { activity: state.activity })

        if (state.attention) {
          yield* this.recordAttention(entry, state.attention)
        }
      }

      if (titleState) {
        this.reconcileTitleState(entry, titleState)
      } else if (state) {
        this.update(entry, {
          title: state.title ?? entry.title,
          hasForegroundProcess: state.status === 'running' ? null : false
        })
      }
    })
  }

  private stopRuntime(entry: TerminalMetadataEntry): void {
    const runtimeScope = entry.runtimeScope
    entry.runtimeScope = null

    if (runtimeScope) {
      this.service.forkApplicationEffect(Scope.close(runtimeScope, Exit.void))
    }

    this.update(entry, {
      activity:
        entry.activity.state === 'idle'
          ? entry.activity
          : { ...IDLE_ACTIVITY, since: new Date().toISOString() },
      hasForegroundProcess: entry.status === 'running' ? null : false
    })
  }

  private recordAttention(
    entry: TerminalMetadataEntry,
    observed: { sequence: number; at: string; reason: TerminalAttentionReason },
    live = false
  ): Effect.Effect<void, unknown, ApplicationServices> {
    return this.service.terminalMetadataMutation(
      entry.terminalId,
      Effect.gen(this, function* () {
        const restated = observed.sequence === entry.attention?.sequence

        if (
          this.entries.get(entry.terminalId) !== entry ||
          observed.sequence < (entry.attention?.sequence ?? 0) ||
          (restated && observed.reason === entry.attention?.reason)
        ) {
          return
        }

        yield* Effect.sync(() => {
          this.attentionDeletionVersions.set(
            entry.terminalId,
            (this.attentionDeletionVersions.get(entry.terminalId) ?? 0) + 1
          )
        })

        const attention = {
          sequence: observed.sequence,
          at: observed.at,
          unread: restated ? entry.attention!.unread : true,
          reason: observed.reason
        }

        const state = {
          terminalId: entry.terminalId,
          worktreeId: entry.worktreeId,
          sequence: attention.sequence,
          occurredAt: attention.at,
          reason: attention.reason,
          unread: attention.unread
        }

        yield* this.attentionStateStore.upsert(state).pipe(Effect.orDie)
        yield* Effect.sync(() => {
          this.persistedAttention.set(entry.terminalId, state)

          if (this.entries.get(entry.terminalId) === entry) {
            entry.attention = attention
            this.publish(entry)

            if (live && !restated) {
              const metadata = this.metadata(entry)
              this.attentionListeners.forEach((listener) => listener(metadata))
            }
          }
        })
      })
    )
  }

  private reconcileTitleState(
    entry: TerminalMetadataEntry,
    state: TerminalTitleState
  ): void {
    entry.terminalTitle = state.terminalTitle?.trim().slice(0, 256) || null
    entry.currentCommand = state.currentCommand?.trim().slice(0, 256) || null
    entry.commandLine = state.commandLine?.trim().slice(0, 256) || null

    const commandLine =
      entry.commandLine ??
      (entry.commandExitCode === null ? entry.launchCommandLine : null)

    const token = commandLine?.match(
      /^(?:exec\s+|command\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/
    )

    const executable = token
      ? token[1] || token[2] || token[3] || null
      : entry.currentCommand

    const observedProgram =
      PROGRAM_COMMANDS.get(path.basename(executable ?? '').replace(/^-/, '')) ??
      null

    const shellIdle = commandLine === null

    this.update(entry, {
      title: shellIdle
        ? entry.terminalTitle
        : (entry.terminalTitle ?? commandLine ?? entry.currentCommand),
      program: observedProgram,
      hasForegroundProcess:
        entry.status !== 'running'
          ? false
          : shellIdle
            ? false
            : commandLine === null && entry.currentCommand === null
              ? null
              : true
    })
  }

  private update(
    entry: TerminalMetadataEntry,
    patch: Partial<
      Pick<
        TerminalRuntimeMetadata,
        'title' | 'program' | 'activity' | 'hasForegroundProcess'
      >
    >
  ): void {
    if (this.entries.get(entry.terminalId) !== entry) {
      return
    }

    const title =
      patch.title === undefined
        ? entry.title
        : patch.title?.trim().slice(0, 256) || null

    const program = patch.program === undefined ? entry.program : patch.program
    const activity = patch.activity ?? entry.activity

    const hasForegroundProcess =
      patch.hasForegroundProcess === undefined
        ? entry.hasForegroundProcess
        : patch.hasForegroundProcess

    if (
      title === entry.title &&
      program === entry.program &&
      activity.state === entry.activity.state &&
      activity.kind === entry.activity.kind &&
      activity.progress === entry.activity.progress &&
      activity.app === entry.activity.app &&
      activity.message === entry.activity.message &&
      activity.since === entry.activity.since &&
      hasForegroundProcess === entry.hasForegroundProcess
    ) {
      return
    }

    entry.title = title
    entry.program = program
    entry.activity = activity
    entry.hasForegroundProcess = hasForegroundProcess
    this.publish(entry)
  }

  private metadata(entry: TerminalMetadataEntry): TerminalRuntimeMetadata {
    return {
      terminalId: entry.terminalId,
      title: entry.title,
      program: entry.program,
      hasForegroundProcess: entry.hasForegroundProcess,
      activity: entry.activity,
      attention: entry.attention
    }
  }

  private publish(entry: TerminalMetadataEntry): void {
    const metadata = this.metadata(entry)
    this.listeners
      .get(entry.terminalId)
      ?.forEach((listener) => listener(metadata))
    this.service.events.publish('terminal.metadata', metadata)
  }
}
