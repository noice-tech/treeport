import fs from 'node:fs/promises'
import path from 'node:path'
import { treeContextValuesSchema } from '@treeport/shared'
import type {
  DirectoryBrowseResponse,
  OperationRecord,
  ProjectColor,
  ProjectRecord,
  RecentProjectRecord,
  TerminalRecord,
  TreeContextFieldListing,
  TreeContextValues,
  WebPanelDefinition,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { TreeportDatabase } from '../../database'
import { mapOperation, mapProject, mapWorktree } from '../../database'
import { operations, projects, worktrees } from '../../database-schema'
import { DomainError } from '../../domain'
import type { ProductEventBus } from '../../events'
import type { GitAdapter } from '../../git'
import type { PackageSystem } from '../../package-system'
import type { TerminalSessionBackend } from '../../terminal'
import { loadTreeContextFields } from '../../tree-context'
import type {
  PromiseMutationLocks,
  PromiseMutationQueue
} from '../infrastructure/application-runtime'
import { ProjectRegistrationService } from './project-registration-service'
import { ProjectSnapshotService } from './project-snapshot-service'

const now = (): string => new Date().toISOString()

export interface ProjectServiceDependencies {
  readonly config: AppConfig
  readonly database: TreeportDatabase
  readonly git: GitAdapter
  readonly terminalHost: TerminalSessionBackend
  readonly events: ProductEventBus
  readonly packages: PackageSystem
  readonly locks: PromiseMutationLocks
  readonly worktreeMutations: PromiseMutationQueue
  readonly projectObservations: PromiseMutationQueue
  readonly listWorktreeTerminals: (
    worktree: WorktreeRecord
  ) => Promise<TerminalRecord[]>
  readonly ensureProjectTerminals: (projectId: string) => Promise<void>
  readonly clearWorktreeTerminalState: (
    worktreeId: string,
    discoveredTerminalIds?: Iterable<string>
  ) => void
  readonly trackedTerminalIds: (worktreeId: string) => Set<string>
  readonly rememberTerminalIds: (
    worktreeId: string,
    terminalIds: Iterable<string>
  ) => void
  readonly listWebPanelDefinitions: (
    worktreeId: string
  ) => Promise<WebPanelDefinition[]>
  readonly reconcileProjectWorktrees: (
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock: boolean,
    allowClosed?: boolean
  ) => Promise<void>
}

export class ProjectService {
  private readonly observedFolderIdentities = new Map<
    string,
    { device: string; inode: string }
  >()
  private readonly registration: ProjectRegistrationService
  private readonly snapshots: ProjectSnapshotService

  constructor(private readonly host: ProjectServiceDependencies) {
    this.snapshots = new ProjectSnapshotService({
      database: host.database,
      git: host.git,
      storedProjects: (openOnly) => this.storedProjects(openOnly),
      storedProject: (projectId) => this.storedProject(projectId),
      projectOpenState: (projectId) => this.projectOpenState(projectId),
      importWorktrees: (projectId, repositoryPath, mainPath) =>
        this.importWorktrees(projectId, repositoryPath, mainPath),
      observeAvailableProject: (project) =>
        this.observeAvailableProject(project),
      ensureProjectTerminals: (projectId) =>
        this.ensureProjectTerminals(projectId),
      listWorktreeTerminals: (worktree) => this.listWorktreeTerminals(worktree),
      listWebPanelDefinitions: (worktreeId) =>
        this.listWebPanelDefinitions(worktreeId),
      getWorktree: (worktreeId) => this.getWorktree(worktreeId),
      requireOpenProject: (projectId) => this.requireOpenProject(projectId)
    })
    this.registration = new ProjectRegistrationService({
      ...host,
      observedFolderIdentities: this.observedFolderIdentities,
      storedProject: (projectId) => this.storedProject(projectId),
      getProject: (projectId) => this.getProject(projectId),
      getProjectSnapshot: (projectId) => this.getProjectSnapshot(projectId),
      ensureProjectTerminals: (projectId) =>
        this.ensureProjectTerminals(projectId),
      invalidateProjectsSnapshot: () => this.invalidateProjectsSnapshot(),
      reconcileProjectWorktrees: (
        projectId,
        repositoryPath,
        mainPath,
        allowProjectLock,
        allowClosed
      ) =>
        this.reconcileProjectWorktrees(
          projectId,
          repositoryPath,
          mainPath,
          allowProjectLock,
          allowClosed
        ),
      serializeProjectObservation: (projectId, operation) =>
        this.serializeProjectObservation(projectId, operation)
    })
  }

  private get deps() {
    return this.host
  }

  private get events() {
    return this.host.events
  }

  private get packages() {
    return this.host.packages
  }

  private get locks() {
    return this.host.locks
  }

  private get worktreeMutations() {
    return this.host.worktreeMutations
  }

  private get projectObservations() {
    return this.host.projectObservations
  }

  private listWorktreeTerminals(worktree: WorktreeRecord) {
    return this.host.listWorktreeTerminals(worktree)
  }

  private ensureProjectTerminals(projectId: string) {
    return this.host.ensureProjectTerminals(projectId)
  }

  private clearWorktreeTerminalState(
    worktreeId: string,
    terminalIds: Iterable<string> = []
  ) {
    this.host.clearWorktreeTerminalState(worktreeId, terminalIds)
  }

  private listWebPanelDefinitions(worktreeId: string) {
    return this.host.listWebPanelDefinitions(worktreeId)
  }

  private reconcileProjectWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock: boolean,
    allowClosed = false
  ) {
    return this.host.reconcileProjectWorktrees(
      projectId,
      repositoryPath,
      mainPath,
      allowProjectLock,
      allowClosed
    )
  }

  async storedProjects(openOnly = false): Promise<ProjectRecord[]> {
    const projectRows = await this.deps.database.db
      .select()
      .from(projects)
      .where(openOnly ? eq(projects.isOpen, 1) : undefined)
      .orderBy(sql`${projects.name} COLLATE NOCASE`)
    const worktreeRows = await this.deps.database.db
      .select()
      .from(worktrees)
      .orderBy(
        asc(worktrees.projectId),
        sql`CASE ${worktrees.kind} WHEN 'main' THEN 0 ELSE 1 END`,
        asc(worktrees.createdAt),
        sql`rowid`
      )
    return projectRows.map((project) =>
      mapProject(
        project,
        worktreeRows.filter((worktree) => worktree.projectId === project.id)
      )
    )
  }

  async storedProject(projectId: string): Promise<ProjectRecord | null> {
    const [project] = await this.deps.database.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
    if (!project) {
      return null
    }

    const worktreeRows = await this.deps.database.db
      .select()
      .from(worktrees)
      .where(eq(worktrees.projectId, projectId))
      .orderBy(
        sql`CASE ${worktrees.kind} WHEN 'main' THEN 0 ELSE 1 END`,
        asc(worktrees.createdAt),
        sql`rowid`
      )
    return mapProject(project, worktreeRows)
  }

  async storedWorktree(worktreeId: string): Promise<WorktreeRecord | null> {
    const [row] = await this.deps.database.db
      .select({
        worktree: worktrees,
        mainWorktreePath: projects.mainWorktreePath
      })
      .from(worktrees)
      .innerJoin(projects, eq(worktrees.projectId, projects.id))
      .where(eq(worktrees.id, worktreeId))
      .limit(1)
    return row ? mapWorktree(row.worktree, row.mainWorktreePath) : null
  }

  async projectOpenState(projectId: string): Promise<boolean | null> {
    const [row] = await this.deps.database.db
      .select({ isOpen: projects.isOpen })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
    return row ? Boolean(row.isOpen) : null
  }

  async storedOperation(operationId: string): Promise<OperationRecord | null> {
    const [row] = await this.deps.database.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId))
      .limit(1)
    return row ? mapOperation(row) : null
  }

  invalidateProjectsSnapshot(): void {
    this.snapshots.invalidate()
  }

  listProjects(): Promise<ProjectRecord[]> {
    return this.snapshots.listProjects()
  }

  listRecentProjects(): Promise<RecentProjectRecord[]> {
    return this.snapshots.listRecentProjects()
  }

  getProjectSnapshot(projectId: string): Promise<ProjectRecord> {
    return this.snapshots.getProjectSnapshot(projectId)
  }

  getWorktreeSnapshot(worktreeId: string): Promise<WorktreeRecord> {
    return this.snapshots.getWorktreeSnapshot(worktreeId)
  }

  async requireAvailableWorktree(
    worktreeId: string,
    allowPrunable = false
  ): Promise<WorktreeRecord> {
    const binding = await this.storedWorktree(worktreeId)
    if (!binding) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
    }

    const project = await this.observeAvailableProject(
      await this.requireOpenProject(binding.projectId)
    )

    const worktree = project.worktrees.find(
      (candidate) => candidate.id === worktreeId
    )
    if (!worktree) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
    }

    if (worktree.prunable && !allowPrunable) {
      throw new DomainError(
        'WORKTREE_UNAVAILABLE',
        'Git reports this worktree as prunable',
        409
      )
    }

    return worktree
  }

  async getProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.storedProject(projectId)
    if (!project) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
    }

    return project
  }

  async requireOpenProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.getProject(projectId)
    if ((await this.projectOpenState(projectId)) !== true) {
      throw new DomainError(
        'PROJECT_CLOSED',
        'Project is closed; open it before modifying it',
        409
      )
    }

    return project
  }

  async resolveRegisteredProject(identifier: string): Promise<ProjectRecord> {
    const direct = await this.storedProject(identifier)
    if (direct) {
      return direct
    }

    const canonical = await fs
      .realpath(path.resolve(identifier))
      .catch(() => path.resolve(identifier))
    const match = (await this.storedProjects()).find(
      (project) =>
        isPathWithin(canonical, project.rootPath) ||
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

    return match
  }

  async updateProjectColor(
    projectId: string,
    color: ProjectColor | null
  ): Promise<ProjectRecord> {
    await this.requireOpenProject(projectId)
    if (
      (await this.locks.isProjectLocked(projectId)) ||
      (await this.worktreeMutations.isBusy(projectId))
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

  async listTreeContextFields(
    projectId: string
  ): Promise<TreeContextFieldListing> {
    const project = await this.getProject(projectId)
    return loadTreeContextFields({
      dataDir: this.deps.config.dataDir,
      projectRoot: project.rootPath
    })
  }

  async getWorktree(worktreeId: string): Promise<WorktreeRecord> {
    const worktree = await this.storedWorktree(worktreeId)
    if (!worktree) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
    }

    return worktree
  }

  async getWorktreeContext(worktreeId: string): Promise<TreeContextValues> {
    const [row] = await this.deps.database.db
      .select({ treeContextJson: worktrees.treeContextJson })
      .from(worktrees)
      .where(eq(worktrees.id, worktreeId))
      .limit(1)
    if (!row) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
    }

    return treeContextValuesSchema.parse(JSON.parse(row.treeContextJson))
  }

  async requestWorkspaceOpen(
    worktreeId: string,
    sourceTerminalId: string
  ): Promise<void> {
    const worktree = await this.getWorktree(worktreeId)
    await this.requireOpenProject(worktree.projectId)
    this.events.publish('workspace.open_requested', {
      worktreeId,
      sourceTerminalId
    })
  }

  async getOperation(operationId: string): Promise<OperationRecord> {
    const operation = await this.storedOperation(operationId)
    if (!operation) {
      throw new DomainError('OPERATION_NOT_FOUND', 'Operation not found', 404)
    }

    return operation
  }

  async resolveProject(identifier: string): Promise<ProjectRecord> {
    const direct = await this.storedProject(identifier)
    if (direct) {
      return await this.requireOpenProject(direct.id)
    }

    const canonical = await fs
      .realpath(path.resolve(identifier))
      .catch(() => path.resolve(identifier))
    const projects = await this.storedProjects()
    const match = projects.find(
      (project) =>
        isPathWithin(canonical, project.rootPath) ||
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
    const direct = await this.storedWorktree(identifier)
    if (direct) {
      await this.requireOpenProject(direct.projectId)
      return direct
    }

    const canonical = await fs
      .realpath(path.resolve(identifier))
      .catch(() => path.resolve(identifier))
    const matches = (await this.storedProjects())
      .flatMap((project) => project.worktrees)
      .filter((worktree) => isPathWithin(canonical, worktree.path))
      .sort((a, b) => b.path.length - a.path.length)
    const match = matches[0]
    if (!match) {
      throw new DomainError(
        'WORKTREE_NOT_FOUND',
        `No registered tree contains ${identifier}`,
        404
      )
    }

    await this.requireOpenProject(match.projectId)
    return match
  }

  browseDirectory(
    inputPath: string,
    showHidden = false
  ): Promise<DirectoryBrowseResponse> {
    return this.registration.browseDirectory(inputPath, showHidden)
  }

  registerProject(
    inputPath: string,
    requestedName?: string
  ): Promise<ProjectRecord> {
    return this.registration.registerProject(inputPath, requestedName)
  }

  async observeAvailableProject(
    project: ProjectRecord,
    allowClosed = false
  ): Promise<ProjectRecord> {
    try {
      if (project.kind === 'repository') {
        await this.importWorktrees(
          project.id,
          project.repositoryPath,
          project.mainWorktreePath,
          true,
          allowClosed
        )
      } else {
        await this.serializeProjectObservation(project.id, async () => {
          if (
            (!allowClosed &&
              (await this.projectOpenState(project.id)) !== true) ||
            (await this.worktreeMutations.isBusy(project.id))
          ) {
            return
          }

          const [metadata] = await this.deps.database.db
            .select({
              device: projects.repositoryDevice,
              inode: projects.repositoryInode
            })
            .from(projects)
            .where(eq(projects.id, project.id))
            .limit(1)
          const [canonicalPath, folderStat] = await Promise.all([
            fs.realpath(project.rootPath),
            fs.stat(project.rootPath, { bigint: true })
          ])
          if (
            !metadata ||
            canonicalPath !== project.rootPath ||
            !folderStat.isDirectory()
          ) {
            throw new Error(
              'The registered folder path is not an available directory'
            )
          }

          const device = folderStat.dev.toString()
          const inode = folderStat.ino.toString()
          const observedIdentity = this.observedFolderIdentities.get(project.id)
          if (
            observedIdentity &&
            (observedIdentity.device !== device ||
              observedIdentity.inode !== inode)
          ) {
            throw new Error(
              'The registered folder path changed during this daemon session'
            )
          }

          const folderWorktrees = project.worktrees.filter(
            (worktree) =>
              worktree.kind === 'folder' && worktree.path === project.rootPath
          )
          if (folderWorktrees.length !== 1 || project.worktrees.length !== 1) {
            throw new Error(
              'The registered folder does not have one folder workspace'
            )
          }

          if (metadata.device !== device || metadata.inode !== inode) {
            await this.deps.database.db
              .update(projects)
              .set({ repositoryDevice: device, repositoryInode: inode })
              .where(eq(projects.id, project.id))
          }

          this.observedFolderIdentities.set(project.id, { device, inode })
        })
      }
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
      (await this.worktreeMutations.isBusy(projectId)) ||
      !(await this.locks.tryAcquire({ projectId }))
    ) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    try {
      const project = await this.observeAvailableProject(
        await this.getProject(projectId)
      )
      await this.ensureProjectTerminals(projectId)
      if (project.kind === 'repository') {
        const defaultBranch = await this.deps.git.defaultBranch(
          project.repositoryPath
        )
        await this.deps.database.db.run(sql`
          UPDATE projects
          SET default_branch = ${defaultBranch}, updated_at = ${now()}
          WHERE id = ${projectId}
        `)
      }

      await this.reconcile()
      await this.packages.registerProject(await this.getProject(projectId))
      this.invalidateProjectsSnapshot()
      this.events.publish('project.updated', { projectId })
      return await this.getProject(projectId)
    } finally {
      await this.locks.release({ projectId: projectId })
    }
  }

  async openProject(projectId: string): Promise<ProjectRecord> {
    await this.serializeProjectObservation(projectId, async () => {
      await this.getProject(projectId)
      if (
        (await this.worktreeMutations.isBusy(projectId)) ||
        !(await this.locks.tryAcquire({ projectId }))
      ) {
        throw new DomainError(
          'PROJECT_BUSY',
          'Project is already being modified',
          409
        )
      }

      try {
        const timestamp = now()
        await this.deps.database.db
          .update(projects)
          .set({
            isOpen: 1,
            showInRecents: 0,
            lastOpenedAt: timestamp,
            updatedAt: timestamp
          })
          .where(eq(projects.id, projectId))
        await this.packages.registerProject(await this.getProject(projectId))
        this.invalidateProjectsSnapshot()
        this.events.publish('project.updated', { projectId })
      } finally {
        await this.locks.release({ projectId: projectId })
      }
    })

    return this.getProjectSnapshot(projectId)
  }

  async closeProject(projectId: string): Promise<void> {
    await this.serializeProjectObservation(projectId, async () => {
      const project = await this.getProject(projectId)
      if ((await this.projectOpenState(projectId)) !== true) {
        return
      }

      const lockedWorktreeIds = project.worktrees.map((worktree) => worktree.id)
      if (
        (await this.worktreeMutations.isBusy(projectId)) ||
        !(await this.locks.tryAcquire({
          projectId,
          worktreeIds: lockedWorktreeIds
        }))
      ) {
        throw new DomainError(
          'PROJECT_BUSY',
          'Project is already being modified',
          409
        )
      }

      try {
        await this.deps.database.db
          .update(projects)
          .set({ isOpen: 0, showInRecents: 1, updatedAt: now() })
          .where(eq(projects.id, projectId))

        this.invalidateProjectsSnapshot()
        this.events.publish('project.updated', { projectId })
      } finally {
        await this.locks.release({
          projectId,
          worktreeIds: lockedWorktreeIds
        })
      }
    })
  }

  async dismissRecentProject(projectId: string): Promise<void> {
    await this.serializeProjectObservation(projectId, async () => {
      await this.getProject(projectId)
      if ((await this.projectOpenState(projectId)) !== false) {
        throw new DomainError(
          'PROJECT_NOT_RECENT',
          'Project is open and cannot be removed from Recent projects',
          409
        )
      }

      await this.deps.database.db
        .update(projects)
        .set({ showInRecents: 0, updatedAt: now() })
        .where(and(eq(projects.id, projectId), eq(projects.isOpen, 0)))
      this.events.publish('project.updated', { projectId })
    })
  }

  private serializeProjectObservation<T>(
    projectId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.projectObservations.enqueue(projectId, operation)
  }

  importWorktrees(
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

  async deleteProject(projectId: string): Promise<void> {
    if (await this.worktreeMutations.isBusy(projectId)) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    let project = await this.getProject(projectId)
    const lockedWorktrees = project.worktrees.map((worktree) => worktree.id)
    if (
      !(await this.locks.tryAcquire({
        projectId,
        worktreeIds: lockedWorktrees
      }))
    ) {
      throw new DomainError(
        'PROJECT_BUSY',
        'A project tree is already being modified',
        409
      )
    }

    try {
      project = await this.observeAvailableProject(project, true)
      const additionalWorktrees = project.worktrees
        .map((worktree) => worktree.id)
        .filter((worktreeId) => !lockedWorktrees.includes(worktreeId))
      if (
        (await this.worktreeMutations.isBusy(projectId)) ||
        !(await this.locks.tryAcquire({ worktreeIds: additionalWorktrees }))
      ) {
        throw new DomainError(
          'PROJECT_BUSY',
          'A project tree is already being modified',
          409
        )
      }

      lockedWorktrees.push(...additionalWorktrees)
      project = await this.getProject(projectId)
      const linked = project.worktrees.filter(
        (worktree) => worktree.kind === 'linked'
      )
      if (linked.length) {
        throw new DomainError(
          'PROJECT_HAS_WORKTREES',
          'Remove linked trees before unregistering the project',
          409
        )
      }

      const terminalIdsByWorktree = new Map<string, string[]>()
      for (const worktree of project.worktrees) {
        terminalIdsByWorktree.set(
          worktree.id,
          await this.deps.terminalHost.killWorktree(worktree.id)
        )
      }
      await this.deps.database.db.run(
        sql`DELETE FROM projects WHERE id=${projectId}`
      )
      this.observedFolderIdentities.delete(projectId)
      this.packages.forgetProject(projectId)
      for (const worktree of project.worktrees) {
        this.clearWorktreeTerminalState(
          worktree.id,
          terminalIdsByWorktree.get(worktree.id)
        )
      }
      this.invalidateProjectsSnapshot()
      this.events.publish('project.removed', { projectId })
    } finally {
      await this.locks.release({
        projectId,
        worktreeIds: lockedWorktrees
      })
    }
  }

  async reconcile(): Promise<void> {
    const availableProjects = new Set<string>()
    for (const project of await this.storedProjects(true)) {
      try {
        await this.observeAvailableProject(project)
        availableProjects.add(project.id)
      } catch {
        // Keep metadata and terminal host untouched while the project folder is unavailable.
      }
    }
    for (const project of await this.storedProjects(true)) {
      if (!availableProjects.has(project.id)) {
        continue
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
