import path from 'node:path'
import {
  formatCommandLine,
  type ProductEvent,
  type TerminalProgram,
  type TerminalRecord,
  type TerminalRuntimeMetadata,
  type WorktreeRecord
} from '@treeport/shared'
import type { TreeportService } from './core/index'
import { DomainError } from './core/index'
import { KeyedTaskQueue } from './core/task-queue'
import {
  DatabaseTerminalBellStateStore,
  type TerminalBellState,
  type TerminalBellStateStore
} from './core/terminal-bell-state-store'
import type { TerminalTitleState } from './core/terminal'
import type { TerminalAttachmentBackend } from './terminal-host-sessions'

const PROGRAM_COMMANDS = new Map<string, TerminalProgram>([
  ['pi', 'pi'],
  ['claude', 'claude'],
  ['codex', 'codex']
])

type MetadataListener = (metadata: TerminalRuntimeMetadata) => void

interface TerminalMetadataEntry extends TerminalRuntimeMetadata {
  worktreeId: string
  status: TerminalRecord['status']
  terminalTitle: string | null
  currentCommand: string | null
  commandLine: string | null
  launchCommandLine: string | null
  interactiveShellCommand: string | null
  launchProgram: TerminalProgram | null
  runtimeUnsubscribe: (() => void) | null
  acknowledgedBellSequence: number
}

/**
 * Projects terminal-host runtime events into the product metadata contract.
 * The terminal host remains the only parser and process owner; this manager
 * only persists BEL state and publishes title/progress changes.
 */
export class TerminalMetadataManager {
  private readonly entries = new Map<string, TerminalMetadataEntry>()
  private readonly listeners = new Map<string, Set<MetadataListener>>()
  private readonly bellMutations = new KeyedTaskQueue<string>()
  private readonly bellDeletionVersions = new Map<string, number>()
  private readonly persistedBells = new Map<string, TerminalBellState>()
  private readonly bellStateStore: TerminalBellStateStore
  private initializePromise: Promise<void> | null = null
  private unsubscribeEvents: (() => void) | null = null
  private disposed = false

  constructor(
    private readonly service: TreeportService,
    private readonly terminalHost: TerminalAttachmentBackend,
    bellStateStore?: TerminalBellStateStore
  ) {
    this.bellStateStore =
      bellStateStore ?? new DatabaseTerminalBellStateStore(service.database)
  }

  initialize(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise
    }

    this.initializePromise = this.bellStateStore.load().then(async (states) => {
      for (const state of states) {
        this.persistedBells.set(state.terminalId, state)
      }

      this.unsubscribeEvents = this.service.events.subscribe((event) =>
        this.handleProductEvent(event)
      )
      const projects = await this.service.listProjects()
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

  async trackTerminal(
    terminal: TerminalRecord,
    _worktree: WorktreeRecord
  ): Promise<void> {
    if (this.disposed) {
      return
    }

    let entry = this.entries.get(terminal.id)
    if (!entry) {
      const launchCommand = path
        .basename(terminal.argv[0] ?? '')
        .replace(/^-/, '')
      const launchProgram =
        !terminal.interactiveShell && terminal.shellCommand === null
          ? (PROGRAM_COMMANDS.get(launchCommand) ?? null)
          : null
      const launchCommandLine = terminal.interactiveShell
        ? null
        : (
            terminal.shellCommand?.replace(/\p{Cc}/gu, '') ??
            formatCommandLine(
              terminal.argv.map((value) => value.replace(/\p{Cc}/gu, ''))
            )
          )
            .trim()
            .slice(0, 256) || null
      const persistedBell = this.persistedBells.get(terminal.id)
      const bell =
        persistedBell?.worktreeId === terminal.worktreeId
          ? {
              sequence: persistedBell.sequence,
              at: persistedBell.occurredAt,
              unread: persistedBell.unread
            }
          : null
      this.bellDeletionVersions.set(
        terminal.id,
        (this.bellDeletionVersions.get(terminal.id) ?? 0) + 1
      )
      entry = {
        terminalId: terminal.id,
        worktreeId: terminal.worktreeId,
        status: terminal.status,
        title: launchCommandLine,
        program: launchProgram,
        hasForegroundProcess: terminal.status === 'running' ? null : false,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell,
        terminalTitle: null,
        currentCommand: null,
        commandLine: null,
        launchCommandLine,
        interactiveShellCommand: terminal.interactiveShell
          ? launchCommand
          : null,
        launchProgram,
        runtimeUnsubscribe: null,
        acknowledgedBellSequence: bell
          ? bell.unread
            ? bell.sequence - 1
            : bell.sequence
          : 0
      }
      this.entries.set(terminal.id, entry)
    } else {
      entry.worktreeId = terminal.worktreeId
      entry.status = terminal.status
    }

    if (entry.status === 'running') {
      await this.startRuntime(entry)
    } else {
      this.stopRuntime(entry)
    }
  }

  async acknowledgeBell(terminalId: string, sequence: number): Promise<void> {
    await this.bellMutations.enqueue(terminalId, async () => {
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

      if (entry.bell && sequence === latestSequence && entry.bell.unread) {
        await this.bellStateStore.markRead(terminalId, sequence)
        const persisted = this.persistedBells.get(terminalId)
        if (persisted?.sequence === sequence) {
          this.persistedBells.set(terminalId, { ...persisted, unread: false })
        }

        if (this.entries.get(terminalId) === entry) {
          entry.bell = { ...entry.bell, unread: false }
          entry.acknowledgedBellSequence = sequence
          this.publish(entry)
        }

        return
      }

      entry.acknowledgedBellSequence = sequence
    })
  }

  removeTerminal(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry && !this.persistedBells.has(terminalId)) {
      return
    }

    this.entries.delete(terminalId)
    if (entry) {
      this.stopRuntime(entry)
    }

    const deletionVersion = (this.bellDeletionVersions.get(terminalId) ?? 0) + 1
    this.bellDeletionVersions.set(terminalId, deletionVersion)
    void this.bellMutations
      .enqueue(terminalId, async () => {
        if (this.bellDeletionVersions.get(terminalId) !== deletionVersion) {
          return
        }

        await this.bellStateStore.delete(terminalId)
        this.persistedBells.delete(terminalId)
      })
      .catch((error) => {
        console.error(
          `[Treeport] Failed to delete terminal bell state for ${terminalId}:`,
          error instanceof Error ? error.message : String(error)
        )
      })

    if (entry) {
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
  }

  async drain(): Promise<void> {
    await this.bellMutations.drain()
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
    void this.service
      .getTerminal(terminalId)
      .then(async (terminal) => {
        const worktree = await this.service.getWorktree(terminal.worktreeId)
        return this.trackTerminal(terminal, worktree)
      })
      .catch((error) => {
        if (
          error instanceof DomainError &&
          error.code === 'TERMINAL_NOT_FOUND'
        ) {
          this.removeTerminal(terminalId)
        }
      })
  }

  private async startRuntime(entry: TerminalMetadataEntry): Promise<void> {
    if (entry.runtimeUnsubscribe) {
      return
    }

    entry.runtimeUnsubscribe = await this.terminalHost.subscribeRuntime(
      entry.terminalId,
      (event) => {
        if (event.titleState) {
          this.reconcileTitleState(entry, event.titleState)
        } else if (event.title !== undefined) {
          entry.terminalTitle = event.title
          this.update(entry, { title: event.title })
        }

        if (event.progress !== undefined) {
          this.setProgress(entry, event.progress)
        }

        if (event.bell) {
          void this.recordBell(entry, event.bell).catch((error) => {
            console.error(
              `[Treeport] Failed to persist terminal bell for ${entry.terminalId}:`,
              error instanceof Error ? error.message : String(error)
            )
          })
        }

        if ('exitCode' in event) {
          entry.status = 'exited'
          this.stopRuntime(entry)
        }
      }
    )
    const [state, titleState] = await Promise.all([
      this.terminalHost.runtimeState(entry.terminalId),
      this.terminalHost.terminalTitleState(entry.terminalId)
    ])
    if (this.entries.get(entry.terminalId) !== entry) {
      return
    }

    if (state) {
      this.setProgress(entry, state.progress)
      if (state.bell) {
        await this.recordBell(entry, state.bell)
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
  }

  private stopRuntime(entry: TerminalMetadataEntry): void {
    entry.runtimeUnsubscribe?.()
    entry.runtimeUnsubscribe = null
    this.update(entry, {
      progress: null,
      hasForegroundProcess: entry.status === 'running' ? null : false
    })
  }

  private setProgress(
    entry: TerminalMetadataEntry,
    progress: TerminalRuntimeMetadata['progress']
  ): void {
    this.update(entry, { progress })
  }

  private async recordBell(
    entry: TerminalMetadataEntry,
    observed: { sequence: number; at: string }
  ): Promise<void> {
    await this.bellMutations.enqueue(entry.terminalId, async () => {
      if (
        this.entries.get(entry.terminalId) !== entry ||
        observed.sequence <= (entry.bell?.sequence ?? 0)
      ) {
        return
      }

      this.bellDeletionVersions.set(
        entry.terminalId,
        (this.bellDeletionVersions.get(entry.terminalId) ?? 0) + 1
      )
      const bell = {
        sequence: observed.sequence,
        at: observed.at,
        unread: true
      }
      const state = {
        terminalId: entry.terminalId,
        worktreeId: entry.worktreeId,
        sequence: bell.sequence,
        occurredAt: bell.at,
        unread: true
      }
      await this.bellStateStore.upsert(state)
      this.persistedBells.set(entry.terminalId, state)
      if (this.entries.get(entry.terminalId) === entry) {
        entry.bell = bell
        this.publish(entry)
      }
    })
  }

  private reconcileTitleState(
    entry: TerminalMetadataEntry,
    state: TerminalTitleState
  ): void {
    entry.terminalTitle = state.terminalTitle?.trim().slice(0, 256) || null
    entry.currentCommand = state.currentCommand?.trim().slice(0, 256) || null
    entry.commandLine =
      state.commandLine?.trim().slice(0, 256) || entry.launchCommandLine

    const token = entry.commandLine?.match(
      /^(?:exec\s+|command\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/
    )
    const executable = token
      ? token[1] || token[2] || token[3] || null
      : entry.currentCommand
    const observedProgram =
      PROGRAM_COMMANDS.get(path.basename(executable ?? '').replace(/^-/, '')) ??
      null
    const shellIdle =
      entry.interactiveShellCommand !== null &&
      (entry.commandLine === null ||
        entry.commandLine === entry.interactiveShellCommand)
    this.update(entry, {
      title: shellIdle
        ? (entry.terminalTitle ?? entry.interactiveShellCommand)
        : (entry.terminalTitle ?? entry.commandLine ?? entry.currentCommand),
      program:
        observedProgram ??
        (entry.interactiveShellCommand === null ? entry.launchProgram : null),
      hasForegroundProcess:
        entry.status !== 'running'
          ? false
          : shellIdle
            ? false
            : entry.commandLine === null && entry.currentCommand === null
              ? null
              : true
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
    const hasForegroundProcess =
      patch.hasForegroundProcess === undefined
        ? entry.hasForegroundProcess
        : patch.hasForegroundProcess
    const progressChanged =
      progress?.state !== entry.progress?.state ||
      progress?.value !== entry.progress?.value
    if (
      title === entry.title &&
      program === entry.program &&
      !progressChanged &&
      hasForegroundProcess === entry.hasForegroundProcess
    ) {
      return
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
    entry.progress = progress
    entry.hasForegroundProcess = hasForegroundProcess
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
