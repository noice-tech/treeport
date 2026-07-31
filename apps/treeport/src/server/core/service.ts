import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  DirectoryBrowseResponse,
  OperationRecord,
  PrInfo,
  ProjectColor,
  ProjectRecord,
  RecentProjectRecord,
  RemovePreview,
  TerminalPreset,
  TerminalRecord,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import { sql } from 'drizzle-orm'
import type { AppConfig } from './config'
import type { CommandRunner } from './command'
import type { TreeportDatabase } from './database'
import { serializeOperation } from './database'
import { assertCleanupTransition, DomainError } from './domain'
import { ProductEventBus } from './events'
import type { GhAdapter } from './gh'
import type { GitAdapter } from './git'
import type { WorktreeSetupTask } from './setup'
import { KeyedTaskQueue } from './task-queue'
import type { TmuxAdapter } from './tmux'
import { generateTmuxSessionName, generateTmuxSocketName } from './tmux'
import {
  normalizeWorktreeName,
  prepareZedWorktreeWrapper,
  resolveCreateWorktreeSetupTasks,
  resolveZedWorktreePath,
  runCreateWorktreeTasks
} from './zed'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

interface RemovalCheckoutIdentity {
  path: string
  device: string
  inode: string
  gitWorktreeKey: string
  gitMarker: string
  managedWrapperPath: string | null
  quarantinePath: string
}

function removalCheckoutIdentity(
  request: Record<string, unknown>
): RemovalCheckoutIdentity | null {
  const value = request.checkoutIdentity
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Record<string, unknown>
  return typeof candidate.path === 'string' &&
    typeof candidate.device === 'string' &&
    typeof candidate.inode === 'string' &&
    typeof candidate.gitWorktreeKey === 'string' &&
    typeof candidate.gitMarker === 'string' &&
    (typeof candidate.managedWrapperPath === 'string' ||
      candidate.managedWrapperPath === null) &&
    typeof candidate.quarantinePath === 'string'
    ? {
        path: candidate.path,
        device: candidate.device,
        inode: candidate.inode,
        gitWorktreeKey: candidate.gitWorktreeKey,
        gitMarker: candidate.gitMarker,
        managedWrapperPath: candidate.managedWrapperPath,
        quarantinePath: candidate.quarantinePath
      }
    : null
}

function gitMarkerTarget(checkoutPath: string, marker: string): string | null {
  const match = /^gitdir: (.+)$/u.exec(marker.trim())
  return match ? path.resolve(checkoutPath, match[1]!) : null
}

function gitMarkerMatchesKey(
  checkoutPath: string,
  marker: string,
  gitWorktreeKey: string
): boolean {
  const target = gitMarkerTarget(checkoutPath, marker)
  if (!target) {
    return false
  }

  if (path.isAbsolute(gitWorktreeKey)) {
    return target === path.resolve(gitWorktreeKey)
  }

  const normalizedKey = path.normalize(gitWorktreeKey)
  return target.endsWith(`${path.sep}${normalizedKey}`)
}

function removeConfirmationToken(
  key: Buffer,
  preview: Omit<RemovePreview, 'confirmationToken'>,
  statusFingerprint: string
): string {
  return crypto
    .createHmac('sha256', key)
    .update(
      JSON.stringify({
        worktreeId: preview.worktreeId,
        path: preview.path,
        head: preview.head,
        branch: preview.branch,
        detached: preview.detached,
        detachedHeadReachable: preview.detachedHeadReachable,
        locked: preview.locked,
        lockReason: preview.lockReason,
        dirty: preview.dirty,
        forceRequired: preview.forceRequired,
        eligible: preview.eligible,
        reasons: preview.reasons,
        warnings: preview.warnings,
        statusFingerprint,
        terminalIds: preview.terminals.map((terminal) => terminal.id).sort()
      })
    )
    .digest('hex')
}

interface ServiceDependencies {
  config: AppConfig
  database: TreeportDatabase
  runner: CommandRunner
  git: GitAdapter
  tmux: TmuxAdapter
  gh: GhAdapter
  events?: ProductEventBus
}

export interface CreateWorktreeResult {
  worktree: WorktreeRecord
  terminal: TerminalRecord | null
  terminalError: string | null
  setupError: string | null
}

export class TreeportService {
  readonly events: ProductEventBus
  private readonly worktreeLocks = new Set<string>()
  private readonly projectLocks = new Set<string>()
  private readonly worktreeMutations = new KeyedTaskQueue<string>()
  private readonly terminalMutations = new KeyedTaskQueue<string>()
  private readonly removeConfirmationKey = crypto.randomBytes(32)
  private readonly terminalStates = new Map<string, TerminalRecord>()
  private readonly closeOnSuccessTerminalIds = new Set<string>()
  private readonly terminalIdsByWorktree = new Map<string, Set<string>>()
  private readonly projectObservationTails = new Map<string, Promise<void>>()
  private projectsSnapshotInFlight: Promise<ProjectRecord[]> | null = null
  private projectsSnapshotRevision = 0

  constructor(private readonly deps: ServiceDependencies) {
    this.events = deps.events ?? new ProductEventBus()
  }

  get database(): TreeportDatabase {
    return this.deps.database
  }

  async initialize(): Promise<void> {
    await this.deps.tmux.initialize()
    const interrupted = await this.deps.database.db.all<{
      id: string
      worktreeId: string | null
    }>(sql`
      SELECT id, worktree_id AS worktreeId
      FROM operations
      WHERE status IN ('pending','running')
    `)
    const timestamp = now()
    await this.deps.database.db.transaction(async (tx) => {
      for (const operation of interrupted) {
        await tx.run(sql`
          UPDATE operations
          SET status = 'failed',
              error = 'Daemon restarted before the operation completed; external state was preserved for retry',
              updated_at = ${timestamp}
          WHERE id = ${operation.id}
        `)
        if (operation.worktreeId) {
          await tx.run(sql`
            UPDATE worktrees
            SET status = 'cleanup_failed',
                cleanup_error = 'Cleanup was interrupted by a daemon restart; inspect and retry',
                updated_at = ${timestamp}
            WHERE id = ${operation.worktreeId} AND status = 'cleaning'
          `)
        }
      }
    })
    await this.reconcile()
  }

  private invalidateProjectsSnapshot(): void {
    this.projectsSnapshotRevision += 1
    this.projectsSnapshotInFlight = null
  }

  private clearWorktreeTerminalState(
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

  private async checkoutStat(checkoutPath: string) {
    return fs.lstat(checkoutPath, { bigint: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }

      throw error
    })
  }

  private async authorizedCheckoutError(
    checkoutPath: string,
    identity: RemovalCheckoutIdentity | null,
    acceptedPath = checkoutPath
  ): Promise<string | null> {
    const checkout = await this.checkoutStat(checkoutPath)
    if (!checkout) {
      return null
    }

    if (!identity || identity.path !== acceptedPath) {
      return 'Manual cleanup required: the checkout remains on disk, but this removal has no matching filesystem identity'
    }

    if (
      !checkout.isDirectory() ||
      checkout.dev.toString() !== identity.device ||
      checkout.ino.toString() !== identity.inode
    ) {
      return 'Manual cleanup required: the checkout path now refers to a different filesystem object'
    }

    const markerPath = path.join(checkoutPath, '.git')
    const markerStat = await this.checkoutStat(markerPath)
    const marker = markerStat?.isFile()
      ? await fs.readFile(markerPath, 'utf8').catch(() => null)
      : null
    return marker !== identity.gitMarker ||
      !gitMarkerMatchesKey(acceptedPath, marker ?? '', identity.gitWorktreeKey)
      ? 'Manual cleanup required: the checkout Git marker no longer proves that Treeport owns this removal'
      : null
  }

  private async removeAuthorizedCheckout(
    checkoutPath: string,
    identity: RemovalCheckoutIdentity | null
  ): Promise<{ removed: boolean; error: string | null }> {
    if (
      !identity ||
      identity.path !== checkoutPath ||
      path.dirname(identity.quarantinePath) !== path.dirname(checkoutPath) ||
      identity.quarantinePath === checkoutPath
    ) {
      return {
        removed: false,
        error:
          'Manual cleanup required: the persisted checkout quarantine is invalid'
      }
    }

    const quarantinePath = identity.quarantinePath
    if (await this.checkoutStat(quarantinePath)) {
      const quarantineError = await this.authorizedCheckoutError(
        quarantinePath,
        identity,
        checkoutPath
      )
      if (quarantineError) {
        return {
          removed: false,
          error: `${quarantineError}; the unverified directory was preserved at ${quarantinePath}`
        }
      }
    } else {
      const authorizationError = await this.authorizedCheckoutError(
        checkoutPath,
        identity
      )
      if (authorizationError) {
        return { removed: false, error: authorizationError }
      }

      if (!(await this.checkoutStat(checkoutPath))) {
        return { removed: false, error: null }
      }

      const renameError = await fs.rename(checkoutPath, quarantinePath).then(
        () => null,
        (error: unknown) => error
      )
      if (renameError) {
        if (
          (renameError as NodeJS.ErrnoException).code === 'ENOENT' &&
          !(await this.checkoutStat(checkoutPath)) &&
          !(await this.checkoutStat(quarantinePath))
        ) {
          return { removed: false, error: null }
        }

        throw renameError
      }

      const quarantineError = await this.authorizedCheckoutError(
        quarantinePath,
        identity,
        checkoutPath
      )
      if (quarantineError) {
        if (!(await this.checkoutStat(checkoutPath))) {
          const restoreError = await fs
            .rename(quarantinePath, checkoutPath)
            .then(
              () => null,
              (error: unknown) => error
            )
          if (!restoreError) {
            return { removed: false, error: quarantineError }
          }
        }

        return {
          removed: false,
          error: `${quarantineError}; the unverified directory was preserved at ${quarantinePath}`
        }
      }
    }

    const removalError = await fs
      .rm(quarantinePath, { recursive: true, force: true })
      .then(
        () => null,
        (error: unknown) => error
      )
    if (removalError || (await this.checkoutStat(quarantinePath))) {
      if (!(await this.checkoutStat(checkoutPath))) {
        const restoreError = await fs.rename(quarantinePath, checkoutPath).then(
          () => null,
          (error: unknown) => error
        )
        if (!restoreError) {
          return {
            removed: false,
            error: `Manual cleanup required: automatic checkout cleanup failed: ${
              removalError instanceof Error
                ? removalError.message
                : 'the quarantined checkout root still exists'
            }`
          }
        }
      }

      return {
        removed: false,
        error: `Manual cleanup required: automatic checkout cleanup failed; the checkout was preserved at ${quarantinePath}`
      }
    }

    if (await this.checkoutStat(checkoutPath)) {
      return {
        removed: false,
        error:
          'Manual cleanup required: the checkout path was recreated during automatic cleanup'
      }
    }

    return { removed: true, error: null }
  }

  listProjects(): Promise<ProjectRecord[]> {
    if (this.projectsSnapshotInFlight) {
      return this.projectsSnapshotInFlight
    }

    const snapshot = this.collectCurrentProjectsSnapshot()
    this.projectsSnapshotInFlight = snapshot
    const clear = () => {
      if (this.projectsSnapshotInFlight === snapshot) {
        this.projectsSnapshotInFlight = null
      }
    }
    void snapshot.then(clear, clear)
    return snapshot
  }

  listRecentProjects(): Promise<RecentProjectRecord[]> {
    return this.deps.database.recentProjects()
  }

  private async collectCurrentProjectsSnapshot(): Promise<ProjectRecord[]> {
    while (true) {
      const revision = this.projectsSnapshotRevision
      const projects = await this.collectProjectsSnapshot()
      if (revision === this.projectsSnapshotRevision) {
        return projects
      }
    }
  }

  private async collectProjectsSnapshot(): Promise<ProjectRecord[]> {
    const projects = await Promise.all(
      (await this.deps.database.openProjects()).map(async (storedProject) => {
        let project = storedProject
        try {
          await this.importWorktrees(
            project.id,
            project.repositoryPath,
            project.mainWorktreePath
          )
          await this.ensureProjectTerminals(project.id)
          project = (await this.deps.database.project(project.id)) ?? project
        } catch (error) {
          project.availability = {
            state: 'unavailable',
            message: error instanceof Error ? error.message : String(error)
          }
        }

        if ((await this.deps.database.isProjectOpen(project.id)) !== true) {
          return null
        }

        await Promise.all(
          project.worktrees.map(async (worktree) => {
            const [dirty, terminals] = await Promise.all([
              project.availability.state === 'available' && !worktree.prunable
                ? this.deps.git.dirtyState(worktree.path).catch(() => null)
                : null,
              this.listWorktreeTerminals(worktree).catch((error: unknown) => {
                project.availability = {
                  state: 'unavailable',
                  message:
                    error instanceof Error ? error.message : String(error)
                }
                return []
              })
            ])
            worktree.dirty = dirty
            worktree.terminals = terminals
          })
        )
        return project
      })
    )
    return projects.filter(
      (project): project is ProjectRecord => project !== null
    )
  }

  private async listWorktreeTerminals(
    worktree: WorktreeRecord
  ): Promise<TerminalRecord[]> {
    let sessions = (
      await this.deps.tmux.listSessions(worktree.tmuxSocketName)
    ).filter((terminal) => terminal.worktreeId === worktree.id)
    if (!this.worktreeLocks.has(worktree.id)) {
      for (const terminal of sessions) {
        if (
          sessions.length <= 1 ||
          !terminal.closeOnSuccess ||
          terminal.status !== 'exited' ||
          terminal.exitCode !== 0
        ) {
          continue
        }

        await this.deps.tmux.killSession(
          worktree.tmuxSocketName,
          terminal.sessionName,
          terminal.id,
          { preserveServer: true }
        )
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
          tmuxSessionName: terminal.sessionName,
          argv: terminal.argv,
          status: terminal.status,
          exitCode: terminal.exitCode,
          createdAt: terminal.createdAt,
          updatedAt: terminal.updatedAt
        }
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    if (this.worktreeLocks.has(worktree.id)) {
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

  async getProjectSnapshot(projectId: string): Promise<ProjectRecord> {
    await this.requireOpenProject(projectId)
    const project = (await this.listProjects()).find(
      (candidate) => candidate.id === projectId
    )
    if (!project) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
    }

    return project
  }

  async getWorktreeSnapshot(worktreeId: string): Promise<WorktreeRecord> {
    const binding = await this.getWorktree(worktreeId)
    await this.requireOpenProject(binding.projectId)
    const worktree = (await this.listProjects())
      .flatMap((project) => project.worktrees)
      .find((candidate) => candidate.id === worktreeId)
    if (!worktree) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Worktree not found', 404)
    }

    return worktree
  }

  private async requireAvailableWorktree(
    worktreeId: string
  ): Promise<WorktreeRecord> {
    const binding = await this.deps.database.worktree(worktreeId)
    if (!binding) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Worktree not found', 404)
    }

    const project = await this.observeAvailableProject(
      await this.requireOpenProject(binding.projectId)
    )

    const worktree = project.worktrees.find(
      (candidate) => candidate.id === worktreeId
    )
    if (!worktree) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Worktree not found', 404)
    }

    if (worktree.prunable) {
      throw new DomainError(
        'WORKTREE_UNAVAILABLE',
        'Git reports this worktree as prunable',
        409
      )
    }

    return worktree
  }

  async getProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.deps.database.project(projectId)
    if (!project) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
    }

    return project
  }

  private async requireOpenProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.getProject(projectId)
    if ((await this.deps.database.isProjectOpen(projectId)) !== true) {
      throw new DomainError(
        'PROJECT_CLOSED',
        'Project is closed; open it before modifying it',
        409
      )
    }

    return project
  }

  async updateProjectColor(
    projectId: string,
    color: ProjectColor | null
  ): Promise<ProjectRecord> {
    await this.requireOpenProject(projectId)
    if (
      this.projectLocks.has(projectId) ||
      this.worktreeMutations.has(projectId)
    ) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    await this.deps.database.db.run(sql`
      UPDATE projects SET color = ${color}, updated_at = ${now()}
      WHERE id = ${projectId}
    `)
    this.invalidateProjectsSnapshot()
    this.events.publish('project.updated', { projectId })
    return await this.getProject(projectId)
  }

  listTerminalPresets(): Promise<TerminalPreset[]> {
    return this.deps.database.terminalPresets()
  }

  async createTerminalPreset(
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'> &
      Partial<Pick<TerminalPreset, 'closeOnSuccess'>>
  ): Promise<TerminalPreset> {
    const timestamp = now()
    const preset: TerminalPreset = {
      id: id('preset'),
      name: input.name,
      executable: input.executable,
      args: [...input.args],
      closeOnSuccess: input.closeOnSuccess ?? false,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await this.deps.database.insertTerminalPreset(preset)
    return preset
  }

  async updateTerminalPreset(
    presetId: string,
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'> & {
      closeOnSuccess?: boolean | undefined
    },
    expectedUpdatedAt: string
  ): Promise<TerminalPreset> {
    const existing = await this.deps.database.terminalPreset(presetId)
    if (!existing) {
      throw new DomainError(
        'TERMINAL_PRESET_NOT_FOUND',
        'Terminal preset not found',
        404
      )
    }

    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new DomainError(
        'TERMINAL_PRESET_CHANGED',
        'Terminal preset changed; review the latest values and try again',
        409
      )
    }

    const timestamp = now()
    const preset: TerminalPreset = {
      ...existing,
      name: input.name,
      executable: input.executable,
      args: [...input.args],
      closeOnSuccess: input.closeOnSuccess ?? existing.closeOnSuccess,
      updatedAt:
        timestamp > existing.updatedAt
          ? timestamp
          : new Date(Date.parse(existing.updatedAt) + 1).toISOString()
    }
    if (
      !(await this.deps.database.updateTerminalPreset(
        preset,
        expectedUpdatedAt
      ))
    ) {
      throw new DomainError(
        'TERMINAL_PRESET_CHANGED',
        'Terminal preset changed; review the latest values and try again',
        409
      )
    }

    return preset
  }

  async deleteTerminalPreset(
    presetId: string,
    expectedUpdatedAt: string
  ): Promise<void> {
    const existing = await this.deps.database.terminalPreset(presetId)
    if (!existing) {
      throw new DomainError(
        'TERMINAL_PRESET_NOT_FOUND',
        'Terminal preset not found',
        404
      )
    }

    if (
      existing.updatedAt !== expectedUpdatedAt ||
      !(await this.deps.database.deleteTerminalPreset(
        presetId,
        expectedUpdatedAt
      ))
    ) {
      throw new DomainError(
        'TERMINAL_PRESET_CHANGED',
        'Terminal preset changed; review the latest values and try again',
        409
      )
    }
  }

  async getWorktree(worktreeId: string): Promise<WorktreeRecord> {
    const worktree = await this.deps.database.worktree(worktreeId)
    if (!worktree || worktree.status === 'removed') {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Worktree not found', 404)
    }

    return worktree
  }

  async getTerminal(terminalId: string): Promise<TerminalRecord> {
    const matches = (await this.listProjects())
      .flatMap((project) => project.worktrees)
      .flatMap((worktree) => worktree.terminals)
      .filter((terminal) => terminal.id === terminalId)

    if (matches.length > 1) {
      throw new DomainError(
        'TERMINAL_ID_CONFLICT',
        'Terminal ID is present in more than one tmux server',
        500
      )
    }

    if (matches[0]) {
      return matches[0]
    }

    throw new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
  }

  private async getTerminalFromBindings(
    terminalId: string
  ): Promise<TerminalRecord> {
    const known = this.terminalStates.get(terminalId)
    if (known) {
      const worktree = await this.deps.database.worktree(known.worktreeId)
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
      (await this.deps.database.openProjects())
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
        'Terminal ID is present in more than one tmux server',
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

  async getOperation(operationId: string): Promise<OperationRecord> {
    const operation = await this.deps.database.operation(operationId)
    if (!operation) {
      throw new DomainError('OPERATION_NOT_FOUND', 'Operation not found', 404)
    }

    return operation
  }

  async resolveProject(identifier: string): Promise<ProjectRecord> {
    const direct = await this.deps.database.project(identifier)
    if (direct) {
      return await this.requireOpenProject(direct.id)
    }

    const canonical = await fs
      .realpath(path.resolve(identifier))
      .catch(() => path.resolve(identifier))
    const projects = await this.deps.database.projects()
    const match = projects.find(
      (project) =>
        isPathWithin(canonical, project.repositoryPath) ||
        project.worktrees.some((worktree) =>
          isPathWithin(canonical, worktree.path)
        )
    )
    if (!match) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        `No registered project contains ${identifier}`,
        404
      )
    }

    await this.requireOpenProject(match.id)
    return match
  }

  async resolveWorktree(identifier: string): Promise<WorktreeRecord> {
    const direct = await this.deps.database.worktree(identifier)
    if (direct && direct.status !== 'removed') {
      await this.requireOpenProject(direct.projectId)
      return direct
    }

    const canonical = await fs
      .realpath(path.resolve(identifier))
      .catch(() => path.resolve(identifier))
    const matches = (await this.deps.database.projects())
      .flatMap((project) => project.worktrees)
      .filter((worktree) => isPathWithin(canonical, worktree.path))
      .sort((a, b) => b.path.length - a.path.length)
    const match = matches[0]
    if (!match) {
      throw new DomainError(
        'WORKTREE_NOT_FOUND',
        `No registered worktree contains ${identifier}`,
        404
      )
    }

    await this.requireOpenProject(match.projectId)
    return match
  }

  async browseDirectory(
    inputPath: string,
    showHidden = false
  ): Promise<DirectoryBrowseResponse> {
    const homePath = os.homedir()
    const expandedPath =
      inputPath === '~'
        ? homePath
        : /^~[\\/]/u.test(inputPath)
          ? path.join(homePath, inputPath.slice(2))
          : inputPath
    if (!path.isAbsolute(expandedPath)) {
      throw new DomainError(
        'DIRECTORY_PATH_NOT_ABSOLUTE',
        'Enter an absolute path on the Treeport server',
        400
      )
    }

    const requestedPath = path.resolve(expandedPath)
    let exact = true
    let entryQuery = ''
    const directoryPath = await fs
      .realpath(requestedPath)
      .catch(async (error) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          throw new DomainError(
            'DIRECTORY_UNREADABLE',
            'That folder cannot be read on the Treeport server',
            403
          )
        }

        exact = false
        entryQuery ||= path.basename(requestedPath)
        return fs.realpath(path.dirname(requestedPath)).catch((parentError) => {
          const parentCode = (parentError as NodeJS.ErrnoException).code
          throw new DomainError(
            parentCode === 'ENOENT'
              ? 'DIRECTORY_NOT_FOUND'
              : 'DIRECTORY_UNREADABLE',
            parentCode === 'ENOENT'
              ? 'That folder does not exist on the Treeport server'
              : 'That folder cannot be read on the Treeport server',
            parentCode === 'ENOENT' ? 404 : 403
          )
        })
      })
    const directoryStat = await fs.stat(directoryPath).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code
      throw new DomainError(
        code === 'ENOENT' ? 'DIRECTORY_NOT_FOUND' : 'DIRECTORY_UNREADABLE',
        code === 'ENOENT'
          ? 'That folder does not exist on the Treeport server'
          : 'That folder cannot be read on the Treeport server',
        code === 'ENOENT' ? 404 : 403
      )
    })
    if (!directoryStat.isDirectory()) {
      throw new DomainError(
        'DIRECTORY_NOT_A_DIRECTORY',
        'That path is not a folder',
        400
      )
    }

    const rawEntries = await fs
      .readdir(directoryPath, {
        withFileTypes: true
      })
      .catch(() => {
        throw new DomainError(
          'DIRECTORY_UNREADABLE',
          'That folder cannot be read on the Treeport server',
          403
        )
      })
    const normalizedQuery = entryQuery.toLocaleLowerCase()
    const candidates = rawEntries
      .filter(
        (entry) =>
          (showHidden ||
            normalizedQuery.startsWith('.') ||
            !entry.name.startsWith('.')) &&
          (!normalizedQuery ||
            entry.name.toLocaleLowerCase().startsWith(normalizedQuery))
      )
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, {
          sensitivity: 'base',
          numeric: true
        })
      )

    const entries: DirectoryBrowseResponse['directory']['entries'] = []
    let truncated = false
    for (const entry of candidates) {
      const entryPath = path.join(directoryPath, entry.name)
      const isDirectory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (await fs
            .stat(entryPath)
            .then((stat) => stat.isDirectory())
            .catch(() => false)))
      if (!isDirectory) {
        continue
      }

      if (entries.length === 200) {
        truncated = true
        break
      }

      entries.push({ name: entry.name, path: entryPath })
    }

    const rootPath = path.parse(directoryPath).root
    const breadcrumbs: DirectoryBrowseResponse['directory']['breadcrumbs'] = [
      { name: rootPath, path: rootPath }
    ]
    let breadcrumbPath = rootPath
    for (const segment of directoryPath
      .slice(rootPath.length)
      .split(path.sep)) {
      if (!segment) {
        continue
      }

      breadcrumbPath = path.join(breadcrumbPath, segment)
      breadcrumbs.push({ name: segment, path: breadcrumbPath })
    }

    const repositoryPath = exact
      ? await this.deps.git
          .canonicalizeRepositoryPath(directoryPath)
          .then((checkout) => this.deps.git.resolveMainCheckout(checkout))
          .then((mainCheckout) => fs.realpath(mainCheckout))
          .catch(() => null)
      : null

    return {
      input: inputPath,
      exact,
      directory: {
        path: directoryPath,
        parentPath:
          directoryPath === rootPath ? null : path.dirname(directoryPath),
        homePath,
        rootPath,
        breadcrumbs,
        entries,
        truncated
      },
      repository: repositoryPath
        ? { state: 'valid', repositoryPath }
        : exact
          ? {
              state: 'not-repository',
              message: 'This folder is not inside a Git repository.'
            }
          : {
              state: 'incomplete',
              message: 'Choose a matching folder to continue.'
            }
    }
  }

  async registerProject(
    inputPath: string,
    requestedName?: string
  ): Promise<ProjectRecord> {
    const checkout = await this.deps.git
      .canonicalizeRepositoryPath(inputPath)
      .catch((error: unknown) => {
        throw new DomainError(
          'NOT_A_GIT_REPOSITORY',
          error instanceof Error ? error.message : 'Not a Git repository',
          400
        )
      })
    const mainPath = await this.deps.git.resolveMainCheckout(checkout)
    const repositoryPath = await fs.realpath(mainPath)
    const repositoryStat = await fs.stat(repositoryPath, { bigint: true })
    const repositoryDevice = repositoryStat.dev.toString()
    const repositoryInode = repositoryStat.ino.toString()
    const pathMatch = await this.deps.database.projectByPath(repositoryPath)
    const identityMatch = await this.deps.database.projectByFilesystemIdentity(
      repositoryDevice,
      repositoryInode
    )
    const pathMetadata = pathMatch
      ? await this.deps.database.projectFilesystemMetadata(pathMatch.id)
      : null
    if (pathMatch && !pathMetadata) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The registered project is missing its filesystem identity',
        409
      )
    }

    if (
      pathMatch &&
      pathMetadata &&
      (pathMetadata.device !== repositoryDevice ||
        pathMetadata.inode !== repositoryInode)
    ) {
      if (!identityMatch) {
        throw new DomainError(
          'PROJECT_PATH_CONFLICT',
          'This path belongs to a registered project, but now contains a different repository',
          409
        )
      }

      if (identityMatch.id !== pathMatch.id) {
        throw new DomainError(
          'PROJECT_PATH_CONFLICT',
          'The repository identity and registered path belong to different projects',
          409
        )
      }
    }

    if (pathMatch && identityMatch && pathMatch.id !== identityMatch.id) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The repository identity and registered path belong to different projects',
        409
      )
    }

    const existing = identityMatch ?? pathMatch
    const projectId = existing?.id ?? id('proj')

    const updateRegistration = async (): Promise<void> => {
      if (existing && existing.repositoryPath !== repositoryPath) {
        await this.deps.git.repairWorktrees(repositoryPath)
        const discovered = await this.deps.git.listWorktrees(repositoryPath)
        if (
          !discovered.some(
            (worktree) =>
              !worktree.bare &&
              !worktree.prunable &&
              worktree.path === repositoryPath &&
              worktree.gitWorktreeKey === 'main'
          )
        ) {
          throw new DomainError(
            'NOT_A_GIT_REPOSITORY',
            'Git worktree inventory did not report the recovered main checkout',
            400
          )
        }
      }

      const timestamp = now()
      const defaultBranch = await this.deps.git.defaultBranch(repositoryPath)
      const requested = requestedName?.trim() || null
      const existingMetadata = existing
        ? await this.deps.database.projectFilesystemMetadata(existing.id)
        : null
      if (existing && !existingMetadata) {
        throw new DomainError(
          'PROJECT_PATH_CONFLICT',
          'The registered project is missing its filesystem identity',
          409
        )
      }

      const nameIsCustom = requested
        ? true
        : (existingMetadata?.nameIsCustom ?? false)
      const automaticExistingName = Boolean(
        existing &&
        !nameIsCustom &&
        existing.name === path.basename(existing.repositoryPath)
      )
      const name =
        requested ||
        (automaticExistingName
          ? path.basename(repositoryPath)
          : existing?.name) ||
        path.basename(repositoryPath)
      await this.deps.database.db.run(sql`
        INSERT INTO projects(
          id,name,repository_path,main_worktree_path,default_branch,
          repository_device,repository_inode,name_is_custom,is_open,last_opened_at,
          created_at,updated_at
        ) VALUES(
          ${projectId},${name},${repositoryPath},${mainPath},${defaultBranch},
          ${repositoryDevice},${repositoryInode},${nameIsCustom ? 1 : 0},1,
          ${timestamp},${existing?.createdAt ?? timestamp},${timestamp}
        )
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,
          repository_path=excluded.repository_path,
          main_worktree_path=excluded.main_worktree_path,
          default_branch=excluded.default_branch,
          repository_device=excluded.repository_device,
          repository_inode=excluded.repository_inode,
          name_is_custom=excluded.name_is_custom,
          updated_at=excluded.updated_at
      `)
      await this.reconcileProjectWorktrees(
        projectId,
        repositoryPath,
        mainPath,
        Boolean(existing),
        true
      )
    }

    if (existing) {
      await this.serializeProjectObservation(projectId, async () => {
        if (
          this.projectLocks.has(projectId) ||
          this.worktreeMutations.has(projectId)
        ) {
          throw new DomainError(
            'PROJECT_BUSY',
            'Project is already being modified',
            409
          )
        }

        this.projectLocks.add(projectId)
        try {
          await updateRegistration()
          await this.deps.database.setProjectOpen(projectId, true, now())
          await this.ensureProjectTerminals(projectId).catch(() => undefined)
          this.invalidateProjectsSnapshot()
          this.events.publish('project.updated', { projectId })
        } finally {
          this.projectLocks.delete(projectId)
        }
      })
      return this.getProjectSnapshot(projectId)
    }

    await updateRegistration()
    await this.ensureProjectTerminals(projectId).catch(() => undefined)
    this.invalidateProjectsSnapshot()
    this.events.publish('project.created', { projectId })
    return this.getProjectSnapshot(projectId)
  }

  private async observeAvailableProject(
    project: ProjectRecord,
    allowClosed = false
  ): Promise<ProjectRecord> {
    try {
      await this.importWorktrees(
        project.id,
        project.repositoryPath,
        project.mainWorktreePath,
        true,
        allowClosed
      )
    } catch (error) {
      throw new DomainError(
        'PROJECT_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
        503
      )
    }

    return await this.getProject(project.id)
  }

  async refreshProject(projectId: string): Promise<ProjectRecord> {
    await this.requireOpenProject(projectId)
    if (
      this.projectLocks.has(projectId) ||
      this.worktreeMutations.has(projectId)
    ) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    this.projectLocks.add(projectId)
    try {
      const project = await this.observeAvailableProject(
        await this.getProject(projectId)
      )
      await this.ensureProjectTerminals(projectId)
      const defaultBranch = await this.deps.git.defaultBranch(
        project.repositoryPath
      )
      await this.deps.database.db.run(sql`
        UPDATE projects
        SET default_branch = ${defaultBranch}, updated_at = ${now()}
        WHERE id = ${projectId}
      `)
      await this.reconcile()
      this.invalidateProjectsSnapshot()
      this.events.publish('project.updated', { projectId })
      return await this.getProject(projectId)
    } finally {
      this.projectLocks.delete(projectId)
    }
  }

  async openProject(projectId: string): Promise<ProjectRecord> {
    await this.serializeProjectObservation(projectId, async () => {
      await this.getProject(projectId)
      if (
        this.projectLocks.has(projectId) ||
        this.worktreeMutations.has(projectId)
      ) {
        throw new DomainError(
          'PROJECT_BUSY',
          'Project is already being modified',
          409
        )
      }

      this.projectLocks.add(projectId)
      try {
        await this.deps.database.setProjectOpen(projectId, true, now())
        this.invalidateProjectsSnapshot()
        this.events.publish('project.updated', { projectId })
      } finally {
        this.projectLocks.delete(projectId)
      }
    })

    return this.getProjectSnapshot(projectId)
  }

  async closeProject(projectId: string): Promise<void> {
    await this.serializeProjectObservation(projectId, async () => {
      const project = await this.getProject(projectId)
      if ((await this.deps.database.isProjectOpen(projectId)) !== true) {
        return
      }

      if (
        this.projectLocks.has(projectId) ||
        this.worktreeMutations.has(projectId)
      ) {
        throw new DomainError(
          'PROJECT_BUSY',
          'Project is already being modified',
          409
        )
      }

      if (
        project.worktrees.some((worktree) =>
          this.worktreeLocks.has(worktree.id)
        )
      ) {
        throw new DomainError(
          'PROJECT_BUSY',
          'A project worktree is already being modified',
          409
        )
      }

      this.projectLocks.add(projectId)
      const lockedWorktreeIds = project.worktrees.map((worktree) => worktree.id)
      for (const worktreeId of lockedWorktreeIds) {
        this.worktreeLocks.add(worktreeId)
      }

      try {
        const failedWorktrees: Array<{ id: string; message: string }> = []
        for (const worktree of project.worktrees) {
          try {
            const terminalIds = await this.deps.tmux.killServer(
              worktree.tmuxSocketName
            )
            this.clearWorktreeTerminalState(worktree.id, terminalIds)
          } catch (error) {
            failedWorktrees.push({
              id: worktree.id,
              message: error instanceof Error ? error.message : String(error)
            })
          }
        }

        this.invalidateProjectsSnapshot()
        if (failedWorktrees.length > 0) {
          throw new DomainError(
            'PROJECT_CLOSE_FAILED',
            'Some terminal sessions could not be stopped; the project remains open',
            500,
            {
              failedWorktreeIds: failedWorktrees.map((worktree) => worktree.id),
              failures: failedWorktrees,
              terminalsMayHaveStopped: true
            }
          )
        }

        try {
          await this.deps.database.setProjectOpen(projectId, false, now())
        } catch (error) {
          throw new DomainError(
            'PROJECT_CLOSE_FAILED',
            'Terminal sessions stopped, but the project could not be marked closed',
            500,
            {
              failedWorktreeIds: [],
              persistenceError:
                error instanceof Error ? error.message : String(error),
              terminalsMayHaveStopped: true
            }
          )
        }

        this.invalidateProjectsSnapshot()
        this.events.publish('project.updated', { projectId })
      } finally {
        for (const worktreeId of lockedWorktreeIds) {
          this.worktreeLocks.delete(worktreeId)
        }
        this.projectLocks.delete(projectId)
      }
    })
  }

  private async serializeProjectObservation<T>(
    projectId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.projectObservationTails.get(projectId)
    const observation = (previous ?? Promise.resolve()).then(operation)
    const tail = observation.then(
      () => undefined,
      () => undefined
    )
    this.projectObservationTails.set(projectId, tail)
    try {
      return await observation
    } finally {
      if (this.projectObservationTails.get(projectId) === tail) {
        this.projectObservationTails.delete(projectId)
      }
    }
  }

  private importWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock = false,
    allowClosed = false
  ): Promise<void> {
    return this.serializeProjectObservation(projectId, () =>
      this.reconcileProjectWorktrees(
        projectId,
        repositoryPath,
        mainPath,
        allowProjectLock,
        allowClosed
      )
    )
  }

  private async reconcileProjectWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock: boolean,
    allowClosed = false
  ): Promise<void> {
    if (
      (!allowProjectLock &&
        (this.projectLocks.has(projectId) ||
          this.worktreeMutations.has(projectId))) ||
      (!allowClosed &&
        (await this.deps.database.isProjectOpen(projectId)) !== true)
    ) {
      return
    }

    const storedProject = await this.getProject(projectId)
    const storedIdentity =
      await this.deps.database.projectFilesystemMetadata(projectId)
    if (!storedIdentity) {
      throw new Error('Registered project is missing its filesystem identity')
    }

    let canonicalRepository = await fs
      .realpath(repositoryPath)
      .catch(() => null)
    let canonicalStat = canonicalRepository
      ? await fs.stat(canonicalRepository, { bigint: true }).catch(() => null)
      : null
    const currentIdentityMatches = Boolean(
      canonicalStat?.isDirectory() &&
      canonicalStat.dev.toString() === storedIdentity.device &&
      canonicalStat.ino.toString() === storedIdentity.inode
    )
    if (!currentIdentityMatches) {
      const candidates = new Set<string>()
      const parent = path.dirname(repositoryPath)
      const entries = await fs
        .readdir(parent, { withFileTypes: true })
        .catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue
        }

        const candidate = await fs
          .realpath(path.join(parent, entry.name))
          .catch(() => null)
        if (!candidate) {
          continue
        }

        const candidateStat = await fs
          .stat(candidate, { bigint: true })
          .catch(() => null)
        if (
          candidateStat?.isDirectory() &&
          candidateStat.dev.toString() === storedIdentity.device &&
          candidateStat.ino.toString() === storedIdentity.inode
        ) {
          candidates.add(candidate)
        }
      }
      if (candidates.size !== 1) {
        throw new Error(
          candidates.size > 1
            ? 'Repository rename recovery is ambiguous'
            : 'Registered main checkout is unavailable or contains a different repository'
        )
      }

      canonicalRepository = [...candidates][0]!
      canonicalStat = await fs.stat(canonicalRepository, { bigint: true })
      if (
        !canonicalStat.isDirectory() ||
        canonicalStat.dev.toString() !== storedIdentity.device ||
        canonicalStat.ino.toString() !== storedIdentity.inode
      ) {
        throw new Error('Repository rename candidate changed during recovery')
      }
    }

    if (!canonicalRepository || !canonicalStat?.isDirectory()) {
      throw new Error('Registered main checkout is unavailable')
    }

    repositoryPath = canonicalRepository
    mainPath = canonicalRepository
    const repositoryRenamed = repositoryPath !== storedProject.repositoryPath
    if (repositoryRenamed) {
      const canonical =
        await this.deps.git.canonicalizeRepositoryPath(repositoryPath)
      if (canonical !== repositoryPath) {
        throw new Error(
          'Repository rename candidate is not the Git top-level checkout'
        )
      }

      const verifiedStat = await fs.stat(repositoryPath, { bigint: true })
      if (
        verifiedStat.dev.toString() !== storedIdentity.device ||
        verifiedStat.ino.toString() !== storedIdentity.inode
      ) {
        throw new Error('Repository rename candidate changed during recovery')
      }

      await this.deps.git.repairWorktrees(repositoryPath)
    }

    const discovered = (
      await this.deps.git.listWorktrees(repositoryPath)
    ).filter((item) => !item.bare)
    if (
      (!allowProjectLock &&
        (this.projectLocks.has(projectId) ||
          this.worktreeMutations.has(projectId))) ||
      (!allowClosed &&
        (await this.deps.database.isProjectOpen(projectId)) !== true)
    ) {
      return
    }

    const observedMain = discovered.filter(
      (item) =>
        !item.prunable && item.path === mainPath && item.gitWorktreeKey !== null
    )
    if (observedMain.length !== 1) {
      throw new Error(
        'Git worktree inventory is incomplete: the registered main checkout was not reported'
      )
    }

    const repositoryStat = await fs.stat(repositoryPath, { bigint: true })
    const repositoryDevice = repositoryStat.dev.toString()
    const repositoryInode = repositoryStat.ino.toString()
    if (
      storedIdentity.device !== repositoryDevice ||
      storedIdentity.inode !== repositoryInode
    ) {
      throw new Error('Registered main checkout changed during observation')
    }

    const projectIdentityChanged = repositoryRenamed
    const timestamp = now()
    const known = await this.deps.database.db.all<{
      id: string
      path: string
      git_worktree_key: string | null
      kind: 'main' | 'linked'
      tmux_socket_name: string
      status: WorktreeRecord['status']
      cleanup_error: string | null
      managed_wrapper_path: string | null
      created_at: string
      head: string
      branch: string | null
      detached: number
      locked: number
      lock_reason: string | null
      prunable: number
    }>(sql`
      SELECT id,path,git_worktree_key,kind,tmux_socket_name,status,cleanup_error,
             managed_wrapper_path,created_at,head,branch,detached,locked,lock_reason,prunable
      FROM worktrees WHERE project_id=${projectId}
    `)
    const keyed = new Map(
      known.flatMap((worktree) =>
        worktree.git_worktree_key
          ? [[worktree.git_worktree_key, worktree] as const]
          : []
      )
    )
    const matched = discovered.map((item) => ({
      item,
      existing:
        (item.gitWorktreeKey ? keyed.get(item.gitWorktreeKey) : undefined) ??
        (item.gitWorktreeKey === 'main'
          ? known.find((worktree) => worktree.kind === 'main')
          : undefined) ??
        known.find(
          (worktree) =>
            worktree.path === item.path &&
            (!worktree.git_worktree_key || !item.gitWorktreeKey)
        )
    }))
    const matchedIds = new Set(
      matched.flatMap(({ existing }) => (existing ? [existing.id] : []))
    )
    const retired = known
      .filter(
        (worktree) =>
          worktree.kind === 'linked' &&
          !matchedIds.has(worktree.id) &&
          !this.worktreeLocks.has(worktree.id)
      )
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
    const changed = matched.filter(({ item, existing }) => {
      if (!existing) {
        return true
      }

      const kind = item.path === mainPath ? 'main' : 'linked'
      const desiredStatus =
        existing.status === 'cleaning' || existing.status === 'cleanup_failed'
          ? existing.status
          : 'active'
      return (
        existing.path !== item.path ||
        existing.git_worktree_key !==
          (item.gitWorktreeKey ?? existing.git_worktree_key) ||
        existing.head !== (item.head ?? '') ||
        existing.branch !== item.branch ||
        Boolean(existing.detached) !== item.detached ||
        Boolean(existing.locked) !== item.locked ||
        existing.lock_reason !== item.lockReason ||
        Boolean(existing.prunable) !== item.prunable ||
        existing.kind !== kind ||
        existing.status !== desiredStatus
      )
    })
    const changedExistingIds = new Set(
      changed.flatMap(({ existing }) => (existing ? [existing.id] : []))
    )
    for (const worktree of retired) {
      const recoveringRemoval =
        worktree.status === 'cleaning' || worktree.status === 'cleanup_failed'
      const removeOperation = recoveringRemoval
        ? (
            await this.deps.database.db.all<{
              id: string
              status: OperationRecord['status']
              request_json: string
              error: string | null
            }>(sql`
              SELECT id,status,request_json,error FROM operations
              WHERE worktree_id=${worktree.id} AND kind='remove'
              ORDER BY created_at DESC,id DESC LIMIT 1
            `)
          )[0]
        : undefined
      const removeRequest = removeOperation
        ? (JSON.parse(removeOperation.request_json) as Record<string, unknown>)
        : {}
      const removeIdentity = removalCheckoutIdentity(removeRequest)
      if (recoveringRemoval) {
        const preview = removeRequest.preview as
          | Record<string, unknown>
          | undefined
        const identity = removeIdentity
        const checkout = await this.checkoutStat(worktree.path)
        const quarantine = identity
          ? await this.checkoutStat(identity.quarantinePath)
          : null
        let recoveryError: string | null = null
        if (checkout || quarantine) {
          if (!removeOperation) {
            recoveryError =
              'Manual cleanup required: the checkout remains on disk, but its accepted removal operation cannot be verified'
          } else if (
            preview?.worktreeId !== worktree.id ||
            preview.path !== worktree.path
          ) {
            recoveryError =
              'Manual cleanup required: the checkout remains on disk, but this legacy removal has no verifiable accepted preview'
          } else if (!identity || identity.path !== worktree.path) {
            recoveryError =
              'Manual cleanup required: the checkout remains on disk, but this legacy removal has no matching filesystem identity'
          } else if (identity.gitWorktreeKey !== worktree.git_worktree_key) {
            recoveryError =
              'Manual cleanup required: the checkout Git administrative identity changed after removal was accepted'
          } else if (
            identity.managedWrapperPath !== worktree.managed_wrapper_path
          ) {
            recoveryError =
              'Manual cleanup required: the checkout wrapper provenance changed after removal was accepted'
          } else {
            recoveryError = checkout
              ? await this.authorizedCheckoutError(worktree.path, identity)
              : await this.authorizedCheckoutError(
                  identity.quarantinePath,
                  identity,
                  worktree.path
                )
          }
        }

        if (recoveryError) {
          const message = recoveryError.slice(0, 4_096)
          if (
            worktree.status !== 'cleanup_failed' ||
            worktree.cleanup_error !== message ||
            (removeOperation &&
              (removeOperation.status !== 'failed' ||
                removeOperation.error !== message))
          ) {
            const failedAt = now()
            await this.deps.database.db.transaction(async (tx) => {
              await tx.run(sql`
                UPDATE worktrees
                SET status='cleanup_failed',cleanup_error=${message},updated_at=${failedAt}
                WHERE id=${worktree.id}
              `)
              if (removeOperation) {
                await tx.run(sql`
                  UPDATE operations
                  SET status='failed',result_json=NULL,error=${message},updated_at=${failedAt}
                  WHERE id=${removeOperation.id}
                `)
              }
            })
            this.invalidateProjectsSnapshot()
            this.events.publish('worktree.updated', {
              worktreeId: worktree.id
            })
            if (removeOperation) {
              this.events.publish('remove.failed', {
                operationId: removeOperation.id,
                worktreeId: worktree.id,
                error: message
              })
            }
          }

          continue
        }
      }

      const terminalIds = new Set(
        this.terminalIdsByWorktree.get(worktree.id) ?? []
      )
      const sessions = await this.deps.tmux.listSessions(
        worktree.tmux_socket_name
      )
      for (const terminal of sessions) {
        if (terminal.worktreeId === worktree.id) {
          terminalIds.add(terminal.id)
        }
      }
      await this.deps.tmux.killServer(worktree.tmux_socket_name)

      if (recoveringRemoval && removeIdentity) {
        const cleanup = await this.removeAuthorizedCheckout(
          worktree.path,
          removeIdentity
        ).catch((error: unknown) => ({
          removed: false,
          error: `Manual cleanup required: automatic checkout cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        }))
        if (cleanup.error) {
          const message = cleanup.error.slice(0, 4_096)
          if (
            worktree.status !== 'cleanup_failed' ||
            worktree.cleanup_error !== message ||
            (removeOperation &&
              (removeOperation.status !== 'failed' ||
                removeOperation.error !== message))
          ) {
            const failedAt = now()
            await this.deps.database.db.transaction(async (tx) => {
              await tx.run(sql`
                UPDATE worktrees
                SET status='cleanup_failed',cleanup_error=${message},updated_at=${failedAt}
                WHERE id=${worktree.id}
              `)
              if (removeOperation) {
                await tx.run(sql`
                  UPDATE operations
                  SET status='failed',result_json=NULL,error=${message},updated_at=${failedAt}
                  WHERE id=${removeOperation.id}
                `)
              }
            })
            this.invalidateProjectsSnapshot()
            this.events.publish('worktree.updated', {
              worktreeId: worktree.id
            })
            if (removeOperation) {
              this.events.publish('remove.failed', {
                operationId: removeOperation.id,
                worktreeId: worktree.id,
                error: message
              })
            }
          }

          continue
        }
      }

      const retiredAt = now()
      await this.deps.database.db.transaction(async (tx) => {
        if (recoveringRemoval && removeOperation) {
          await tx.run(sql`
            UPDATE operations
            SET status='completed',
                result_json=${serializeOperation({
                  removed: true,
                  recovered: true,
                  path: worktree.path,
                  message:
                    'Git no longer reports the worktree and the checkout root is absent; removal was recovered during reconciliation'
                })},
                error=NULL,
                updated_at=${retiredAt}
            WHERE id=${removeOperation.id}
          `)
        } else if (!recoveringRemoval && worktree.status !== 'removed') {
          await tx.run(sql`
            INSERT INTO operations(
              id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at
            ) VALUES(
              ${id('op')},'external_remove',${projectId},${worktree.id},'completed',
              ${serializeOperation({ source: 'git' })},
              ${serializeOperation({
                removed: true,
                external: true,
                worktreeId: worktree.id,
                path: worktree.path,
                head: worktree.head,
                branch: worktree.branch
              })},NULL,${retiredAt},${retiredAt}
            )
          `)
        }

        await tx.run(sql`DELETE FROM worktrees WHERE id=${worktree.id}`)
      })
      this.terminalIdsByWorktree.set(worktree.id, terminalIds)
      this.clearWorktreeTerminalState(worktree.id)
      this.invalidateProjectsSnapshot()

      if (worktree.managed_wrapper_path) {
        await fs.rmdir(worktree.managed_wrapper_path).catch(() => undefined)
      }

      this.events.publish('worktree.removed', {
        projectId,
        worktreeId: worktree.id
      })
      if (recoveringRemoval && removeOperation) {
        this.events.publish('remove.completed', {
          operationId: removeOperation.id,
          worktreeId: worktree.id
        })
      }
    }

    await this.deps.database.db.transaction(async (tx) => {
      if (projectIdentityChanged) {
        const projectName =
          repositoryRenamed &&
          !storedIdentity.nameIsCustom &&
          storedProject.name === path.basename(storedProject.repositoryPath)
            ? path.basename(repositoryPath)
            : storedProject.name
        await tx.run(sql`
          UPDATE projects
          SET name=${projectName},repository_path=${repositoryPath},
              main_worktree_path=${mainPath},repository_device=${repositoryDevice},
              repository_inode=${repositoryInode},updated_at=${timestamp}
          WHERE id=${projectId}
        `)
      }

      for (const { item, existing } of matched) {
        const kind = item.path === mainPath ? 'main' : 'linked'
        if (existing) {
          if (!changedExistingIds.has(existing.id)) {
            continue
          }

          await tx.run(sql`
            UPDATE worktrees
            SET path=${item.path},
                git_worktree_key=${item.gitWorktreeKey ?? existing.git_worktree_key},
                head=${item.head ?? ''},branch=${item.branch},
                detached=${item.detached ? 1 : 0},locked=${item.locked ? 1 : 0},
                lock_reason=${item.lockReason},prunable=${item.prunable ? 1 : 0},
                kind=${kind},
                status=CASE WHEN status IN ('cleaning','cleanup_failed') THEN status ELSE 'active' END,
                cleanup_error=CASE WHEN status='cleanup_failed' THEN cleanup_error ELSE NULL END,
                updated_at=${timestamp}
            WHERE id=${existing.id}
          `)
          continue
        }

        await tx.run(sql`
          INSERT INTO worktrees(
            id,project_id,path,git_worktree_key,head,branch,detached,locked,lock_reason,
            prunable,kind,tmux_socket_name,status,cleanup_error,created_at,updated_at
          ) VALUES(
            ${id('wt')},${projectId},${item.path},${item.gitWorktreeKey},
            ${item.head ?? ''},${item.branch},${item.detached ? 1 : 0},
            ${item.locked ? 1 : 0},${item.lockReason},${item.prunable ? 1 : 0},
            ${kind},${generateTmuxSocketName()},'active',NULL,${timestamp},${timestamp}
          )
        `)
      }
    })

    if (projectIdentityChanged || changed.length > 0) {
      this.invalidateProjectsSnapshot()
    }

    if (repositoryRenamed) {
      this.events.publish('project.updated', { projectId })
    }

    for (const { existing } of changed) {
      if (existing) {
        this.events.publish('worktree.updated', { worktreeId: existing.id })
      }
    }
  }

  async createWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string
  ): Promise<CreateWorktreeResult> {
    await this.requireOpenProject(projectId)
    if (
      this.projectLocks.has(projectId) &&
      !this.worktreeMutations.has(projectId)
    ) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    return this.worktreeMutations.enqueue(projectId, () =>
      this.executeCreateWorktree(
        projectId,
        inputName,
        base,
        initialTerminal,
        sourceWorktreeId
      )
    )
  }

  private async executeCreateWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string
  ): Promise<CreateWorktreeResult> {
    await this.requireOpenProject(projectId)
    if (this.projectLocks.has(projectId)) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    this.projectLocks.add(projectId)
    let projectLockHeld = true
    let worktreePath: string
    let wrapperPath: string
    let project!: ProjectRecord
    let wrapperCreated = false
    try {
      project = await this.observeAvailableProject(
        await this.requireOpenProject(projectId)
      )
      let name: string
      try {
        name = normalizeWorktreeName(inputName)
      } catch (error) {
        throw new DomainError(
          'INVALID_WORKTREE_NAME',
          error instanceof Error ? error.message : String(error),
          400
        )
      }
      if (
        project.worktrees.some(
          (worktree) =>
            worktree.status !== 'removed' &&
            worktree.name.localeCompare(name, undefined, {
              sensitivity: 'accent'
            }) === 0
        )
      ) {
        throw new DomainError(
          'WORKTREE_EXISTS',
          `A worktree named ${name} already exists`,
          409
        )
      }

      const destination = await resolveZedWorktreePath(
        project.mainWorktreePath,
        name
      ).catch((error: unknown) => {
        throw new DomainError(
          'INVALID_WORKTREE_PATH',
          error instanceof Error ? error.message : String(error),
          400
        )
      })
      worktreePath = destination.path
      wrapperPath = destination.wrapperPath
      const pathExists = await fs.access(worktreePath).then(
        () => true,
        () => false
      )
      if (pathExists) {
        throw new DomainError(
          'WORKTREE_PATH_EXISTS',
          `Destination already exists: ${worktreePath}`,
          409
        )
      }

      let commit: string
      if (base === 'current') {
        if (!sourceWorktreeId) {
          throw new DomainError(
            'INVALID_SOURCE_WORKTREE',
            'A source worktree is required when starting from current',
            400
          )
        }

        const source = await this.getWorktree(sourceWorktreeId)
        if (
          source.projectId !== projectId ||
          source.status !== 'active' ||
          source.prunable
        ) {
          throw new DomainError(
            'INVALID_SOURCE_WORKTREE',
            'The source worktree must be active and belong to the project',
            400
          )
        }

        commit = await this.deps.git.resolveCommit(source.path)
      } else {
        commit = await this.deps.git.resolveDefaultCommit(
          project.repositoryPath
        )
      }

      let preparedWrapper: Awaited<ReturnType<typeof prepareZedWorktreeWrapper>>
      try {
        preparedWrapper = await prepareZedWorktreeWrapper(
          project.mainWorktreePath,
          wrapperPath
        )
      } catch (error) {
        throw new DomainError(
          'INVALID_WORKTREE_PATH',
          error instanceof Error ? error.message : String(error),
          400
        )
      }
      wrapperCreated = preparedWrapper.created
      wrapperPath = preparedWrapper.path
      worktreePath = path.join(
        wrapperPath,
        path.basename(project.mainWorktreePath)
      )
      try {
        await this.deps.git.createDetachedWorktree(
          project.repositoryPath,
          worktreePath,
          commit
        )
      } catch (error) {
        if (wrapperCreated) {
          await fs.rmdir(wrapperPath).catch(() => undefined)
        }

        throw error
      }
      await this.importWorktrees(
        project.id,
        project.repositoryPath,
        project.mainWorktreePath,
        true
      )
      await this.deps.database.db.run(sql`
        UPDATE worktrees
        SET managed_wrapper_path=${wrapperCreated ? wrapperPath : null}
        WHERE path=${worktreePath}
      `)
      const worktree = await this.deps.database.worktreeByPath(worktreePath!)
      if (!worktree) {
        throw new DomainError(
          'WORKTREE_DISCOVERY_FAILED',
          'Git created the worktree but it could not be discovered',
          500
        )
      }

      this.events.publish('worktree.created', {
        projectId,
        worktreeId: worktree.id
      })

      this.projectLocks.delete(projectId)
      projectLockHeld = false

      let terminal: TerminalRecord | null = null
      let terminalError: string | null = null
      let setupError: string | null = null
      if (initialTerminal) {
        const initialTerminalCreation = this.executeCreateTerminal(
          worktree.id,
          initialTerminal.name,
          initialTerminal.argv,
          {
            ...(initialTerminal.returnToShell ? { returnToShell: true } : {}),
            ...(initialTerminal.initialSize
              ? { initialSize: initialTerminal.initialSize }
              : {})
          }
        )
        const setupResolution = resolveCreateWorktreeSetupTasks({
          shell: this.deps.config.shell,
          mainWorktreePath: project.mainWorktreePath,
          worktreePath: worktree.path
        }).then(
          (tasks) => ({ tasks, error: null }),
          (error: unknown) => ({
            tasks: [] as WorktreeSetupTask[],
            error: `create_worktree setup: ${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 4_096)
          })
        )

        try {
          terminal = await initialTerminalCreation
        } catch (error) {
          terminalError = error instanceof Error ? error.message : String(error)
        }
        if (!terminal) {
          try {
            terminal = await this.ensureWorktreeTerminal(worktree.id)
          } catch (error) {
            terminalError ??=
              error instanceof Error ? error.message : String(error)
          }
        }

        const setup = await setupResolution
        setupError = setup.error
        if (setup.tasks.length > 0 || setupError) {
          if (!terminal) {
            setupError ??=
              'create_worktree setup: no persistent terminal could be started'
          } else {
            try {
              await this.executeCreateTerminal(worktree.id, 'Setup', ['true'], {
                setup: { tasks: setup.tasks, error: setupError },
                closeOnSuccess: true,
                ...(initialTerminal.initialSize
                  ? { initialSize: initialTerminal.initialSize }
                  : {})
              })
            } catch (error) {
              const setupTerminalError = `create_worktree setup terminal${
                error instanceof DomainError ? ` [${error.code}]` : ''
              }: ${
                error instanceof Error ? error.message : String(error)
              }`.slice(0, 2_048)
              setupError = setupError
                ? `${setupError.slice(0, 2_047)}\n${setupTerminalError}`
                : setupTerminalError
            }
          }
        }
      } else {
        const hookResults = await runCreateWorktreeTasks({
          runner: this.deps.runner,
          shell: this.deps.config.shell,
          mainWorktreePath: project.mainWorktreePath,
          worktreePath: worktree.path
        }).catch((error: unknown) => [
          {
            label: 'create_worktree setup',
            error: error instanceof Error ? error.message : String(error)
          }
        ])
        const hookFailure = hookResults.find((result) => result.error)
        setupError = hookFailure
          ? `${hookFailure.label}: ${hookFailure.error}`.slice(0, 4_096)
          : null
      }

      try {
        terminal ??= await this.ensureWorktreeTerminal(worktree.id)
      } catch (error) {
        terminalError ??= error instanceof Error ? error.message : String(error)
      }

      this.invalidateProjectsSnapshot()
      return {
        worktree: await this.getWorktree(worktree.id),
        terminal,
        terminalError,
        setupError
      }
    } finally {
      if (projectLockHeld) {
        this.projectLocks.delete(projectId)
      }
    }
  }

  private async ensureProjectTerminals(projectId: string): Promise<void> {
    const project = await this.getProject(projectId)
    if ((await this.deps.database.isProjectOpen(projectId)) !== true) {
      return
    }

    await Promise.all(
      project.worktrees.map((worktree) =>
        this.ensureWorktreeTerminal(worktree.id)
      )
    )
  }

  private ensureWorktreeTerminal(
    worktreeId: string
  ): Promise<TerminalRecord | null> {
    if (this.terminalMutations.has(worktreeId)) {
      return Promise.resolve(null)
    }

    return this.terminalMutations.enqueue(worktreeId, async () => {
      const worktree = await this.deps.database.worktree(worktreeId)
      if (
        !worktree ||
        (await this.deps.database.isProjectOpen(worktree.projectId)) !== true ||
        worktree.status !== 'active' ||
        worktree.prunable ||
        this.worktreeLocks.has(worktreeId)
      ) {
        return null
      }

      this.worktreeLocks.add(worktreeId)
      try {
        const terminals = await this.listWorktreeTerminals(worktree)
        if (terminals.length > 0) {
          return terminals[0]!
        }

        return await this.createTerminalSession(worktree, 'Shell')
      } finally {
        this.worktreeLocks.delete(worktreeId)
      }
    })
  }

  private async createTerminalSession(
    worktree: WorktreeRecord,
    name: string,
    argv?: string[],
    options?: {
      setup?: { tasks: WorktreeSetupTask[]; error: string | null }
      returnToShell?: boolean
      closeOnSuccess?: boolean
      initialSize?: TerminalSize
    }
  ): Promise<TerminalRecord> {
    const project = await this.requireOpenProject(worktree.projectId)
    const terminalId = id('term')
    const sessionName = generateTmuxSessionName()
    const commandArgv = argv ? [...argv] : [this.deps.config.shell, '-l']
    const timestamp = now()
    try {
      await this.deps.tmux.createSession({
        socketName: worktree.tmuxSocketName,
        sessionName,
        terminalId,
        worktreeId: worktree.id,
        name,
        createdAt: timestamp,
        cwd: worktree.path,
        argv: commandArgv,
        ...(options?.returnToShell && argv
          ? { fallbackArgv: [this.deps.config.shell, '-l'] }
          : {}),
        ...(options?.closeOnSuccess ? { closeOnSuccess: true } : {}),
        ...(options?.initialSize ? { initialSize: options.initialSize } : {}),
        env: {
          TREEPORT_API_URL: this.deps.config.apiUrl,
          TREEPORT_PROJECT_ID: project.id,
          TREEPORT_WORKTREE_ID: worktree.id,
          TREEPORT_TERMINAL_ID: terminalId
        },
        ...(options?.setup?.tasks.length
          ? { setupTasks: options.setup.tasks }
          : {}),
        ...(options?.setup?.error ? { setupError: options.setup.error } : {})
      })
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
      tmuxSessionName: sessionName,
      argv: commandArgv,
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
    options?: {
      setup?: { tasks: WorktreeSetupTask[]; error: string | null }
      returnToShell?: boolean
      closeOnSuccess?: boolean
      initialSize?: TerminalSize
    }
  ): Promise<TerminalRecord> {
    await this.getWorktree(worktreeId)
    return this.terminalMutations.enqueue(worktreeId, () =>
      this.executeCreateTerminal(worktreeId, name, argv, options)
    )
  }

  private async executeCreateTerminal(
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: {
      setup?: { tasks: WorktreeSetupTask[]; error: string | null }
      returnToShell?: boolean
      closeOnSuccess?: boolean
      initialSize?: TerminalSize
    }
  ): Promise<TerminalRecord> {
    await this.requireAvailableWorktree(worktreeId)
    try {
      const worktree = await this.deps.database.worktree(worktreeId)
      if (!worktree) {
        throw new DomainError('WORKTREE_NOT_FOUND', 'Worktree not found', 404)
      }

      if (
        this.projectLocks.has(worktree.projectId) ||
        this.worktreeLocks.has(worktreeId) ||
        worktree.status !== 'active' ||
        worktree.prunable
      ) {
        throw new DomainError(
          'WORKTREE_BUSY',
          'Cannot create a terminal while the worktree is cleaning or failed',
          409
        )
      }

      this.worktreeLocks.add(worktreeId)
      try {
        return await this.createTerminalSession(worktree, name, argv, options)
      } finally {
        this.worktreeLocks.delete(worktreeId)
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
      : await this.getTerminalFromBindings(terminalId)
    const worktree = await this.getWorktree(terminal.worktreeId)
    const state = await this.deps.tmux.sessionState(
      worktree.tmuxSocketName,
      terminal.tmuxSessionName
    )
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
      this.projectLocks.has(worktree.projectId) ||
      this.worktreeLocks.has(worktree.id)
    ) {
      throw new DomainError(
        'WORKTREE_BUSY',
        'Cannot rename a terminal during a destructive project operation',
        409
      )
    }

    this.worktreeLocks.add(worktree.id)
    try {
      await this.deps.tmux.renameTerminal(
        worktree.tmuxSocketName,
        terminal.tmuxSessionName,
        name,
        now()
      )
      const renamed = await this.getTerminal(terminalId)
      this.invalidateProjectsSnapshot()
      this.events.publish('terminal.updated', {
        worktreeId: terminal.worktreeId,
        terminalId
      })
      return renamed
    } finally {
      this.worktreeLocks.delete(worktree.id)
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
    const worktree = await this.deps.database.worktree(worktreeId)
    if (!worktree) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Worktree not found', 404)
    }

    await this.requireOpenProject(worktree.projectId)
    if (
      this.projectLocks.has(worktree.projectId) ||
      this.worktreeLocks.has(worktree.id)
    ) {
      throw new DomainError(
        'WORKTREE_BUSY',
        'Cannot delete a terminal during a destructive project operation',
        409
      )
    }

    this.worktreeLocks.add(worktree.id)
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
          'Every open worktree must keep at least one terminal',
          409
        )
      }

      await this.deps.tmux.killSession(
        worktree.tmuxSocketName,
        terminal.tmuxSessionName,
        terminal.id,
        { preserveServer: true }
      )
    } finally {
      this.worktreeLocks.delete(worktree.id)
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

  async refreshPr(worktreeId: string, force = false): Promise<PrInfo> {
    const worktree = await this.requireAvailableWorktree(worktreeId)
    if (worktree.kind === 'main' || !worktree.branch) {
      return worktree.pr
    }

    const age = worktree.pr.refreshedAt
      ? Date.now() - Date.parse(worktree.pr.refreshedAt)
      : Number.POSITIVE_INFINITY
    if (!force && age < 60_000) {
      return worktree.pr
    }

    await this.requireOpenProject(worktree.projectId)
    const pr = await this.deps.gh.pullRequest(worktree.path, worktree.branch)
    const current = await this.deps.database.worktree(worktreeId)

    if (!current) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Worktree not found', 404)
    }

    if (current.status !== 'active') {
      throw new DomainError(
        'WORKTREE_UNAVAILABLE',
        'Cannot refresh a pull request while the worktree is being removed',
        409
      )
    }

    await this.deps.database.db.run(sql`
      UPDATE worktrees
      SET pr_state=${pr.state},pr_number=${pr.number},pr_url=${pr.url},
          pr_base_branch=${pr.baseBranch},pr_head_branch=${pr.headBranch},
          pr_merged_at=${pr.mergedAt},pr_refreshed_at=${pr.refreshedAt},
          updated_at=${now()}
      WHERE id=${worktreeId}
    `)
    this.invalidateProjectsSnapshot()
    this.events.publish('worktree.updated', { worktreeId })
    return pr
  }

  private async prepareRemovePreview(
    worktreeId: string
  ): Promise<{ preview: RemovePreview; statusFingerprint: string }> {
    const worktree = await this.requireAvailableWorktree(worktreeId)
    worktree.terminals = await this.listWorktreeTerminals(worktree)
    const project = await this.getProject(worktree.projectId)
    const live = (
      await this.deps.git.listWorktrees(project.repositoryPath)
    ).find((item) => item.path === worktree.path)
    if (!live) {
      throw new DomainError(
        'WORKTREE_NOT_FOUND',
        'Git no longer reports this worktree',
        404
      )
    }

    const head = live.head ?? worktree.head
    const status = await this.deps.git.dirtyStatus(worktree.path)
    const dirty = status.dirty
    const reachable =
      live.detached && head
        ? await this.deps.git.isCommitReachable(worktree.path, head)
        : null
    const reasons: string[] = []
    const warnings: string[] = []
    if (worktree.kind === 'main') {
      reasons.push('The main checkout cannot be removed')
    }

    if (live.locked) {
      reasons.push(
        live.lockReason
          ? `The worktree is locked: ${live.lockReason}`
          : 'The worktree is locked'
      )
    }

    if (dirty.staged) {
      warnings.push(`${dirty.staged} staged change(s) will be lost`)
    }

    if (dirty.unstaged) {
      warnings.push(`${dirty.unstaged} unstaged change(s) will be lost`)
    }

    if (dirty.untracked) {
      warnings.push(`${dirty.untracked} untracked file(s) will be lost`)
    }

    if (dirty.conflicts) {
      warnings.push(`${dirty.conflicts} conflicted file(s) will be lost`)
    }

    if (live.detached && reachable === false) {
      warnings.push('Detached commits may become unreachable after removal')
    }

    if (live.detached && reachable === null) {
      warnings.push('Detached commit reachability could not be verified')
    }

    const previewWithoutToken = {
      worktreeId,
      name: worktree.name,
      path: worktree.path,
      head,
      branch: live.branch,
      detached: live.detached,
      locked: live.locked,
      lockReason: live.lockReason,
      dirty,
      detachedHeadReachable: reachable,
      forceRequired: dirty.dirty,
      eligible: reasons.length === 0,
      reasons,
      warnings,
      terminals: worktree.terminals.map(({ id: terminalId, name, status }) => ({
        id: terminalId,
        name,
        status
      }))
    } satisfies Omit<RemovePreview, 'confirmationToken'>
    return {
      preview: {
        ...previewWithoutToken,
        confirmationToken: removeConfirmationToken(
          this.removeConfirmationKey,
          previewWithoutToken,
          status.fingerprint
        )
      },
      statusFingerprint: status.fingerprint
    }
  }

  async removePreview(worktreeId: string): Promise<RemovePreview> {
    return (await this.prepareRemovePreview(worktreeId)).preview
  }

  async beginRemove(
    worktreeId: string,
    request: { confirmationToken: string; confirmDestructive: boolean }
  ): Promise<OperationRecord> {
    const worktree = await this.getWorktree(worktreeId)
    await this.requireOpenProject(worktree.projectId)
    if (worktree.status === 'cleaning') {
      throw new DomainError(
        'REMOVE_IN_PROGRESS',
        'The worktree is already being removed',
        409
      )
    }

    if (this.terminalMutations.has(worktreeId)) {
      return this.terminalMutations.enqueue(worktreeId, () => {
        if (this.worktreeMutations.has(worktree.projectId)) {
          return this.worktreeMutations.enqueue(worktree.projectId, () =>
            this.acceptRemove(worktreeId, request)
          )
        }

        return this.acceptRemove(worktreeId, request)
      })
    }

    if (this.worktreeMutations.has(worktree.projectId)) {
      return this.worktreeMutations.enqueue(worktree.projectId, () =>
        this.acceptRemove(worktreeId, request)
      )
    }

    if (
      this.projectLocks.has(worktree.projectId) ||
      this.worktreeLocks.has(worktreeId)
    ) {
      throw new DomainError(
        'REMOVE_IN_PROGRESS',
        'The worktree or project is already being modified',
        409
      )
    }

    return this.acceptRemove(worktreeId, request)
  }

  private async acceptRemove(
    worktreeId: string,
    request: { confirmationToken: string; confirmDestructive: boolean }
  ): Promise<OperationRecord> {
    const worktree = await this.getWorktree(worktreeId)
    await this.requireOpenProject(worktree.projectId)
    if (
      this.worktreeLocks.has(worktreeId) ||
      this.projectLocks.has(worktree.projectId) ||
      worktree.status === 'cleaning'
    ) {
      throw new DomainError(
        'REMOVE_IN_PROGRESS',
        'The worktree or project is already being modified',
        409
      )
    }

    this.worktreeLocks.add(worktreeId)
    let operationStarted = false
    try {
      const { preview } = await this.prepareRemovePreview(worktreeId)
      if (!preview.eligible) {
        throw new DomainError(
          'REMOVE_REFUSED',
          'The worktree cannot be removed',
          409,
          preview
        )
      }

      if (request.confirmationToken !== preview.confirmationToken) {
        throw new DomainError(
          'REMOVE_PREVIEW_STALE',
          'The worktree changed after the removal preview; review it again',
          409,
          preview
        )
      }

      if (preview.warnings.length > 0 && !request.confirmDestructive) {
        throw new DomainError(
          'REMOVE_CONFIRMATION_REQUIRED',
          'Confirm the destructive removal after reviewing its warnings',
          409,
          preview
        )
      }

      const checkout = await this.checkoutStat(preview.path)
      const [checkoutBinding] = await this.deps.database.db.all<{
        git_worktree_key: string | null
        managed_wrapper_path: string | null
      }>(sql`
        SELECT git_worktree_key,managed_wrapper_path
        FROM worktrees WHERE id=${worktreeId}
      `)
      const markerPath = path.join(preview.path, '.git')
      const markerStat = await this.checkoutStat(markerPath)
      const gitMarker = markerStat?.isFile()
        ? await fs.readFile(markerPath, 'utf8').catch(() => null)
        : null
      if (
        !checkout?.isDirectory() ||
        !checkoutBinding?.git_worktree_key ||
        gitMarker === null ||
        !gitMarkerMatchesKey(
          preview.path,
          gitMarker,
          checkoutBinding.git_worktree_key
        )
      ) {
        throw new DomainError(
          'REMOVE_PREVIEW_STALE',
          'The worktree checkout changed after the removal preview; review it again',
          409,
          preview
        )
      }

      const operationId = id('op')
      const checkoutIdentity: RemovalCheckoutIdentity = {
        path: preview.path,
        device: checkout.dev.toString(),
        inode: checkout.ino.toString(),
        gitWorktreeKey: checkoutBinding.git_worktree_key,
        gitMarker,
        managedWrapperPath: checkoutBinding.managed_wrapper_path,
        quarantinePath: path.join(
          path.dirname(preview.path),
          `.${path.basename(preview.path)}.treeport-removing-${operationId}`
        )
      }
      assertCleanupTransition(worktree.status, 'cleaning')
      const timestamp = now()
      await this.deps.database.db.transaction(async (tx) => {
        await tx.run(sql`
          INSERT INTO operations(
            id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at
          ) VALUES(
            ${operationId},'remove',${worktree.projectId},${worktreeId},'pending',
            ${serializeOperation({ ...request, preview, checkoutIdentity })},
            NULL,NULL,${timestamp},${timestamp}
          )
        `)
        await tx.run(sql`
          UPDATE worktrees
          SET status='cleaning',cleanup_error=NULL,updated_at=${timestamp}
          WHERE id=${worktreeId}
        `)
      })
      this.invalidateProjectsSnapshot()
      operationStarted = true
      void this.worktreeMutations
        .enqueue(worktree.projectId, () =>
          this.executeRemove(operationId, worktreeId, preview.forceRequired)
        )
        .catch(() => {
          this.worktreeLocks.delete(worktreeId)
        })
      this.events.publish('remove.started', {
        operationId,
        worktreeId,
        kind: 'remove'
      })
      return await this.getOperation(operationId)
    } finally {
      if (!operationStarted) {
        this.worktreeLocks.delete(worktreeId)
      }
    }
  }

  private async executeRemove(
    operationId: string,
    lockedWorktreeId: string,
    force: boolean
  ): Promise<void> {
    const operation = await this.getOperation(operationId)
    if (operation.worktreeId !== lockedWorktreeId) {
      this.worktreeLocks.delete(lockedWorktreeId)
      return
    }

    const worktree = await this.deps.database.worktree(lockedWorktreeId)
    if (!worktree) {
      this.worktreeLocks.delete(lockedWorktreeId)
      return
    }

    const project = await this.getProject(worktree.projectId)
    await this.deps.database.db.run(sql`
      UPDATE operations SET status='running',updated_at=${now()}
      WHERE id=${operationId}
    `)
    let removalRevalidated = false
    let terminalsStopped = false
    let gitRemoved = false
    try {
      const checkoutIdentity = removalCheckoutIdentity(operation.request)
      const checkout = await this.checkoutStat(worktree.path)
      const authorizationError = checkout
        ? await this.authorizedCheckoutError(worktree.path, checkoutIdentity)
        : 'the accepted checkout no longer exists'
      if (authorizationError) {
        throw new Error(authorizationError)
      }

      const liveWorktree = (
        await this.deps.git.listWorktrees(project.repositoryPath)
      ).find((item) => item.path === worktree.path)
      if (
        !checkoutIdentity ||
        !liveWorktree?.gitWorktreeKey ||
        liveWorktree.gitWorktreeKey !== checkoutIdentity.gitWorktreeKey
      ) {
        throw new Error(
          'Git no longer reports the accepted worktree identity at this path'
        )
      }

      removalRevalidated = true

      await this.deps.tmux.killServer(worktree.tmuxSocketName)
      terminalsStopped = true
      await this.deps.git.removeWorktree(
        project.repositoryPath,
        worktree.path,
        force
      )
      gitRemoved = true
      const checkoutCleanup = await this.removeAuthorizedCheckout(
        worktree.path,
        checkoutIdentity
      )
      if (checkoutCleanup.error) {
        throw new Error(checkoutCleanup.error)
      }

      const timestamp = now()
      await this.deps.database.db.transaction(async (tx) => {
        assertCleanupTransition('cleaning', 'removed')
        await tx.run(sql`
          UPDATE operations
          SET status='completed',
              result_json=${serializeOperation({
                removed: true,
                name: worktree.name,
                branchPreserved: worktree.branch,
                path: worktree.path
              })},
              updated_at=${timestamp}
          WHERE id=${operationId}
        `)
        await tx.run(sql`DELETE FROM worktrees WHERE id=${worktree.id}`)
      })
      this.clearWorktreeTerminalState(worktree.id)
      this.invalidateProjectsSnapshot()
      if (worktree.managedWrapperPath) {
        await fs.rmdir(worktree.managedWrapperPath).catch(() => undefined)
      }

      this.events.publish('worktree.removed', {
        projectId: project.id,
        worktreeId: worktree.id
      })
      this.events.publish('remove.completed', {
        operationId,
        worktreeId: worktree.id
      })
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error)
      const message = (
        !removalRevalidated
          ? `Removal revalidation failed before destructive effects: ${base}`
          : !terminalsStopped
            ? `Terminal shutdown failed before Git removal: ${base}`
            : gitRemoved
              ? `Manual cleanup required: Git stopped reporting the worktree, but checkout cleanup failed: ${base}`
              : `Terminals were stopped, but Git removal failed: ${base}`
      ).slice(0, 4_096)
      const timestamp = now()
      await this.deps.database.db.transaction(async (tx) => {
        assertCleanupTransition('cleaning', 'cleanup_failed')
        await tx.run(sql`
          UPDATE worktrees
          SET status='cleanup_failed',cleanup_error=${message},updated_at=${timestamp}
          WHERE id=${worktree.id}
        `)
        await tx.run(sql`
          UPDATE operations
          SET status='failed',error=${message},updated_at=${timestamp}
          WHERE id=${operationId}
        `)
      })
      this.invalidateProjectsSnapshot()
      this.events.publish('remove.failed', {
        operationId,
        worktreeId: worktree.id,
        error: message
      })
    } finally {
      this.worktreeLocks.delete(lockedWorktreeId)
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    if (
      this.projectLocks.has(projectId) ||
      this.worktreeMutations.has(projectId)
    ) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    let project = await this.getProject(projectId)
    if (
      project.worktrees.some((worktree) => this.worktreeLocks.has(worktree.id))
    ) {
      throw new DomainError(
        'PROJECT_BUSY',
        'A project worktree is already being modified',
        409
      )
    }

    this.projectLocks.add(projectId)
    const lockedWorktrees: string[] = []
    try {
      project = await this.observeAvailableProject(project, true)
      if (
        this.worktreeMutations.has(projectId) ||
        project.worktrees.some((worktree) =>
          this.worktreeLocks.has(worktree.id)
        )
      ) {
        throw new DomainError(
          'PROJECT_BUSY',
          'A project worktree is already being modified',
          409
        )
      }

      for (const worktree of project.worktrees) {
        this.worktreeLocks.add(worktree.id)
        lockedWorktrees.push(worktree.id)
      }
      project = await this.getProject(projectId)
      const linked = project.worktrees.filter(
        (worktree) => worktree.kind === 'linked'
      )
      if (linked.length) {
        throw new DomainError(
          'PROJECT_HAS_WORKTREES',
          'Remove linked worktrees before unregistering the project',
          409
        )
      }

      const terminalIdsByWorktree = new Map<string, string[]>()
      for (const worktree of project.worktrees) {
        terminalIdsByWorktree.set(
          worktree.id,
          await this.deps.tmux.killServer(worktree.tmuxSocketName)
        )
      }
      await this.deps.database.db.run(
        sql`DELETE FROM projects WHERE id=${projectId}`
      )
      for (const worktree of project.worktrees) {
        this.clearWorktreeTerminalState(
          worktree.id,
          terminalIdsByWorktree.get(worktree.id)
        )
      }
      this.invalidateProjectsSnapshot()
      this.events.publish('project.removed', { projectId })
    } finally {
      for (const worktreeId of lockedWorktrees) {
        this.worktreeLocks.delete(worktreeId)
      }
      this.projectLocks.delete(projectId)
    }
  }

  async terminateAllTerminals(): Promise<number> {
    await this.drainMutations()
    let terminated = 0
    for (const project of await this.listProjects()) {
      for (const worktree of project.worktrees) {
        const terminalIds = await this.deps.tmux.killServer(
          worktree.tmuxSocketName
        )
        terminated += terminalIds.length
        this.clearWorktreeTerminalState(worktree.id, terminalIds)
      }
    }
    this.invalidateProjectsSnapshot()
    return terminated
  }

  async drainMutations(): Promise<void> {
    await Promise.all([
      this.worktreeMutations.drain(),
      this.terminalMutations.drain()
    ])
  }

  async reconcile(): Promise<void> {
    const availableProjects = new Set<string>()
    for (const project of await this.deps.database.openProjects()) {
      try {
        await this.importWorktrees(
          project.id,
          project.repositoryPath,
          project.mainWorktreePath
        )
        availableProjects.add(project.id)
      } catch {
        // Keep metadata and tmux untouched while Git is unavailable.
      }
    }
    for (const project of await this.deps.database.openProjects()) {
      if (!availableProjects.has(project.id)) {
        continue
      }

      for (const worktree of project.worktrees) {
        await this.deps.tmux
          .configureServer(worktree.tmuxSocketName)
          .catch(() => undefined)
      }
      await this.ensureProjectTerminals(project.id).catch(() => undefined)
    }
  }
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}
