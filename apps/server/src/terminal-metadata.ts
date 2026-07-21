import path from 'node:path'
import type {
  ProductEvent,
  TerminalRecord,
  TerminalRuntimeMetadata,
  WorktreeRecord
} from '@tasktty/shared'
import type {
  TaskTTYService,
  TmuxAdapter,
  TmuxSessionTitleState
} from '@tasktty/core'
import { DomainError, resolveExecutablePath } from '@tasktty/core'
import { progressControlAttachArgs } from './tmux-control.js'
import {
  createTmuxProgressObserver,
  type TerminalProgressObserver,
  type TerminalProgressObserverFactory
} from './tmux-progress.js'

export const TERMINAL_METADATA_POLL_MS = 2_000

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

interface TerminalMetadataEntry extends TerminalRuntimeMetadata {
  worktreeId: string
  socketName: string
  sessionName: string
  cwd: string
  status: TerminalRecord['status']
  paneTitle: string | null
  currentCommand: string | null
  shellCommand: string | null
  shellTitle: string | null
  applicationTitleActive: boolean
  observedTitlePending: boolean
  titleRevision: number
  observer: TerminalProgressObserver | null
  observerVersion: number
  poll: NodeJS.Timeout | null
  polling: boolean
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
  private readonly tmuxExecutable: string
  private initializePromise: Promise<void> | null = null
  private unsubscribeEvents: (() => void) | null = null
  private disposed = false

  constructor(
    private readonly service: TaskTTYService,
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
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null,
        paneTitle: null,
        currentCommand: null,
        shellCommand: SHELL_COMMANDS.has(
          path.basename(terminal.argv?.[0] ?? '').replace(/^-/, '')
        )
          ? path.basename(terminal.argv?.[0] ?? '').replace(/^-/, '')
          : null,
        shellTitle: null,
        applicationTitleActive: false,
        observedTitlePending: false,
        titleRevision: 0,
        observer: null,
        observerVersion: 0,
        poll: null,
        polling: false
      }
      this.entries.set(terminal.id, entry)
      if (terminal.status === 'running') {
        this.startRuntime(entry)
      }

      const observedEntry = entry
      const titleRevision = entry.titleRevision
      const observerVersion = entry.observerVersion
      const titleState = await this.tmux
        .sessionTitleState(worktree.tmuxSocketName, terminal.tmuxSessionName)
        .catch(() => null)
      if (this.entries.get(terminal.id) !== observedEntry) {
        return
      }

      if (
        titleState &&
        observedEntry.titleRevision === titleRevision &&
        observedEntry.observerVersion === observerVersion
      ) {
        this.reconcileTitleState(observedEntry, titleState)
      }
    } else {
      entry.worktreeId = terminal.worktreeId
      entry.cwd = worktree.path
      entry.status = terminal.status
    }

    if (this.entries.get(terminal.id) !== entry) {
      return
    }

    if (entry.status === 'running') {
      this.startRuntime(entry)
    } else {
      this.stopRuntime(entry)
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
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: null
    } satisfies TerminalRuntimeMetadata
    this.listeners.get(terminalId)?.forEach((listener) => listener(cleared))
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
  }

  private handleProductEvent(event: ProductEvent): void {
    const terminalId =
      typeof event.data.terminalId === 'string' ? event.data.terminalId : null
    if (event.type === 'terminal.removed' && terminalId) {
      this.removeTerminal(terminalId)
      return
    }

    if (event.type === 'worktree.removed') {
      const worktreeId =
        typeof event.data.worktreeId === 'string' ? event.data.worktreeId : null
      if (worktreeId) {
        for (const entry of this.entries.values()) {
          if (entry.worktreeId === worktreeId) {
            this.removeTerminal(entry.terminalId)
          }
        }
      }

      return
    }

    if (
      (event.type === 'terminal.created' ||
        event.type === 'terminal.updated') &&
      terminalId
    ) {
      void this.service
        .getTerminal(terminalId)
        .then((terminal) => {
          const worktree = this.service.database.worktree(terminal.worktreeId)
          if (worktree) {
            return this.trackTerminal(terminal, worktree)
          }
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

  private startRuntime(entry: TerminalMetadataEntry): void {
    if (!entry.observer) {
      const version = ++entry.observerVersion
      let exited = false
      try {
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
              entry.observerVersion === version
            ) {
              entry.paneTitle = title.trim().slice(0, 256) || null
              entry.observedTitlePending = true
              this.update(entry, { title: entry.paneTitle })
            }
          },
          onProgress: (progress) => {
            if (
              this.entries.get(entry.terminalId) === entry &&
              entry.observerVersion === version
            ) {
              this.update(entry, { progress })
            }
          },
          onBell: () => {
            if (
              this.entries.get(entry.terminalId) === entry &&
              entry.observerVersion === version
            ) {
              entry.bell = {
                sequence: (entry.bell?.sequence ?? 0) + 1,
                at: new Date().toISOString()
              }
              this.publish(entry)
            }
          },
          onExit: () => {
            exited = true
            if (
              this.entries.get(entry.terminalId) !== entry ||
              entry.observerVersion !== version
            ) {
              return
            }

            entry.observerVersion += 1
            entry.observer = null
            this.update(entry, { progress: null })
          }
        })
        if (
          exited ||
          this.entries.get(entry.terminalId) !== entry ||
          entry.observerVersion !== version
        ) {
          observer.dispose()
        } else {
          entry.observer = observer
        }
      } catch {
        entry.observer = null
      }
    }

    if (!entry.poll) {
      entry.poll = setInterval(
        () => void this.poll(entry),
        TERMINAL_METADATA_POLL_MS
      )
      entry.poll.unref()
    }
  }

  private stopRuntime(entry: TerminalMetadataEntry): void {
    if (entry.poll) {
      clearInterval(entry.poll)
    }

    entry.poll = null
    entry.observerVersion += 1
    entry.observer?.dispose()
    entry.observer = null
    this.update(entry, { progress: null })
  }

  private async poll(entry: TerminalMetadataEntry): Promise<void> {
    if (entry.polling || this.entries.get(entry.terminalId) !== entry) {
      return
    }

    entry.polling = true
    const titleRevision = entry.titleRevision
    const observerVersion = entry.observerVersion
    try {
      const [terminal, titleState] = await Promise.all([
        this.service.refreshTerminalStatus(entry.terminalId, false),
        this.tmux.sessionTitleState(entry.socketName, entry.sessionName)
      ])
      if (
        this.entries.get(entry.terminalId) !== entry ||
        entry.observerVersion !== observerVersion
      ) {
        return
      }

      entry.status = terminal.status
      if (
        titleState &&
        entry.titleRevision === titleRevision &&
        entry.observerVersion === observerVersion
      ) {
        this.reconcileTitleState(entry, titleState)
      }

      if (terminal.status === 'running') {
        this.startRuntime(entry)
      } else {
        this.stopRuntime(entry)
      }
    } catch {
      // Reconciliation or a later poll will recover transient tmux failures.
    } finally {
      entry.polling = false
    }
  }

  private reconcileTitleState(
    entry: TerminalMetadataEntry,
    state: TmuxSessionTitleState
  ): void {
    const paneTitle = state.paneTitle?.trim().slice(0, 256) || null
    const currentCommand = state.currentCommand?.trim().slice(0, 256) || null
    const previousCommand = entry.currentCommand
    const paneTitleChanged = paneTitle !== entry.paneTitle
    const commandChanged = currentCommand !== previousCommand
    const observedTitlePending = entry.observedTitlePending

    entry.paneTitle = paneTitle
    entry.currentCommand = currentCommand
    entry.observedTitlePending = false

    if (!entry.shellCommand) {
      this.update(entry, { title: paneTitle ?? currentCommand })
      return
    }

    if (currentCommand === entry.shellCommand) {
      entry.applicationTitleActive = false
      if (
        observedTitlePending ||
        paneTitleChanged ||
        entry.shellTitle === null
      ) {
        entry.shellTitle = paneTitle
      }

      this.update(entry, {
        title: entry.shellTitle ?? paneTitle ?? currentCommand
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
      entry.shellTitle = paneTitle
    } else if (entry.applicationTitleActive) {
      return
    } else if (paneTitleChanged) {
      entry.applicationTitleActive = true
      this.update(entry, { title: paneTitle ?? currentCommand })
      return
    }

    this.update(entry, { title: currentCommand ?? paneTitle })
  }

  private update(
    entry: TerminalMetadataEntry,
    patch: Partial<Pick<TerminalRuntimeMetadata, 'title' | 'progress'>>
  ): void {
    if (this.entries.get(entry.terminalId) !== entry) {
      return
    }

    const title =
      patch.title === undefined
        ? entry.title
        : patch.title?.trim().slice(0, 256) || null
    const progress =
      patch.progress === undefined ? entry.progress : patch.progress
    const progressChanged =
      progress?.state !== entry.progress?.state ||
      progress?.value !== entry.progress?.value
    if (title === entry.title && !progressChanged) {
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
    entry.progress = progress
    this.publish(entry)
  }

  private metadata(entry: TerminalMetadataEntry): TerminalRuntimeMetadata {
    return {
      terminalId: entry.terminalId,
      title: entry.title,
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
