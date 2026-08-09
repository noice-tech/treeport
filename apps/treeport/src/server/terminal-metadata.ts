import path from 'node:path'
import type {
  ProductEvent,
  TerminalProgram,
  TerminalRecord,
  TerminalRuntimeMetadata,
  WorktreeRecord
} from '@treeport/shared'
import type {
  TreeportService,
  TmuxAdapter,
  TmuxSessionTitleState
} from './core/index'
import { DomainError, resolveExecutablePath } from './core/index'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import type * as Scope from 'effect/Scope'
import { progressControlAttachArgs } from './tmux-control'
import {
  createTmuxProgressObserver,
  type TerminalProgressObserver,
  type TerminalProgressObserverFactory
} from './tmux-progress'

export const TERMINAL_METADATA_POLL_MS = 2_000
export const TERMINAL_PROGRESS_STALE_MS = 5 * 60_000

const SHELL_COMMANDS = new Set([
  'ash',
  'bash',
  'csh',
  'dash',
  'elvish',
  'fish',
  'ksh',
  'mksh',
  'nu',
  'pwsh',
  'sh',
  'tcsh',
  'xonsh',
  'zsh'
])

type MetadataListener = (metadata: TerminalRuntimeMetadata) => void
type HistoryListener = (viewing: boolean) => void

type TerminalMetadataPhase =
  | 'create_observer'
  | 'initial_title_state'
  | 'refresh_status'
  | 'poll_title_state'
  | 'persist_shell_title'

class TerminalMetadataRuntimeError {
  readonly _tag = 'TerminalMetadataRuntimeError'

  constructor(
    readonly phase: TerminalMetadataPhase,
    readonly terminalId: string,
    readonly cause: unknown
  ) {}
}

interface TerminalMetadataEntry extends TerminalRuntimeMetadata {
  worktreeId: string
  socketName: string
  sessionName: string
  cwd: string
  status: TerminalRecord['status']
  paneTitle: string | null
  currentCommand: string | null
  commandLine: string | null
  shellCommand: string | null
  launchProgram: TerminalProgram | null
  shellTitle: string | null
  persistedShellTitle: string | null
  awaitingShellTitle: boolean
  shellTitleWriting: boolean
  applicationTitleActive: boolean
  observedTitlePending: boolean
  titleRevision: number
  acknowledgedBellSequence: number
  observer: TerminalProgressObserver | null
  observerVersion: number
  runtimeFiber: Fiber.RuntimeFiber<void, never> | null
  runtimeGeneration: number
  runtimeReady: Promise<void> | null
  progressLease: NodeJS.Timeout | null
  progressActivityGeneration: number
  viewingHistory: boolean
}

function tmuxEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && key !== 'TMUX' && key !== 'TMUX_PANE'
    )
  ) as NodeJS.ProcessEnv
}

/** Owns daemon-lifetime title/progress observers independently of browser terminal attachments. */
export class TerminalMetadataManager {
  private readonly entries = new Map<string, TerminalMetadataEntry>()
  private readonly listeners = new Map<string, Set<MetadataListener>>()
  private readonly historyListeners = new Map<string, Set<HistoryListener>>()
  private readonly tmuxExecutable: string
  private initializePromise: Promise<void> | null = null
  private unsubscribeEvents: (() => void) | null = null
  private disposed = false

  constructor(
    private readonly service: TreeportService,
    private readonly tmux: TmuxAdapter,
    tmuxExecutable: string,
    private readonly createObserver: TerminalProgressObserverFactory = createTmuxProgressObserver
  ) {
    this.tmuxExecutable = resolveExecutablePath(tmuxExecutable)
  }

  initialize(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise
    }

    this.unsubscribeEvents = this.service.events.subscribe((event) =>
      this.handleProductEvent(event)
    )
    this.initializePromise = this.service
      .listProjects()
      .then(async (projects) => {
        await Promise.all(
          projects.flatMap((project) =>
            project.worktrees.flatMap((worktree) =>
              worktree.terminals.map((terminal) =>
                this.trackTerminal(terminal, worktree)
              )
            )
          )
        )
      })
    return this.initializePromise
  }

  get(terminalId: string): TerminalRuntimeMetadata {
    const entry = this.entries.get(terminalId)
    return entry
      ? this.metadata(entry)
      : {
          terminalId,
          title: null,
          program: null,
          progress: null,
          progressStartedAt: null,
          progressClearedAt: null,
          bell: null
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

  viewingHistory(terminalId: string): boolean {
    return this.entries.get(terminalId)?.viewingHistory ?? false
  }

  subscribeHistory(terminalId: string, listener: HistoryListener): () => void {
    const listeners =
      this.historyListeners.get(terminalId) ?? new Set<HistoryListener>()
    listeners.add(listener)
    this.historyListeners.set(terminalId, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        this.historyListeners.delete(terminalId)
      }
    }
  }

  async trackTerminal(
    terminal: TerminalRecord,
    worktree: WorktreeRecord
  ): Promise<void> {
    if (this.disposed) {
      return
    }

    let entry = this.entries.get(terminal.id)
    if (
      entry &&
      (entry.socketName !== worktree.tmuxSocketName ||
        entry.sessionName !== terminal.tmuxSessionName)
    ) {
      this.removeTerminal(terminal.id)
      entry = undefined
    }

    if (!entry) {
      entry = {
        terminalId: terminal.id,
        worktreeId: terminal.worktreeId,
        socketName: worktree.tmuxSocketName,
        sessionName: terminal.tmuxSessionName,
        cwd: worktree.path,
        status: terminal.status,
        title: null,
        program:
          path.basename(terminal.argv?.[0] ?? '').replace(/^-/, '') === 'pi'
            ? 'pi'
            : null,
        hasForegroundProcess: terminal.status === 'running' ? null : false,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null,
        paneTitle: null,
        currentCommand: null,
        commandLine: null,
        shellCommand: SHELL_COMMANDS.has(
          path.basename(terminal.argv?.[0] ?? '').replace(/^-/, '')
        )
          ? path.basename(terminal.argv?.[0] ?? '').replace(/^-/, '')
          : null,
        launchProgram:
          path.basename(terminal.argv?.[0] ?? '').replace(/^-/, '') === 'pi'
            ? 'pi'
            : null,
        shellTitle: null,
        persistedShellTitle: null,
        awaitingShellTitle: false,
        shellTitleWriting: false,
        applicationTitleActive: false,
        observedTitlePending: false,
        titleRevision: 0,
        acknowledgedBellSequence: 0,
        observer: null,
        observerVersion: 0,
        runtimeFiber: null,
        runtimeGeneration: 0,
        runtimeReady: null,
        progressLease: null,
        progressActivityGeneration: 0,
        viewingHistory: false
      }
      this.entries.set(terminal.id, entry)
    } else {
      entry.worktreeId = terminal.worktreeId
      entry.cwd = worktree.path
      entry.status = terminal.status
      if (terminal.status !== 'running') {
        this.update(entry, { hasForegroundProcess: false })
      }
    }

    if (this.entries.get(terminal.id) !== entry) {
      return
    }

    if (entry.status === 'running') {
      await this.startRuntime(entry)
    } else {
      this.stopRuntime(entry)
    }
  }

  acknowledgeBell(terminalId: string, sequence: number): void {
    const entry = this.entries.get(terminalId)
    if (!entry) {
      throw new DomainError(
        'TERMINAL_NOT_FOUND',
        `Terminal not found: ${terminalId}`,
        404
      )
    }

    const latestSequence = entry.bell?.sequence ?? 0
    if (sequence > latestSequence) {
      throw new DomainError(
        'BELL_SEQUENCE_AHEAD',
        'Bell acknowledgement is ahead of the latest observed bell',
        409
      )
    }

    if (sequence <= entry.acknowledgedBellSequence) {
      return
    }

    entry.acknowledgedBellSequence = sequence
    if (entry.bell && sequence === latestSequence && entry.bell.unread) {
      entry.bell = { ...entry.bell, unread: false }
      this.publish(entry)
    }
  }

  removeTerminal(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) {
      return
    }

    this.entries.delete(terminalId)
    this.stopRuntime(entry)
    const cleared = {
      terminalId,
      title: null,
      program: null,
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: null
    } satisfies TerminalRuntimeMetadata
    this.listeners.get(terminalId)?.forEach((listener) => listener(cleared))
    this.historyListeners
      .get(terminalId)
      ?.forEach((listener) => listener(false))
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = null
    for (const terminalId of [...this.entries.keys()]) {
      this.removeTerminal(terminalId)
    }
    this.listeners.clear()
    this.historyListeners.clear()
  }

  private handleProductEvent(event: ProductEvent): void {
    if (event.type === 'terminal.removed') {
      this.removeTerminal(event.data.terminalId)
      return
    }

    if (event.type === 'worktree.removed') {
      for (const entry of this.entries.values()) {
        if (entry.worktreeId === event.data.worktreeId) {
          this.removeTerminal(entry.terminalId)
        }
      }

      return
    }

    if (
      event.type === 'terminal.created' ||
      event.type === 'terminal.updated'
    ) {
      const { terminalId } = event.data
      void this.service
        .getTerminal(terminalId)
        .then(async (terminal) => {
          const worktree = await this.service.getWorktree(terminal.worktreeId)
          return this.trackTerminal(terminal, worktree)
        })
        .catch((error: unknown) => {
          if (
            error instanceof DomainError &&
            error.code === 'TERMINAL_NOT_FOUND'
          ) {
            this.removeTerminal(terminalId)
          }
        })
    }
  }

  private startRuntime(entry: TerminalMetadataEntry): Promise<void> {
    if (entry.runtimeFiber) {
      return entry.runtimeReady ?? Promise.resolve()
    }

    const runtimeGeneration = ++entry.runtimeGeneration
    let markReady!: () => void
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })
    entry.runtimeReady = ready
    const isCurrent = () =>
      this.entries.get(entry.terminalId) === entry &&
      entry.runtimeGeneration === runtimeGeneration &&
      entry.status === 'running'

    const lifecycle = Effect.scoped(
      Effect.gen(this, function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => this.releaseRuntimeResources(entry))
        )
        yield* this.ensureObserver(entry, runtimeGeneration)

        const titleRevision = entry.titleRevision
        const titleState = yield* Effect.tryPromise({
          try: () =>
            this.tmux.sessionTitleState(entry.socketName, entry.sessionName),
          catch: (cause) =>
            new TerminalMetadataRuntimeError(
              'initial_title_state',
              entry.terminalId,
              cause
            )
        }).pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (isCurrent() && titleState) {
          this.updateForegroundProcess(entry, titleState.currentCommand)
          if (entry.titleRevision === titleRevision) {
            this.reconcileTitleState(entry, titleState)
            yield* this.persistShellTitle(entry, runtimeGeneration)
          }
        }

        markReady()

        while (isCurrent()) {
          yield* Effect.sleep(TERMINAL_METADATA_POLL_MS)
          if (!isCurrent()) {
            return
          }

          const polledTitleRevision = entry.titleRevision
          const [terminal, polledTitleState] = yield* Effect.all(
            [
              Effect.tryPromise({
                try: () =>
                  this.service.refreshTerminalStatus(entry.terminalId, false),
                catch: (cause) =>
                  new TerminalMetadataRuntimeError(
                    'refresh_status',
                    entry.terminalId,
                    cause
                  )
              }).pipe(Effect.catchAll(() => Effect.succeed(null))),
              Effect.tryPromise({
                try: () =>
                  this.tmux.sessionTitleState(
                    entry.socketName,
                    entry.sessionName
                  ),
                catch: (cause) =>
                  new TerminalMetadataRuntimeError(
                    'poll_title_state',
                    entry.terminalId,
                    cause
                  )
              }).pipe(Effect.catchAll(() => Effect.succeed(null)))
            ],
            { concurrency: 'unbounded' }
          )
          if (!isCurrent()) {
            return
          }

          if (terminal) {
            entry.status = terminal.status
          }

          if (polledTitleState) {
            this.updateForegroundProcess(entry, polledTitleState.currentCommand)
            if (entry.titleRevision === polledTitleRevision) {
              this.reconcileTitleState(entry, polledTitleState)
              yield* this.persistShellTitle(entry, runtimeGeneration)
            }
          }

          if (terminal?.status !== undefined && terminal.status !== 'running') {
            this.update(entry, { hasForegroundProcess: false })
            return
          }

          yield* this.ensureObserver(entry, runtimeGeneration)
        }
      })
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          markReady()
          if (entry.runtimeGeneration === runtimeGeneration) {
            entry.runtimeFiber = null
            entry.runtimeReady = null
          }
        })
      ),
      Effect.catchAll(() => Effect.void)
    )

    entry.runtimeFiber = Effect.runFork(lifecycle)
    return ready
  }

  private ensureObserver(
    entry: TerminalMetadataEntry,
    runtimeGeneration: number
  ): Effect.Effect<void> {
    if (entry.observer) {
      return Effect.void
    }

    return Effect.try({
      try: () => {
        const version = ++entry.observerVersion
        let exited = false
        const observer = this.createObserver({
          executable: this.tmuxExecutable,
          args: progressControlAttachArgs(
            entry.socketName,
            this.tmux.configPath,
            entry.sessionName
          ),
          cwd: entry.cwd,
          env: tmuxEnvironment(),
          onTitle: (title) => {
            if (
              this.entries.get(entry.terminalId) === entry &&
              entry.runtimeGeneration === runtimeGeneration &&
              entry.observerVersion === version
            ) {
              entry.paneTitle = title.trim().slice(0, 256) || null
              entry.observedTitlePending = true
              this.update(entry, { title: entry.paneTitle })
            }
          },
          onProgress: (progress) => {
            if (
              this.entries.get(entry.terminalId) !== entry ||
              entry.runtimeGeneration !== runtimeGeneration ||
              entry.observerVersion !== version
            ) {
              return
            }

            const activityGeneration = ++entry.progressActivityGeneration
            if (entry.progressLease) {
              clearTimeout(entry.progressLease)
              entry.progressLease = null
            }

            if (progress !== null) {
              entry.progressLease = setTimeout(() => {
                if (
                  this.entries.get(entry.terminalId) !== entry ||
                  entry.runtimeGeneration !== runtimeGeneration ||
                  entry.observerVersion !== version ||
                  entry.progressActivityGeneration !== activityGeneration
                ) {
                  return
                }

                entry.progressLease = null
                entry.progressActivityGeneration += 1
                this.update(entry, { progress: null })
              }, TERMINAL_PROGRESS_STALE_MS)
              entry.progressLease.unref()
            }

            this.update(entry, { progress })
          },
          onBell: () => {
            if (
              this.entries.get(entry.terminalId) === entry &&
              entry.runtimeGeneration === runtimeGeneration &&
              entry.observerVersion === version
            ) {
              entry.bell = {
                sequence: (entry.bell?.sequence ?? 0) + 1,
                at: new Date().toISOString(),
                unread: true
              }
              this.publish(entry)
            }
          },
          onHistoryChange: (viewing) => {
            if (
              this.entries.get(entry.terminalId) !== entry ||
              entry.runtimeGeneration !== runtimeGeneration ||
              entry.observerVersion !== version ||
              entry.viewingHistory === viewing
            ) {
              return
            }

            entry.viewingHistory = viewing
            this.historyListeners
              .get(entry.terminalId)
              ?.forEach((listener) => listener(viewing))
          },
          onExit: () => {
            exited = true
            if (
              this.entries.get(entry.terminalId) !== entry ||
              entry.runtimeGeneration !== runtimeGeneration ||
              entry.observerVersion !== version
            ) {
              return
            }

            entry.observerVersion += 1
            entry.observer = null
            entry.progressActivityGeneration += 1
            if (entry.progressLease) {
              clearTimeout(entry.progressLease)
              entry.progressLease = null
            }

            this.update(entry, { progress: null })
          }
        })
        if (
          exited ||
          this.entries.get(entry.terminalId) !== entry ||
          entry.runtimeGeneration !== runtimeGeneration ||
          entry.observerVersion !== version
        ) {
          observer.dispose()
        } else {
          entry.observer = observer
        }
      },
      catch: (cause) =>
        new TerminalMetadataRuntimeError(
          'create_observer',
          entry.terminalId,
          cause
        )
    }).pipe(
      Effect.asVoid,
      Effect.catchAll(() => {
        this.clearProgressRuntime(entry)
        return Effect.void
      })
    )
  }

  private stopRuntime(entry: TerminalMetadataEntry): void {
    entry.runtimeGeneration += 1
    const runtimeFiber = entry.runtimeFiber
    entry.runtimeFiber = null
    entry.runtimeReady = null
    if (runtimeFiber) {
      Effect.runFork(Fiber.interrupt(runtimeFiber))
    }

    this.releaseRuntimeResources(entry)
    this.update(entry, {
      progress: null,
      hasForegroundProcess: entry.status === 'running' ? null : false
    })
  }

  private clearProgressRuntime(entry: TerminalMetadataEntry): void {
    entry.progressActivityGeneration += 1
    if (entry.progressLease) {
      clearTimeout(entry.progressLease)
      entry.progressLease = null
    }

    this.update(entry, { progress: null })
  }

  private releaseRuntimeResources(entry: TerminalMetadataEntry): void {
    entry.observerVersion += 1
    entry.observer?.dispose()
    entry.observer = null
    this.clearProgressRuntime(entry)
    entry.shellTitleWriting = false
  }

  private reconcileTitleState(
    entry: TerminalMetadataEntry,
    state: TmuxSessionTitleState
  ): void {
    const paneTitle = state.paneTitle?.trim().slice(0, 256) || null
    const currentCommand = state.currentCommand?.trim().slice(0, 256) || null
    const commandLine = state.commandLine?.trim().slice(0, 256) || null
    const previousCommand = entry.currentCommand
    const previousCommandLine = entry.commandLine
    const paneTitleChanged = paneTitle !== entry.paneTitle
    const commandChanged = currentCommand !== previousCommand
    const commandLineChanged = commandLine !== previousCommandLine
    const observedTitlePending = entry.observedTitlePending
    if (previousCommand === null && entry.shellTitle === null) {
      const shellTitle = state.shellTitle?.trim().slice(0, 256) || null
      entry.shellTitle = shellTitle
      entry.persistedShellTitle = shellTitle
    }

    entry.paneTitle = paneTitle
    entry.currentCommand = currentCommand
    entry.commandLine = commandLine
    entry.observedTitlePending = false
    this.updateForegroundProcess(entry, currentCommand)
    const commandToken = commandLine?.match(
      /^(?:exec\s+|command\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/
    )
    const commandExecutable = commandToken
      ? commandToken[1] || commandToken[2] || commandToken[3] || null
      : null
    const observedProgram =
      path.basename(commandExecutable ?? '').replace(/^-/, '') === 'pi' ||
      path.basename(currentCommand ?? '').replace(/^-/, '') === 'pi'
        ? 'pi'
        : null
    this.update(entry, {
      program:
        observedProgram ?? (!entry.shellCommand ? entry.launchProgram : null)
    })

    if (!entry.shellCommand) {
      this.update(entry, { title: paneTitle ?? commandLine ?? currentCommand })
      return
    }

    if (currentCommand === entry.shellCommand) {
      const applicationTitleWasActive = entry.applicationTitleActive
      const freshShellTitle =
        observedTitlePending || (previousCommand !== null && paneTitleChanged)
      entry.applicationTitleActive = false
      if (freshShellTitle) {
        entry.shellTitle = paneTitle
        entry.awaitingShellTitle = false
      } else if (entry.shellTitle === null) {
        if (applicationTitleWasActive || entry.awaitingShellTitle) {
          entry.awaitingShellTitle = true
        } else {
          entry.shellTitle = paneTitle
        }
      }

      this.update(entry, {
        title: entry.shellTitle ?? currentCommand
      })
      return
    }

    if (commandLine) {
      if (observedTitlePending) {
        entry.applicationTitleActive =
          paneTitle !== null && paneTitle !== commandLine
      } else if (commandLineChanged) {
        entry.applicationTitleActive =
          previousCommand === null &&
          paneTitle !== null &&
          paneTitle !== commandLine &&
          paneTitle !== entry.shellTitle
      } else if (paneTitleChanged && paneTitle !== commandLine) {
        entry.applicationTitleActive = true
      }

      this.update(entry, {
        title: entry.applicationTitleActive
          ? (paneTitle ?? entry.title ?? commandLine)
          : commandLine
      })
      return
    }

    if (observedTitlePending) {
      entry.applicationTitleActive = true
      this.update(entry, { title: entry.title ?? paneTitle ?? currentCommand })
      return
    }

    if (!commandChanged) {
      if (paneTitleChanged) {
        entry.applicationTitleActive = true
        this.update(entry, { title: paneTitle ?? currentCommand })
      }

      return
    }

    if (previousCommand === null) {
      if (
        paneTitle &&
        (entry.shellTitle === null || paneTitle !== entry.shellTitle)
      ) {
        // Without a remembered shell title, an existing OSC title and a stale
        // shell title are indistinguishable. Preserve the reported title.
        entry.applicationTitleActive = true
        this.update(entry, { title: paneTitle })
        return
      }
    } else if (entry.applicationTitleActive) {
      return
    } else if (paneTitleChanged) {
      entry.applicationTitleActive = true
      this.update(entry, { title: paneTitle ?? currentCommand })
      return
    }

    this.update(entry, { title: currentCommand ?? paneTitle })
  }

  private updateForegroundProcess(
    entry: TerminalMetadataEntry,
    currentCommand: string | null
  ): void {
    const command = currentCommand?.trim().slice(0, 256) || null
    this.update(entry, {
      hasForegroundProcess:
        entry.status !== 'running'
          ? false
          : command === null
            ? null
            : command !== entry.shellCommand
    })
  }

  private persistShellTitle(
    entry: TerminalMetadataEntry,
    runtimeGeneration: number
  ): Effect.Effect<void, never, Scope.Scope> {
    return Effect.gen(this, function* () {
      if (
        entry.shellTitleWriting ||
        entry.shellTitle === entry.persistedShellTitle ||
        this.entries.get(entry.terminalId) !== entry ||
        entry.runtimeGeneration !== runtimeGeneration
      ) {
        return
      }

      entry.shellTitleWriting = true
      yield* Effect.forkScoped(
        Effect.gen(this, function* () {
          while (
            this.entries.get(entry.terminalId) === entry &&
            entry.runtimeGeneration === runtimeGeneration &&
            entry.shellTitle !== entry.persistedShellTitle
          ) {
            const shellTitle = entry.shellTitle
            const written = yield* Effect.tryPromise({
              try: () =>
                this.tmux.setSessionShellTitle(
                  entry.socketName,
                  entry.sessionName,
                  shellTitle
                ),
              catch: (cause) =>
                new TerminalMetadataRuntimeError(
                  'persist_shell_title',
                  entry.terminalId,
                  cause
                )
            }).pipe(
              Effect.as(true),
              Effect.catchAll(() => Effect.succeed(false))
            )
            if (!written) {
              return
            }

            if (
              this.entries.get(entry.terminalId) === entry &&
              entry.runtimeGeneration === runtimeGeneration
            ) {
              entry.persistedShellTitle = shellTitle
            }
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (entry.runtimeGeneration === runtimeGeneration) {
                entry.shellTitleWriting = false
              }
            })
          )
        )
      )
    })
  }

  private update(
    entry: TerminalMetadataEntry,
    patch: Partial<
      Pick<
        TerminalRuntimeMetadata,
        'title' | 'program' | 'progress' | 'hasForegroundProcess'
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
    const progress =
      patch.progress === undefined ? entry.progress : patch.progress
    const progressChanged =
      progress?.state !== entry.progress?.state ||
      progress?.value !== entry.progress?.value
    const hasForegroundProcess =
      patch.hasForegroundProcess === undefined
        ? entry.hasForegroundProcess
        : patch.hasForegroundProcess
    const foregroundProcessChanged =
      hasForegroundProcess !== entry.hasForegroundProcess
    if (
      title === entry.title &&
      program === entry.program &&
      !progressChanged &&
      !foregroundProcessChanged
    ) {
      return
    }

    if (title !== entry.title) {
      entry.titleRevision += 1
    }

    if (progressChanged) {
      const now = new Date().toISOString()
      if (entry.progress === null && progress !== null) {
        entry.progressStartedAt = now
      } else if (entry.progress !== null && progress === null) {
        entry.progressClearedAt = now
      }
    }

    entry.title = title
    entry.program = program
    entry.hasForegroundProcess = hasForegroundProcess
    entry.progress = progress
    this.publish(entry)
  }

  private metadata(entry: TerminalMetadataEntry): TerminalRuntimeMetadata {
    return {
      terminalId: entry.terminalId,
      title: entry.title,
      program: entry.program,
      hasForegroundProcess: entry.hasForegroundProcess,
      progress: entry.progress,
      progressStartedAt: entry.progressStartedAt,
      progressClearedAt: entry.progressClearedAt,
      bell: entry.bell
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
