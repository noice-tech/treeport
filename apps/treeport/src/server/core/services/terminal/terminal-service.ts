import crypto from 'node:crypto'
import path from 'node:path'
import type {
  ProjectRecord,
  TerminalRecord,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import type { AppConfig } from '../../config'
import { DomainError } from '../../domain'
import type { ProductEventBus } from '../../events'
import type { WorktreeSetupTask } from '../../setup'
import type { TerminalSessionBackend } from '../../terminal'
import type {
  PromiseMutationLocks,
  PromiseMutationQueue
} from '../infrastructure/application-runtime'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

export interface TerminalLaunchOptions {
  setup?: { tasks: WorktreeSetupTask[]; error: string | null }
  initialTitle?: string
  returnToShell?: boolean
  closeOnSuccess?: boolean
  initialSize?: TerminalSize
  cwd?: string
  env?: Record<string, string>
  shellCommand?: string
}

export interface TerminalServiceDependencies {
  readonly config: AppConfig
  readonly terminalHost: TerminalSessionBackend
  readonly events: ProductEventBus
  readonly locks: PromiseMutationLocks
  readonly worktreeMutations: PromiseMutationQueue
  readonly terminalMutations: PromiseMutationQueue
  readonly storedProjects: (openOnly?: boolean) => Promise<ProjectRecord[]>
  readonly storedWorktree: (
    worktreeId: string
  ) => Promise<WorktreeRecord | null>
  readonly projectOpenState: (projectId: string) => Promise<boolean | null>
  readonly getProject: (projectId: string) => Promise<ProjectRecord>
  readonly getWorktree: (worktreeId: string) => Promise<WorktreeRecord>
  readonly requireOpenProject: (projectId: string) => Promise<ProjectRecord>
  readonly requireAvailableWorktree: (
    worktreeId: string,
    allowPrunable?: boolean
  ) => Promise<WorktreeRecord>
  readonly listProjects: () => Promise<ProjectRecord[]>
  readonly invalidateProjectsSnapshot: () => void
  readonly drainMutations: () => Promise<void>
}

export class TerminalService {
  private readonly terminalStates = new Map<string, TerminalRecord>()
  private readonly closeOnSuccessTerminalIds = new Set<string>()
  private readonly terminalIdsByWorktree = new Map<string, Set<string>>()

  constructor(private readonly host: TerminalServiceDependencies) {}

  private get deps() {
    return this.host
  }

  private get events() {
    return this.host.events
  }

  private get locks() {
    return this.host.locks
  }

  private get worktreeMutations() {
    return this.host.worktreeMutations
  }

  private get terminalMutations() {
    return this.host.terminalMutations
  }

  private storedProjects(openOnly = false) {
    return this.host.storedProjects(openOnly)
  }

  private storedWorktree(worktreeId: string) {
    return this.host.storedWorktree(worktreeId)
  }

  private projectOpenState(projectId: string) {
    return this.host.projectOpenState(projectId)
  }

  private getProject(projectId: string) {
    return this.host.getProject(projectId)
  }

  private getWorktree(worktreeId: string) {
    return this.host.getWorktree(worktreeId)
  }

  private requireOpenProject(projectId: string) {
    return this.host.requireOpenProject(projectId)
  }

  private requireAvailableWorktree(worktreeId: string, allowPrunable = false) {
    return this.host.requireAvailableWorktree(worktreeId, allowPrunable)
  }

  private listProjects() {
    return this.host.listProjects()
  }

  private invalidateProjectsSnapshot() {
    this.host.invalidateProjectsSnapshot()
  }

  private drainMutations() {
    return this.host.drainMutations()
  }

  trackedTerminalIds(worktreeId: string): Set<string> {
    return new Set(this.terminalIdsByWorktree.get(worktreeId) ?? [])
  }

  rememberTerminalIds(worktreeId: string, terminalIds: Iterable<string>): void {
    this.terminalIdsByWorktree.set(worktreeId, new Set(terminalIds))
  }

  clearWorktreeTerminalState(
    worktreeId: string,
    discoveredTerminalIds: Iterable<string> = []
  ): void {
    const terminalIds = new Set([
      ...(this.terminalIdsByWorktree.get(worktreeId) ?? []),
      ...discoveredTerminalIds
    ])
    for (const terminalId of terminalIds) {
      this.terminalStates.delete(terminalId)
      this.closeOnSuccessTerminalIds.delete(terminalId)
      this.events.publish('terminal.removed', { worktreeId, terminalId })
    }
    this.terminalIdsByWorktree.delete(worktreeId)
  }

  async listWorktreeTerminals(
    worktree: WorktreeRecord
  ): Promise<TerminalRecord[]> {
    let sessions = (
      await this.deps.terminalHost.listTerminals(worktree.id)
    ).filter((terminal) => terminal.worktreeId === worktree.id)
    if (!(await this.locks.isWorktreeLocked(worktree.id))) {
      for (const terminal of sessions) {
        if (
          sessions.length <= 1 ||
          !terminal.closeOnSuccess ||
          terminal.status !== 'exited' ||
          terminal.exitCode !== 0
        ) {
          continue
        }

        await this.deps.terminalHost.killTerminal(terminal.id)
        sessions = sessions.filter((candidate) => candidate.id !== terminal.id)
      }
    }

    const terminals = sessions
      .map((terminal) => {
        if (terminal.closeOnSuccess) {
          this.closeOnSuccessTerminalIds.add(terminal.id)
        } else {
          this.closeOnSuccessTerminalIds.delete(terminal.id)
        }

        return {
          id: terminal.id,
          worktreeId: terminal.worktreeId,
          name: terminal.name,
          argv: terminal.argv,
          shellCommand: terminal.shellCommand,
          interactiveShell: terminal.interactiveShell,
          status: terminal.status,
          exitCode: terminal.exitCode,
          createdAt: terminal.createdAt,
          updatedAt: terminal.updatedAt
        }
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    if (await this.locks.isWorktreeLocked(worktree.id)) {
      return terminals
    }

    const previousIds = this.terminalIdsByWorktree.get(worktree.id)
    const currentIds = new Set(terminals.map((terminal) => terminal.id))
    for (const terminal of terminals) {
      const previous = this.terminalStates.get(terminal.id)
      this.terminalStates.set(terminal.id, terminal)
      if (
        previous &&
        (previous.status !== terminal.status ||
          previous.exitCode !== terminal.exitCode)
      ) {
        this.events.publish('terminal.updated', {
          worktreeId: worktree.id,
          terminalId: terminal.id
        })
      }
    }
    for (const terminalId of previousIds ?? []) {
      if (!currentIds.has(terminalId)) {
        this.terminalStates.delete(terminalId)
        this.closeOnSuccessTerminalIds.delete(terminalId)
        this.events.publish('terminal.removed', {
          worktreeId: worktree.id,
          terminalId
        })
      }
    }
    this.terminalIdsByWorktree.set(worktree.id, currentIds)
    return terminals
  }

  async getTerminal(terminalId: string): Promise<TerminalRecord> {
    const matches = (await this.listProjects())
      .flatMap((project) => project.worktrees)
      .flatMap((worktree) => worktree.terminals)
      .filter((terminal) => terminal.id === terminalId)

    if (matches.length > 1) {
      throw new DomainError(
        'TERMINAL_ID_CONFLICT',
        'Terminal ID is present in more than one terminal host',
        500
      )
    }

    if (matches[0]) {
      return matches[0]
    }

    throw new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
  }

  async getTerminalFromBindings(terminalId: string): Promise<TerminalRecord> {
    const known = this.terminalStates.get(terminalId)
    if (known) {
      const worktree = await this.storedWorktree(known.worktreeId)
      if (worktree) {
        await this.requireOpenProject(worktree.projectId)
        const terminal = (await this.listWorktreeTerminals(worktree)).find(
          (candidate) => candidate.id === terminalId
        )
        if (terminal) {
          return terminal
        }
      }
    }

    const inventories = await Promise.allSettled(
      (await this.storedProjects(true))
        .flatMap((project) => project.worktrees)
        .map((worktree) => this.listWorktreeTerminals(worktree))
    )
    const matches = inventories
      .filter(
        (inventory): inventory is PromiseFulfilledResult<TerminalRecord[]> =>
          inventory.status === 'fulfilled'
      )
      .flatMap((inventory) => inventory.value)
      .filter((terminal) => terminal.id === terminalId)

    if (matches.length > 1) {
      throw new DomainError(
        'TERMINAL_ID_CONFLICT',
        'Terminal ID is present in more than one terminal host',
        500
      )
    }

    if (matches[0]) {
      return matches[0]
    }

    const failure = inventories.find(
      (inventory): inventory is PromiseRejectedResult =>
        inventory.status === 'rejected'
    )
    if (failure) {
      throw failure.reason
    }

    throw new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
  }

  async ensureProjectTerminals(projectId: string): Promise<void> {
    const project = await this.getProject(projectId)
    if ((await this.projectOpenState(projectId)) !== true) {
      return
    }

    await Promise.all(
      project.worktrees.map((worktree) =>
        this.ensureWorktreeTerminal(worktree.id)
      )
    )
  }

  async ensureWorktreeTerminal(
    worktreeId: string
  ): Promise<TerminalRecord | null> {
    if (await this.terminalMutations.isBusy(worktreeId)) {
      return null
    }

    return this.terminalMutations.enqueue(worktreeId, async () => {
      const worktree = await this.storedWorktree(worktreeId)
      if (
        !worktree ||
        (await this.projectOpenState(worktree.projectId)) !== true ||
        worktree.prunable ||
        !(await this.locks.tryAcquire({ worktreeIds: [worktreeId] }))
      ) {
        return null
      }

      try {
        const terminals = await this.listWorktreeTerminals(worktree)
        if (terminals.length > 0) {
          return terminals[0]!
        }

        return await this.createTerminalSession(worktree, 'Shell')
      } finally {
        await this.locks.release({ worktreeIds: [worktreeId] })
      }
    })
  }

  private async createTerminalSession(
    worktree: WorktreeRecord,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
  ): Promise<TerminalRecord> {
    const project = await this.requireOpenProject(worktree.projectId)
    const terminalId = id('term')
    const shellCommand = options?.shellCommand ?? null
    const interactiveShell = !argv && shellCommand === null
    const commandArgv = argv
      ? [...argv]
      : shellCommand
        ? [this.deps.config.shell, '-lc', shellCommand]
        : [this.deps.config.shell, '-l']
    const timestamp = now()
    const session: Parameters<TerminalSessionBackend['createTerminal']>[0] = {
      terminalId,
      worktreeId: worktree.id,
      name,
      createdAt: timestamp,
      cwd: options?.cwd ?? worktree.path,
      argv: commandArgv,
      shellCommand,
      interactiveShell,
      env: {
        PI_IMAGE_PROTOCOL: 'kitty',
        ...(options?.env ?? {}),
        TREEPORT_API_URL: this.deps.config.apiUrl,
        TREEPORT_MANAGED_API_URL: this.deps.config.apiUrl,
        TREEPORT_DAEMON_RECORD: path.join(
          this.deps.config.runtimeDir,
          'daemon.json'
        ),
        TREEPORT_DAEMON_LIFECYCLE: this.deps.config.daemonLifecycle,
        TREEPORT_PROJECT_ID: project.id,
        TREEPORT_WORKTREE_ID: worktree.id,
        TREEPORT_TERMINAL_ID: terminalId
      }
    }
    if (options?.initialTitle) {
      session.initialTitle = options.initialTitle
    }

    if (options?.returnToShell && !interactiveShell) {
      session.fallbackArgv = [this.deps.config.shell, '-l']
    }

    if (options?.closeOnSuccess) {
      session.closeOnSuccess = true
    }

    if (options?.initialSize) {
      session.initialSize = options.initialSize
    }

    if (options?.setup?.tasks.length) {
      session.setupTasks = options.setup.tasks
    }

    if (options?.setup?.error) {
      session.setupError = options.setup.error
    }

    try {
      await this.deps.terminalHost.createTerminal(session)
    } catch (error) {
      throw new DomainError(
        'TERMINAL_CREATE_FAILED',
        error instanceof Error ? error.message : String(error),
        500
      )
    }

    const terminal: TerminalRecord = {
      id: terminalId,
      worktreeId: worktree.id,
      name,
      argv: commandArgv,
      shellCommand,
      interactiveShell,
      status: 'running',
      exitCode: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.terminalStates.set(terminalId, terminal)
    if (options?.closeOnSuccess) {
      this.closeOnSuccessTerminalIds.add(terminalId)
    }

    const terminalIds = this.terminalIdsByWorktree.get(worktree.id) ?? new Set()
    terminalIds.add(terminalId)
    this.terminalIdsByWorktree.set(worktree.id, terminalIds)
    this.invalidateProjectsSnapshot()
    this.events.publish('terminal.created', {
      projectId: project.id,
      worktreeId: worktree.id,
      terminalId
    })
    return terminal
  }

  async createTerminal(
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
  ): Promise<TerminalRecord> {
    await this.getWorktree(worktreeId)
    return this.terminalMutations.enqueue(worktreeId, () =>
      this.executeCreateTerminal(worktreeId, name, argv, options)
    )
  }

  async executeCreateTerminal(
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
  ): Promise<TerminalRecord> {
    await this.requireAvailableWorktree(worktreeId)
    try {
      const worktree = await this.storedWorktree(worktreeId)
      if (!worktree) {
        throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
      }

      if (
        worktree.prunable ||
        !(await this.locks.tryAcquire({
          worktreeIds: [worktreeId],
          checkProjectIds: [worktree.projectId]
        }))
      ) {
        throw new DomainError(
          'WORKTREE_BUSY',
          'Cannot create a terminal while the tree is being modified',
          409
        )
      }

      try {
        return await this.createTerminalSession(worktree, name, argv, options)
      } finally {
        await this.locks.release({ worktreeIds: [worktreeId] })
      }
    } catch (error) {
      this.invalidateProjectsSnapshot()
      throw error
    }
  }

  async refreshTerminalStatus(
    terminalId: string,
    observeGit = true
  ): Promise<TerminalRecord> {
    const terminal = observeGit
      ? await this.getTerminal(terminalId)
      : (this.terminalStates.get(terminalId) ??
        (await this.getTerminalFromBindings(terminalId)))
    const worktree = await this.getWorktree(terminal.worktreeId)
    const state = await this.deps.terminalHost.terminalState(terminal.id)
    await this.requireOpenProject(worktree.projectId)
    if (!this.terminalStates.has(terminalId)) {
      throw new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
    }

    if (state.status === 'missing') {
      this.terminalStates.delete(terminalId)
      this.closeOnSuccessTerminalIds.delete(terminalId)
      this.terminalIdsByWorktree.get(worktree.id)?.delete(terminalId)
      this.invalidateProjectsSnapshot()
      this.events.publish('terminal.removed', {
        worktreeId: worktree.id,
        terminalId
      })
      throw new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
    }

    const refreshed = {
      ...terminal,
      status: state.status,
      exitCode: state.exitCode
    }
    this.terminalStates.set(terminalId, refreshed)
    if (
      state.status !== terminal.status ||
      state.exitCode !== terminal.exitCode
    ) {
      this.invalidateProjectsSnapshot()
      this.events.publish('terminal.updated', {
        worktreeId: worktree.id,
        terminalId
      })
    }

    if (
      state.status === 'exited' &&
      state.exitCode === 0 &&
      this.closeOnSuccessTerminalIds.has(terminalId)
    ) {
      try {
        await this.deleteTerminal(terminalId)
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'LAST_TERMINAL') {
          throw error
        }

        return refreshed
      }

      throw new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
    }

    return refreshed
  }

  async renameTerminal(
    terminalId: string,
    name: string
  ): Promise<TerminalRecord> {
    const terminal = await this.getTerminal(terminalId)
    const projectId = (await this.getWorktree(terminal.worktreeId)).projectId
    return this.worktreeMutations.enqueue(projectId, () =>
      this.executeRenameTerminal(terminalId, name)
    )
  }

  private async executeRenameTerminal(
    terminalId: string,
    name: string
  ): Promise<TerminalRecord> {
    const terminal = await this.getTerminal(terminalId)
    const worktree = await this.getWorktree(terminal.worktreeId)
    await this.requireOpenProject(worktree.projectId)
    if (
      !(await this.locks.tryAcquire({
        worktreeIds: [worktree.id],
        checkProjectIds: [worktree.projectId]
      }))
    ) {
      throw new DomainError(
        'WORKTREE_BUSY',
        'Cannot rename a terminal during a destructive project operation',
        409
      )
    }

    try {
      await this.deps.terminalHost.renameTerminal(terminal.id, name, now())
      const renamed = await this.getTerminal(terminalId)
      this.invalidateProjectsSnapshot()
      this.events.publish('terminal.updated', {
        worktreeId: terminal.worktreeId,
        terminalId
      })
      return renamed
    } finally {
      await this.locks.release({ worktreeIds: [worktree.id] })
    }
  }

  async deleteTerminal(terminalId: string): Promise<void> {
    const terminal =
      this.terminalStates.get(terminalId) ??
      (await this.getTerminalFromBindings(terminalId))
    const projectId = (await this.getWorktree(terminal.worktreeId)).projectId
    return this.worktreeMutations.enqueue(projectId, () =>
      this.executeDeleteTerminal(terminalId, terminal.worktreeId)
    )
  }

  private async executeDeleteTerminal(
    terminalId: string,
    worktreeId: string
  ): Promise<void> {
    const worktree = await this.storedWorktree(worktreeId)
    if (!worktree) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
    }

    await this.requireOpenProject(worktree.projectId)
    if (
      !(await this.locks.tryAcquire({
        worktreeIds: [worktree.id],
        checkProjectIds: [worktree.projectId]
      }))
    ) {
      throw new DomainError(
        'WORKTREE_BUSY',
        'Cannot delete a terminal during a destructive project operation',
        409
      )
    }

    try {
      const terminals = await this.listWorktreeTerminals(worktree)
      const terminal = terminals.find(
        (candidate) => candidate.id === terminalId
      )
      if (!terminal) {
        throw new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
      }

      if (
        terminals.length <= 1 ||
        terminals.every(
          (candidate) =>
            candidate.id === terminalId ||
            this.closeOnSuccessTerminalIds.has(candidate.id)
        )
      ) {
        throw new DomainError(
          'LAST_TERMINAL',
          'Every open tree must keep at least one terminal',
          409
        )
      }

      await this.deps.terminalHost.killTerminal(terminal.id)
    } finally {
      await this.locks.release({ worktreeIds: [worktree.id] })
    }
    this.terminalStates.delete(terminalId)
    this.closeOnSuccessTerminalIds.delete(terminalId)
    this.terminalIdsByWorktree.get(worktree.id)?.delete(terminalId)
    this.invalidateProjectsSnapshot()
    this.events.publish('terminal.removed', {
      worktreeId: worktree.id,
      terminalId
    })
  }

  async terminateAllTerminals(): Promise<number> {
    await this.drainMutations()
    let terminated = 0
    for (const project of await this.listProjects()) {
      for (const worktree of project.worktrees) {
        const terminalIds = await this.deps.terminalHost.killWorktree(
          worktree.id
        )
        terminated += terminalIds.length
        this.clearWorktreeTerminalState(worktree.id, terminalIds)
      }
    }
    this.invalidateProjectsSnapshot()
    return terminated
  }
}
