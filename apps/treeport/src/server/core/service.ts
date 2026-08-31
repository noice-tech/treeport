import crypto from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  TREE_FILE_LIST_MAX_ENTRIES,
  TREE_FILE_MAX_BYTES,
  WEB_PANEL_INPUT_MAX_BYTES,
  browserUrlSchema,
  treeContextValuesSchema,
  treeFilePathSchema,
  webPanelInputSchema
} from '@treeport/shared'
import type {
  BrowserPanel,
  CreateOperationRequest,
  DirectoryBrowseResponse,
  JsonValue,
  OpenBrowserPanelResult,
  OpenWebPanelResult,
  OperationRecord,
  PackageListing,
  PackageOperationResult,
  PackageResourceDiagnostic,
  PrInfo,
  ProjectColor,
  ProjectRecord,
  RecentProjectRecord,
  RemovalCheckoutIdentity,
  RemovePreview,
  TerminalPreset,
  TerminalPresetDefinitionListing,
  TerminalRecord,
  TerminalSize,
  TreeContextFieldListing,
  TreeContextValues,
  TreeFile,
  TreeFileListing,
  TreeFileWrite,
  TreeFileWriteResult,
  WebPanel,
  WebPanelContext,
  WebPanelDefinition,
  WebPanelLaunch,
  WebPanelPermission,
  WorktreeListenerDiscovery,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, desc, eq, ne, or, sql } from 'drizzle-orm'
import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse
} from 'node:http'
import type { AppConfig } from './config'
import type { CommandRunner } from './command'
import type { TreeportDatabase } from './database'
import {
  mapOperation,
  mapProject,
  mapTerminalPreset,
  mapWorktree,
  serializeOperation
} from './database'
import {
  browserPanels,
  operations,
  projects,
  terminalPresets,
  webPanels,
  webPanelPermissionGrants,
  webPanelStorage,
  worktrees
} from './database-schema'
import { DomainError } from './domain'
import { ProductEventBus } from './events'
import type { GhAdapter } from './gh'
import type { GitAdapter } from './git'
import { NetworkListenerAdapter } from './network-listeners'
import { PackageSystem } from './package-system'
import { loadRepositoryTerminalPresets } from './repository-terminal-presets'
import { loadTreeContextFields } from './tree-context'
import {
  resolveWorktreeSetupTasks,
  runWorktreeSetupTasks,
  type WorktreeSetupTask
} from './setup'
import {
  WebPanelViteRuntime,
  type ResolvedWebPanelSource,
  type WebPanelAssetResolution
} from './web-panel-vite-runtime'
import { KeyedTaskQueue } from './task-queue'
import type { TerminalSessionBackend } from './terminal'
import {
  loadZedTerminalPresetDefinitions,
  normalizeWorktreeName,
  prepareZedWorktreeWrapper,
  resolveZedWorktreePath
} from './zed'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
const WEB_PANEL_STORAGE_MAX_ENTRIES = 256
const WEB_PANEL_STORAGE_MAX_TOTAL_BYTES = 1024 * 1024
const WEB_PANEL_STORAGE_MAX_VALUE_BYTES = 64 * 1024

interface CheckoutCleanupResult {
  removed: boolean
  error: string | null
}

interface TerminalLaunchOptions {
  setup?: { tasks: WorktreeSetupTask[]; error: string | null }
  initialTitle?: string
  returnToShell?: boolean
  closeOnSuccess?: boolean
  initialSize?: TerminalSize
  cwd?: string
  env?: Record<string, string>
  shellCommand?: string
}

function mapBrowserPanel(row: typeof browserPanels.$inferSelect): BrowserPanel {
  return {
    id: row.id,
    kind: 'browser',
    worktreeId: row.worktreeId,
    title: row.title,
    url: row.url,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function mapWebPanel(
  row: typeof webPanels.$inferSelect,
  permissions: WebPanelPermission[] = [],
  permissionsGranted = permissions.length === 0
): WebPanel {
  const parsedInput = webPanelInputSchema
    .nullable()
    .safeParse(JSON.parse(row.inputJson))
  if (!parsedInput.success) {
    throw new Error(`Web panel ${row.id} has invalid stored launch input`)
  }

  return {
    id: row.id,
    kind: 'web',
    worktreeId: row.worktreeId,
    definitionId: row.definitionId,
    title: row.title,
    launch: {
      input: parsedInput.data,
      cwd: row.launchCwd
    },
    permissions,
    sandbox: {
      allowSameOrigin: permissionsGranted && permissions.includes('same-origin')
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
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
  terminalHost: TerminalSessionBackend
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
  private readonly treeFileMutations = new KeyedTaskQueue<string>()
  private readonly removeConfirmationKey = crypto.randomBytes(32)
  private readonly terminalStates = new Map<string, TerminalRecord>()
  private readonly closeOnSuccessTerminalIds = new Set<string>()
  private readonly terminalIdsByWorktree = new Map<string, Set<string>>()
  private readonly projectObservationTails = new Map<string, Promise<void>>()
  private readonly observedFolderIdentities = new Map<
    string,
    { device: string; inode: string }
  >()
  private projectsSnapshotInFlight: Promise<ProjectRecord[]> | null = null
  private projectsSnapshotRevision = 0
  private readonly packages: PackageSystem
  private readonly networkListeners: NetworkListenerAdapter
  private readonly webPanelRuntime: WebPanelViteRuntime

  constructor(private readonly deps: ServiceDependencies) {
    this.events = deps.events ?? new ProductEventBus()
    this.packages = new PackageSystem(deps.config, deps.runner)
    this.networkListeners = new NetworkListenerAdapter(deps.runner)
    this.webPanelRuntime = new WebPanelViteRuntime(deps.config)
  }

  attachHttpServer(server: HttpServer): void {
    this.webPanelRuntime.attachHttpServer(server)
  }

  handleWebPanelDevelopmentRequest(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void
  ): void {
    this.webPanelRuntime.handleDevelopmentRequest(request, response, next)
  }

  async disposeWebPanelRuntime(): Promise<void> {
    await this.webPanelRuntime.dispose()
  }

  get database(): TreeportDatabase {
    return this.deps.database
  }

  private async storedProjects(openOnly = false): Promise<ProjectRecord[]> {
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

  private async storedProject(
    projectId: string
  ): Promise<ProjectRecord | null> {
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

  private async storedWorktree(
    worktreeId: string
  ): Promise<WorktreeRecord | null> {
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

  private async projectOpenState(projectId: string): Promise<boolean | null> {
    const [row] = await this.deps.database.db
      .select({ isOpen: projects.isOpen })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
    return row ? Boolean(row.isOpen) : null
  }

  private async storedOperation(
    operationId: string
  ): Promise<OperationRecord | null> {
    const [row] = await this.deps.database.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId))
      .limit(1)
    return row ? mapOperation(row) : null
  }

  async initialize(): Promise<void> {
    await this.deps.terminalHost.initialize()
    const interrupted = await this.deps.database.db.all<{
      id: string
      kind: OperationRecord['kind']
    }>(sql`
      SELECT id, kind
      FROM operations
      WHERE status IN ('pending','running')
    `)
    const timestamp = now()
    await this.deps.database.db.transaction(async (tx) => {
      for (const operation of interrupted) {
        if (operation.kind === 'remove') {
          continue
        }

        await tx.run(sql`
          UPDATE operations
          SET status = 'failed',
              error = ${
                operation.kind === 'create'
                  ? 'Daemon restarted before tree creation completed; existing Git state will be discovered without replaying the creation'
                  : 'Daemon restarted before the operation completed; external state was preserved for retry'
              },
              updated_at = ${timestamp}
          WHERE id = ${operation.id}
        `)
      }
    })
    await this.reconcile()

    for (const interruptedOperation of interrupted) {
      if (interruptedOperation.kind !== 'remove') {
        continue
      }

      const operation = await this.storedOperation(interruptedOperation.id)
      if (
        operation?.kind !== 'remove' ||
        !operation.projectId ||
        !operation.request.preview
      ) {
        continue
      }

      const worktreeId = operation.request.preview.worktreeId
      this.worktreeLocks.add(worktreeId)
      void this.worktreeMutations
        .enqueue(operation.projectId, () =>
          this.executeRemove(
            operation.id,
            worktreeId,
            operation.request.preview!.forceRequired
          )
        )
        .catch(() => {
          this.worktreeLocks.delete(worktreeId)
        })
    }

    await this.packages.initialize(await this.storedProjects())
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
    return fs.lstat(checkoutPath, { bigint: true }).catch((error) => {
      // SAFETY: The surrounding boundary contract establishes this asserted value.
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
      return 'The residual checkout has no matching filesystem identity'
    }

    if (
      !checkout.isDirectory() ||
      checkout.dev.toString() !== identity.device ||
      checkout.ino.toString() !== identity.inode
    ) {
      return 'The residual checkout path now refers to a different filesystem object'
    }

    const markerPath = path.join(checkoutPath, '.git')
    const markerStat = await this.checkoutStat(markerPath)
    const marker = markerStat?.isFile()
      ? await fs.readFile(markerPath, 'utf8').catch(() => null)
      : null
    if (
      marker !== identity.gitMarker ||
      !gitMarkerMatchesKey(acceptedPath, marker ?? '', identity.gitWorktreeKey)
    ) {
      return 'The residual checkout Git marker no longer proves that Treeport owns this removal'
    }

    return null
  }

  private async removeAuthorizedCheckout(
    checkoutPath: string,
    identity: RemovalCheckoutIdentity | null
  ): Promise<CheckoutCleanupResult> {
    if (
      !identity ||
      identity.path !== checkoutPath ||
      path.dirname(identity.quarantinePath) !== path.dirname(checkoutPath) ||
      identity.quarantinePath === checkoutPath
    ) {
      return {
        removed: false,
        error: 'The persisted residual-checkout quarantine is invalid'
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
        (error) => error
      )
      if (renameError) {
        if (
          // SAFETY: The surrounding boundary contract establishes this asserted value.
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
              (error) => error
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
        (error) => error
      )
    if (removalError || (await this.checkoutStat(quarantinePath))) {
      if (!(await this.checkoutStat(checkoutPath))) {
        const restoreError = await fs.rename(quarantinePath, checkoutPath).then(
          () => null,
          (error) => error
        )
        if (!restoreError) {
          return {
            removed: false,
            error: `Automatic residual-checkout cleanup failed: ${
              removalError instanceof Error
                ? removalError.message
                : 'the quarantined checkout root still exists'
            }`
          }
        }
      }

      return {
        removed: false,
        error: `Automatic residual-checkout cleanup failed; the checkout was preserved at ${quarantinePath}`
      }
    }

    if (await this.checkoutStat(checkoutPath)) {
      return {
        removed: false,
        error:
          'The residual checkout path was recreated during automatic cleanup'
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

  async listRecentProjects(): Promise<RecentProjectRecord[]> {
    return this.deps.database.db
      .select({
        id: projects.id,
        name: projects.name,
        kind: projects.kind,
        rootPath: projects.repositoryPath,
        repositoryPath: projects.repositoryPath,
        lastOpenedAt: projects.lastOpenedAt
      })
      .from(projects)
      .where(and(eq(projects.isOpen, 0), eq(projects.showInRecents, 1)))
      .orderBy(desc(projects.lastOpenedAt), asc(projects.id))
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
      (await this.storedProjects(true)).map(async (storedProject) => {
        let project = storedProject
        try {
          if (project.kind === 'repository') {
            await this.importWorktrees(
              project.id,
              project.repositoryPath,
              project.mainWorktreePath
            )
          } else {
            project = await this.observeAvailableProject(project)
          }

          await this.ensureProjectTerminals(project.id)
          project = (await this.storedProject(project.id)) ?? project
        } catch (error) {
          project.availability = {
            state: 'unavailable',
            message: error instanceof Error ? error.message : String(error)
          }
        }

        if ((await this.projectOpenState(project.id)) !== true) {
          return null
        }

        await Promise.all(
          project.worktrees.map(async (worktree) => {
            const [dirty, terminals] = await Promise.all([
              project.kind === 'repository' &&
              project.availability.state === 'available' &&
              !worktree.prunable
                ? this.deps.git.dirtyState(worktree.path).catch(() => null)
                : null,
              this.listWorktreeTerminals(worktree).catch((error) => {
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
            const [storedBrowserPanels, storedWebPanels] = await Promise.all([
              this.deps.database.db
                .select()
                .from(browserPanels)
                .where(eq(browserPanels.worktreeId, worktree.id))
                .orderBy(asc(browserPanels.createdAt), asc(browserPanels.id)),
              this.deps.database.db
                .select()
                .from(webPanels)
                .where(eq(webPanels.worktreeId, worktree.id))
                .orderBy(asc(webPanels.createdAt), asc(webPanels.id))
            ])
            const definitions =
              project.availability.state === 'available' &&
              storedWebPanels.length > 0
                ? await this.listWebPanelDefinitions(worktree.id).catch(
                    () => []
                  )
                : []
            const definitionsById = new Map(
              definitions.map((definition) => [definition.id, definition])
            )
            worktree.panels = [
              ...terminals.map((terminal) => ({
                id: `panel_${terminal.id}`,
                kind: 'terminal' as const,
                worktreeId: worktree.id,
                terminalId: terminal.id,
                title: terminal.name,
                createdAt: terminal.createdAt,
                updatedAt: terminal.updatedAt
              })),
              ...storedBrowserPanels.map(mapBrowserPanel),
              ...storedWebPanels.map((panel) => {
                const definition = definitionsById.get(panel.definitionId)
                return mapWebPanel(
                  panel,
                  definition?.permissions ?? [],
                  definition?.permissionsGranted ?? false
                )
              })
            ].sort(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) ||
                left.id.localeCompare(right.id)
            )
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
      await this.deps.terminalHost.listTerminals(worktree.id)
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
      throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
    }

    return worktree
  }

  private async requireAvailableWorktree(
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

  private async requireOpenProject(projectId: string): Promise<ProjectRecord> {
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

  async listPackages(): Promise<{
    packages: PackageListing[]
    diagnostics: PackageResourceDiagnostic[]
  }> {
    this.packages.syncProjects(await this.storedProjects())
    return this.packages.list()
  }

  private async packageResourcesChanged(projectId?: string): Promise<void> {
    this.invalidateProjectsSnapshot()
    const projects = projectId
      ? [await this.getProject(projectId)]
      : await this.storedProjects(true)
    for (const project of projects) {
      this.events.publish('project.updated', { projectId: project.id })
    }
  }

  async installPackage(
    source: string,
    projectId?: string
  ): Promise<PackageOperationResult> {
    if (projectId) {
      this.packages.syncProjects([await this.getProject(projectId)])
    }

    const result = await this.packages.install(source, projectId)
    await this.webPanelRuntime.disposeDevelopmentServers()
    await this.packageResourcesChanged(projectId)
    return result
  }

  async removePackage(
    source: string,
    projectId?: string
  ): Promise<PackageOperationResult> {
    if (projectId) {
      this.packages.syncProjects([await this.getProject(projectId)])
    }

    const registeredProjects = projectId
      ? [await this.getProject(projectId)]
      : await this.storedProjects()
    const collectPermissionSourceKeys = async () => {
      const keys = new Set<string>()
      for (const project of registeredProjects) {
        const worktree = project.worktrees[0]
        if (!worktree) {
          continue
        }

        const definitions = await this.effectiveWebPanelDefinitions(
          worktree.id
        ).catch(() => [])
        for (const definition of definitions) {
          if (definition.permissions.length > 0) {
            keys.add(
              await this.webPanelPermissionSourceKey(worktree.id, definition)
            )
          }
        }
      }
      return keys
    }
    const before = await collectPermissionSourceKeys()
    const result = await this.packages.remove(source, projectId)
    const after = await collectPermissionSourceKeys()
    for (const sourceKey of before) {
      if (!after.has(sourceKey)) {
        await this.deps.database.db
          .delete(webPanelPermissionGrants)
          .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
      }
    }
    await this.webPanelRuntime.disposeDevelopmentServers()
    await this.packageResourcesChanged(projectId)
    return result
  }

  async updatePackages(source?: string): Promise<PackageOperationResult[]> {
    this.packages.syncProjects(await this.storedProjects())
    const results = await this.packages.update(source)
    await this.webPanelRuntime.disposeDevelopmentServers()
    await this.packageResourcesChanged()
    return results
  }

  async reloadPackages(projectId?: string): Promise<{
    results: PackageOperationResult[]
    diagnostics: PackageResourceDiagnostic[]
  }> {
    this.packages.syncProjects(await this.storedProjects())
    if (projectId) {
      await this.getProject(projectId)
    }

    const result = await this.packages.reload(projectId)
    await this.webPanelRuntime.disposeDevelopmentServers()
    await this.packageResourcesChanged(projectId)
    return result
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

  async listTreeContextFields(
    projectId: string
  ): Promise<TreeContextFieldListing> {
    const project = await this.getProject(projectId)
    return loadTreeContextFields({
      dataDir: this.deps.config.dataDir,
      projectRoot: project.rootPath
    })
  }

  async listTerminalPresets(): Promise<TerminalPreset[]> {
    const rows = await this.deps.database.db
      .select()
      .from(terminalPresets)
      .orderBy(asc(terminalPresets.createdAt), asc(terminalPresets.id))
    return rows.map(mapTerminalPreset)
  }

  async listTerminalPresetDefinitions(context?: {
    projectId?: string | undefined
    worktreeId?: string | undefined
  }): Promise<TerminalPresetDefinitionListing> {
    const worktree = context?.worktreeId
      ? await this.getWorktree(context.worktreeId)
      : null
    const projectId = worktree?.projectId ?? context?.projectId
    const project = projectId ? await this.getProject(projectId) : null
    if (project) {
      this.packages.syncProjects([project])
    }

    const [userPresets, packagePresets, repositoryPresets, zedPresets] =
      await Promise.all([
        this.listTerminalPresets(),
        this.packages.terminalPresetDefinitions(projectId),
        worktree && project
          ? loadRepositoryTerminalPresets(project.id, worktree.path)
          : Promise.resolve({ definitions: [], diagnostics: [] }),
        worktree && project?.kind === 'repository'
          ? loadZedTerminalPresetDefinitions({
              projectId: project.id,
              shell: this.deps.config.shell,
              mainWorktreePath: project.mainWorktreePath,
              worktreePath: worktree.path
            })
          : Promise.resolve({ definitions: [], diagnostics: [] })
      ])
    const repositoryPackagePresets = packagePresets.filter(
      (preset) =>
        preset.source.type === 'package' && preset.source.scope === 'project'
    )
    const globalPackagePresets = packagePresets.filter(
      (preset) =>
        preset.source.type === 'package' && preset.source.scope === 'global'
    )

    return {
      definitions: [
        ...repositoryPresets.definitions,
        ...zedPresets.definitions,
        ...repositoryPackagePresets,
        ...userPresets.map((preset) => ({
          id: preset.id,
          name: preset.name,
          executable: preset.executable,
          args: [...preset.args],
          shellCommand: null,
          cwd: null,
          env: {},
          closeOnSuccess: preset.closeOnSuccess,
          source: { type: 'user' as const }
        })),
        ...globalPackagePresets
      ],
      diagnostics: [...repositoryPresets.diagnostics, ...zedPresets.diagnostics]
    }
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
    await this.deps.database.db.insert(terminalPresets).values({
      id: preset.id,
      name: preset.name,
      executable: preset.executable,
      argsJson: JSON.stringify(preset.args),
      closeOnSuccess: Number(preset.closeOnSuccess),
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt
    })
    return preset
  }

  async updateTerminalPreset(
    presetId: string,
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'> & {
      closeOnSuccess?: boolean | undefined
    },
    expectedUpdatedAt: string
  ): Promise<TerminalPreset> {
    const [existingRow] = await this.deps.database.db
      .select()
      .from(terminalPresets)
      .where(eq(terminalPresets.id, presetId))
      .limit(1)
    if (!existingRow) {
      throw new DomainError(
        'TERMINAL_PRESET_NOT_FOUND',
        'Terminal preset not found',
        404
      )
    }

    const existing = mapTerminalPreset(existingRow)
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
    const result = await this.deps.database.db
      .update(terminalPresets)
      .set({
        name: preset.name,
        executable: preset.executable,
        argsJson: JSON.stringify(preset.args),
        closeOnSuccess: Number(preset.closeOnSuccess),
        updatedAt: preset.updatedAt
      })
      .where(
        and(
          eq(terminalPresets.id, preset.id),
          eq(terminalPresets.updatedAt, expectedUpdatedAt)
        )
      )
    if (result.rowsAffected === 0) {
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
    const [existing] = await this.deps.database.db
      .select({ updatedAt: terminalPresets.updatedAt })
      .from(terminalPresets)
      .where(eq(terminalPresets.id, presetId))
      .limit(1)
    if (!existing) {
      throw new DomainError(
        'TERMINAL_PRESET_NOT_FOUND',
        'Terminal preset not found',
        404
      )
    }

    const result = await this.deps.database.db
      .delete(terminalPresets)
      .where(
        and(
          eq(terminalPresets.id, presetId),
          eq(terminalPresets.updatedAt, expectedUpdatedAt)
        )
      )
    if (existing.updatedAt !== expectedUpdatedAt || result.rowsAffected === 0) {
      throw new DomainError(
        'TERMINAL_PRESET_CHANGED',
        'Terminal preset changed; review the latest values and try again',
        409
      )
    }
  }

  private async localWebPanelDefinitions(
    worktreeId: string
  ): Promise<Array<WebPanelDefinition & ResolvedWebPanelSource>> {
    const worktree = await this.getWorktree(worktreeId)
    const webPanelsRoot = path.join(worktree.path, '.treeport', 'web-panels')
    const directories = await fs
      .readdir(webPanelsRoot, { withFileTypes: true })
      .catch((error) => {
        // SAFETY: The surrounding boundary contract establishes this asserted value.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return []
        }

        throw error
      })
    const definitions: Array<WebPanelDefinition & ResolvedWebPanelSource> = []
    for (const directory of directories.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (!directory.isDirectory()) {
        continue
      }

      const root = path.join(webPanelsRoot, directory.name)
      const entry = 'index.html'
      const entryIsFile = await fs
        .stat(path.join(root, entry))
        .then((value) => value.isFile())
        .catch(() => false)
      if (!entryIsFile) {
        continue
      }

      const words = directory.name
        .split(/[-_.]+/)
        .filter(Boolean)
        .join(' ')
      definitions.push({
        id: `project:${encodeURIComponent(directory.name)}`,
        title: words
          ? `${words[0]!.toLocaleUpperCase()}${words.slice(1)}`
          : directory.name,
        source: { type: 'project' },
        permissions: [],
        permissionsGranted: true,
        sandbox: { allowSameOrigin: false },
        root,
        entry,
        packageRoot: worktree.path,
        development: true,
        definitionId: `project:${encodeURIComponent(directory.name)}`,
        allowNetworkRequests: false
      })
    }
    return definitions
  }

  private async effectiveWebPanelDefinitions(
    worktreeId: string
  ): Promise<Array<WebPanelDefinition & ResolvedWebPanelSource>> {
    const worktree = await this.getWorktree(worktreeId)
    this.packages.syncProjects([await this.getProject(worktree.projectId)])
    return [
      ...(await this.localWebPanelDefinitions(worktreeId)),
      ...(await this.packages.webPanelDefinitions(worktree.projectId)).map(
        ({
          definition,
          root,
          entry,
          packageRoot,
          development,
          packageLockPath
        }) => {
          const resolved: WebPanelDefinition & ResolvedWebPanelSource = {
            ...definition,
            root,
            entry,
            packageRoot,
            development,
            definitionId: definition.id,
            allowNetworkRequests: definition.sandbox.allowSameOrigin
          }
          if (packageLockPath) {
            resolved.packageLockPath = packageLockPath
          }

          if (definition.source.type === 'package') {
            resolved.packageSource = definition.source.source
          }

          return resolved
        }
      )
    ]
  }

  private async webPanelPermissionSourceKey(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Promise<string> {
    const worktree = await this.getWorktree(worktreeId)
    const source =
      definition.source.type === 'project'
        ? {
            type: 'project',
            projectId: worktree.projectId,
            definitionId: definition.id
          }
        : {
            type: 'package',
            scope: definition.source.scope,
            projectId:
              definition.source.scope === 'project' ? worktree.projectId : null,
            packageId: definition.source.packageId,
            source: definition.source.source,
            definitionId: definition.id
          }
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(source))
      .digest('hex')
  }

  private async webPanelPermissionsGranted(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Promise<boolean> {
    const sourceKey = await this.webPanelPermissionSourceKey(
      worktreeId,
      definition
    )
    const [grant] = await this.deps.database.db
      .select({ permissionsJson: webPanelPermissionGrants.permissionsJson })
      .from(webPanelPermissionGrants)
      .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
      .limit(1)
    if (definition.permissions.length === 0) {
      if (grant) {
        await this.deps.database.db
          .delete(webPanelPermissionGrants)
          .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
      }

      return true
    }

    const matches =
      grant?.permissionsJson ===
      JSON.stringify([...definition.permissions].sort())
    if (grant && !matches) {
      await this.deps.database.db
        .delete(webPanelPermissionGrants)
        .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
    }

    return matches
  }

  async listWebPanelDefinitions(
    worktreeId: string
  ): Promise<WebPanelDefinition[]> {
    const definitions = await this.effectiveWebPanelDefinitions(worktreeId)
    return Promise.all(
      definitions.map(
        async ({
          root: _root,
          entry: _entry,
          packageRoot: _packageRoot,
          development: _development,
          packageLockPath: _packageLockPath,
          definitionId: _definitionId,
          packageSource: _packageSource,
          allowNetworkRequests: _allowNetworkRequests,
          ...definition
        }) => ({
          ...definition,
          permissionsGranted: await this.webPanelPermissionsGranted(
            worktreeId,
            definition
          )
        })
      )
    )
  }

  async setWebPanelPermissionGrant(
    worktreeId: string,
    definitionId: string,
    granted: boolean,
    expectedPermissions: WebPanelPermission[]
  ): Promise<WebPanelDefinition> {
    await this.requireAvailableWorktree(worktreeId)
    const definition = (
      await this.effectiveWebPanelDefinitions(worktreeId)
    ).find((candidate) => candidate.id === definitionId)
    if (!definition) {
      throw new DomainError(
        'WEB_PANEL_DEFINITION_NOT_FOUND',
        'Web panel definition not found',
        404
      )
    }

    if (
      JSON.stringify([...definition.permissions].sort()) !==
      JSON.stringify([...expectedPermissions].sort())
    ) {
      throw new DomainError(
        'WEB_PANEL_PERMISSIONS_CHANGED',
        'Web panel permissions changed; review them and try again',
        409,
        { permissions: definition.permissions }
      )
    }

    const sourceKey = await this.webPanelPermissionSourceKey(
      worktreeId,
      definition
    )
    if (granted && definition.permissions.length > 0) {
      const timestamp = now()
      await this.deps.database.db
        .insert(webPanelPermissionGrants)
        .values({
          sourceKey,
          definitionId,
          permissionsJson: JSON.stringify([...definition.permissions].sort()),
          grantedAt: timestamp,
          updatedAt: timestamp
        })
        .onConflictDoUpdate({
          target: webPanelPermissionGrants.sourceKey,
          set: {
            permissionsJson: JSON.stringify([...definition.permissions].sort()),
            updatedAt: timestamp
          }
        })
    } else {
      await this.deps.database.db
        .delete(webPanelPermissionGrants)
        .where(eq(webPanelPermissionGrants.sourceKey, sourceKey))
    }

    const affectedPanels = await this.deps.database.db
      .select({ id: webPanels.id })
      .from(webPanels)
      .where(
        and(
          eq(webPanels.worktreeId, worktreeId),
          eq(webPanels.definitionId, definitionId)
        )
      )
    this.invalidateProjectsSnapshot()
    for (const panel of affectedPanels) {
      this.events.publish('panel.updated', {
        worktreeId,
        panelId: panel.id
      })
    }

    return {
      id: definition.id,
      title: definition.title,
      source: definition.source,
      permissions: definition.permissions,
      permissionsGranted: definition.permissions.length === 0 ? true : granted,
      sandbox: definition.sandbox
    }
  }

  private async requireWebPanelPermissions(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Promise<void> {
    if (await this.webPanelPermissionsGranted(worktreeId, definition)) {
      return
    }

    throw new DomainError(
      'WEB_PANEL_PERMISSION_REQUIRED',
      `Permission is required before ${definition.title} can open`,
      403,
      {
        definitionId: definition.id,
        permissions: definition.permissions
      }
    )
  }

  private async normalizeWebPanelLaunch(
    worktree: WorktreeRecord,
    launch: WebPanelLaunch
  ): Promise<{ launch: WebPanelLaunch; inputJson: string }> {
    const inputJson = JSON.stringify(launch.input)
    if (Buffer.byteLength(inputJson) > WEB_PANEL_INPUT_MAX_BYTES) {
      throw new DomainError(
        'WEB_PANEL_INPUT_TOO_LARGE',
        'Web panel input is limited to 64 KiB',
        413
      )
    }

    if (launch.cwd === null) {
      return { launch: { input: launch.input, cwd: null }, inputJson }
    }

    const [worktreeRoot, requestedCwd] = await Promise.all([
      fs.realpath(worktree.path),
      fs.realpath(path.resolve(worktree.path, launch.cwd)).catch(() => null)
    ])
    if (!requestedCwd || !(await fs.stat(requestedCwd)).isDirectory()) {
      throw new DomainError(
        'INVALID_WEB_PANEL_LAUNCH_CWD',
        'Web panel launch directory does not exist',
        400
      )
    }

    const relativeCwd = path.relative(worktreeRoot, requestedCwd)
    if (
      relativeCwd === '..' ||
      relativeCwd.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeCwd)
    ) {
      throw new DomainError(
        'INVALID_WEB_PANEL_LAUNCH_CWD',
        'Web panel launch directory must be inside the tree',
        400
      )
    }

    return {
      launch: { input: launch.input, cwd: relativeCwd || '.' },
      inputJson
    }
  }

  async createBrowserPanel(
    worktreeId: string,
    requestedUrl?: string
  ): Promise<BrowserPanel> {
    await this.requireAvailableWorktree(worktreeId)
    const parsedUrl = requestedUrl
      ? browserUrlSchema.safeParse(requestedUrl)
      : null
    if (parsedUrl && !parsedUrl.success) {
      throw new DomainError(
        'INVALID_BROWSER_URL',
        'Enter an absolute HTTP or HTTPS URL without credentials',
        400
      )
    }

    const url = parsedUrl ? new URL(parsedUrl.data).href : 'about:blank'
    const timestamp = now()
    const panel: BrowserPanel = {
      id: id('panel'),
      kind: 'browser',
      worktreeId,
      title: url === 'about:blank' ? 'Browser' : new URL(url).host,
      url,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await this.deps.database.db.insert(browserPanels).values({
      id: panel.id,
      worktreeId: panel.worktreeId,
      title: panel.title,
      url: panel.url,
      createdAt: panel.createdAt,
      updatedAt: panel.updatedAt
    })
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.created', { worktreeId, panelId: panel.id })
    return panel
  }

  async openBrowserPanel(
    worktreeId: string | null,
    requestedUrl?: string,
    sourceTerminalId: string | null = null,
    sourcePanelId: string | null = null
  ): Promise<OpenBrowserPanelResult> {
    if (sourceTerminalId) {
      const terminal = await this.getTerminalFromBindings(sourceTerminalId)
      if (worktreeId && terminal.worktreeId !== worktreeId) {
        throw new DomainError(
          'INVALID_PANEL_OPEN_SOURCE',
          'The source terminal does not belong to the target tree',
          400
        )
      }

      worktreeId ??= terminal.worktreeId
    }

    if (sourcePanelId) {
      const sourcePanel = await this.getBrowserPanel(sourcePanelId)
      if (worktreeId && sourcePanel.worktreeId !== worktreeId) {
        throw new DomainError(
          'INVALID_PANEL_OPEN_SOURCE',
          'The source Browser does not belong to the target tree',
          400
        )
      }

      worktreeId ??= sourcePanel.worktreeId
    }

    if (!worktreeId) {
      throw new DomainError(
        'INVALID_PANEL_OPEN_SOURCE',
        'A target tree or panel source is required',
        400
      )
    }

    const panel = await this.createBrowserPanel(worktreeId, requestedUrl)
    this.events.publish('panel.open_requested', {
      worktreeId,
      panelId: panel.id,
      panel,
      sourceTerminalId,
      sourcePanelId
    })
    return { panel }
  }

  async openBrowserPanelFromTerminal(
    terminalId: string,
    requestedUrl: string
  ): Promise<OpenBrowserPanelResult> {
    return this.openBrowserPanel(null, requestedUrl, terminalId, null)
  }

  async openBrowserPanelFromPanel(
    panelId: string,
    requestedUrl: string
  ): Promise<OpenBrowserPanelResult> {
    return this.openBrowserPanel(null, requestedUrl, null, panelId)
  }

  async getBrowserPanel(panelId: string): Promise<BrowserPanel> {
    const [row] = await this.deps.database.db
      .select()
      .from(browserPanels)
      .where(eq(browserPanels.id, panelId))
      .limit(1)
    if (!row) {
      throw new DomainError('PANEL_NOT_FOUND', 'Browser not found', 404)
    }

    await this.requireAvailableWorktree(row.worktreeId)
    return mapBrowserPanel(row)
  }

  async authorizeBrowserPanel(panelId: string): Promise<{
    panel: BrowserPanel
    worktreePath: string
  }> {
    const panel = await this.getBrowserPanel(panelId)
    const worktree = await this.getWorktree(panel.worktreeId)
    return { panel, worktreePath: worktree.path }
  }

  async updateBrowserPanelState(
    panelId: string,
    state: { url: string; title: string }
  ): Promise<BrowserPanel> {
    const panel = await this.getBrowserPanel(panelId)
    const parsedUrl =
      state.url === 'about:blank'
        ? { success: true as const, data: 'about:blank' }
        : browserUrlSchema.safeParse(state.url)
    if (!parsedUrl.success) {
      throw new DomainError(
        'INVALID_BROWSER_URL',
        'The hosted browser reported an unsupported URL',
        400
      )
    }

    const url =
      parsedUrl.data === 'about:blank'
        ? parsedUrl.data
        : new URL(parsedUrl.data).href
    const requestedTitle = state.title.trim().slice(0, 256)
    const title =
      requestedTitle ||
      (url === 'about:blank' ? 'Browser' : new URL(url).host || 'Browser')
    if (panel.url === url && panel.title === title) {
      return panel
    }

    const observedAt = now()
    const updatedAt =
      observedAt > panel.updatedAt
        ? observedAt
        : new Date(Date.parse(panel.updatedAt) + 1).toISOString()
    await this.deps.database.db
      .update(browserPanels)
      .set({ url, title, updatedAt })
      .where(eq(browserPanels.id, panelId))
    const updated = { ...panel, url, title, updatedAt }
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.updated', {
      worktreeId: panel.worktreeId,
      panelId
    })
    return updated
  }

  async deleteBrowserPanel(panelId: string): Promise<void> {
    const [row] = await this.deps.database.db
      .select()
      .from(browserPanels)
      .where(eq(browserPanels.id, panelId))
      .limit(1)
    if (!row) {
      throw new DomainError('PANEL_NOT_FOUND', 'Browser not found', 404)
    }

    await this.deps.database.db
      .delete(browserPanels)
      .where(eq(browserPanels.id, panelId))
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.removed', {
      worktreeId: row.worktreeId,
      panelId
    })
  }

  async deletePanel(panelId: string, discardStoredData = false): Promise<void> {
    const [browserPanel] = await this.deps.database.db
      .select({ id: browserPanels.id })
      .from(browserPanels)
      .where(eq(browserPanels.id, panelId))
      .limit(1)
    if (browserPanel) {
      return this.deleteBrowserPanel(panelId)
    }

    return this.deleteWebPanel(panelId, discardStoredData)
  }

  async createWebPanel(
    worktreeId: string,
    definitionId: string,
    launch: WebPanelLaunch = { input: null, cwd: null }
  ): Promise<WebPanel> {
    const worktree = await this.requireAvailableWorktree(worktreeId)
    const definition = (
      await this.effectiveWebPanelDefinitions(worktreeId)
    ).find((candidate) => candidate.id === definitionId)
    if (!definition) {
      throw new DomainError(
        'WEB_PANEL_DEFINITION_NOT_FOUND',
        'Web panel definition not found',
        404
      )
    }

    await this.requireWebPanelPermissions(worktreeId, definition)
    const normalized = await this.normalizeWebPanelLaunch(worktree, launch)
    const timestamp = now()
    const panel: WebPanel = {
      id: id('panel'),
      kind: 'web',
      worktreeId,
      definitionId,
      title: definition.title,
      launch: normalized.launch,
      permissions: definition.permissions,
      sandbox: definition.sandbox,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await this.deps.database.db.insert(webPanels).values({
      id: panel.id,
      worktreeId: panel.worktreeId,
      definitionId: panel.definitionId,
      title: panel.title,
      inputJson: normalized.inputJson,
      launchCwd: panel.launch.cwd,
      createdAt: panel.createdAt,
      updatedAt: panel.updatedAt
    })
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.created', { worktreeId, panelId: panel.id })
    return panel
  }

  async openWebPanel(
    worktreeId: string,
    definitionId: string,
    launch: WebPanelLaunch = { input: null, cwd: null },
    newInstance = false,
    sourceTerminalId: string | null = null
  ): Promise<OpenWebPanelResult> {
    const worktree = await this.requireAvailableWorktree(worktreeId)
    const definition = (
      await this.effectiveWebPanelDefinitions(worktreeId)
    ).find((candidate) => candidate.id === definitionId)
    if (!definition) {
      throw new DomainError(
        'WEB_PANEL_DEFINITION_NOT_FOUND',
        'Web panel definition not found',
        404
      )
    }

    await this.requireWebPanelPermissions(worktreeId, definition)
    const finish = (result: OpenWebPanelResult): OpenWebPanelResult => {
      this.events.publish('panel.open_requested', {
        worktreeId,
        panelId: result.panel.id,
        panel: result.panel,
        sourceTerminalId,
        sourcePanelId: null
      })
      return result
    }

    if (newInstance) {
      return finish({
        panel: await this.createWebPanel(worktreeId, definitionId, launch),
        created: true,
        reused: false
      })
    }

    const [existing] = await this.deps.database.db
      .select()
      .from(webPanels)
      .where(
        and(
          eq(webPanels.worktreeId, worktreeId),
          eq(webPanels.definitionId, definitionId)
        )
      )
      .orderBy(desc(webPanels.createdAt), desc(webPanels.id))
      .limit(1)
    if (!existing) {
      return finish({
        panel: await this.createWebPanel(worktreeId, definitionId, launch),
        created: true,
        reused: false
      })
    }

    const normalized = await this.normalizeWebPanelLaunch(worktree, launch)
    const observedAt = now()
    const updatedAt =
      observedAt > existing.updatedAt
        ? observedAt
        : new Date(Date.parse(existing.updatedAt) + 1).toISOString()
    await this.deps.database.db
      .update(webPanels)
      .set({
        title: definition.title,
        inputJson: normalized.inputJson,
        launchCwd: normalized.launch.cwd,
        updatedAt
      })
      .where(eq(webPanels.id, existing.id))
    const panel = mapWebPanel(
      {
        ...existing,
        title: definition.title,
        inputJson: normalized.inputJson,
        launchCwd: normalized.launch.cwd,
        updatedAt
      },
      definition.permissions,
      true
    )
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.updated', { worktreeId, panelId: panel.id })
    return finish({ panel, created: false, reused: true })
  }

  async deleteWebPanel(
    panelId: string,
    discardStoredData = false
  ): Promise<void> {
    const [panel] = await this.deps.database.db
      .select()
      .from(webPanels)
      .where(eq(webPanels.id, panelId))
      .limit(1)
    if (!panel) {
      throw new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
    }

    await this.requireAvailableWorktree(panel.worktreeId)
    const [storedValue] = await this.deps.database.db
      .select({ key: webPanelStorage.key })
      .from(webPanelStorage)
      .where(eq(webPanelStorage.panelId, panelId))
      .limit(1)
    if (!discardStoredData && storedValue) {
      throw new DomainError(
        'PANEL_HAS_STORED_DATA',
        'Closing this panel requires confirmation because its saved data will be deleted',
        409
      )
    }

    await this.deps.database.db
      .delete(webPanels)
      .where(eq(webPanels.id, panelId))
    this.invalidateProjectsSnapshot()
    this.events.publish('panel.removed', {
      worktreeId: panel.worktreeId,
      panelId
    })
  }

  private async requireWebPanelTreeFiles(panelId: string) {
    const [panel] = await this.deps.database.db
      .select()
      .from(webPanels)
      .where(eq(webPanels.id, panelId))
      .limit(1)
    if (!panel) {
      throw new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
    }

    const definition = (
      await this.effectiveWebPanelDefinitions(panel.worktreeId)
    ).find((candidate) => candidate.id === panel.definitionId)
    if (!definition) {
      throw new DomainError(
        'WEB_PANEL_DEFINITION_NOT_FOUND',
        'The definition for this panel is unavailable',
        404
      )
    }

    await this.requireWebPanelPermissions(panel.worktreeId, definition)
    if (!definition.permissions.includes('tree-files')) {
      throw new DomainError(
        'WEB_PANEL_TREE_FILES_REQUIRED',
        'This panel does not have permission to access tree files',
        403
      )
    }

    const worktree = await this.requireAvailableWorktree(panel.worktreeId)
    const project = await this.getProject(worktree.projectId)
    return { project, worktree }
  }

  private async resolveTreeFile(worktreePath: string, requestedPath: string) {
    if (!treeFilePathSchema.safeParse(requestedPath).success) {
      throw new DomainError(
        'INVALID_TREE_FILE_PATH',
        'File path must be a relative path inside the tree',
        400
      )
    }

    const root = await fs.realpath(worktreePath)
    const candidate = path.resolve(root, requestedPath)
    if (!isPathWithin(candidate, root)) {
      throw new DomainError(
        'INVALID_TREE_FILE_PATH',
        'File path must stay inside the tree',
        400
      )
    }

    const canonicalPath = await fs.realpath(candidate).catch((error) => {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return null
      }

      throw error
    })
    if (!canonicalPath) {
      throw new DomainError(
        'TREE_FILE_NOT_FOUND',
        'The selected file does not exist',
        404
      )
    }

    if (!isPathWithin(canonicalPath, root)) {
      throw new DomainError(
        'INVALID_TREE_FILE_PATH',
        'File path must stay inside the tree',
        400
      )
    }

    const stat = await fs.lstat(candidate)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new DomainError(
        'TREE_FILE_UNSUPPORTED',
        'Only existing regular files can be edited',
        415
      )
    }

    return {
      canonicalPath,
      path: path.relative(root, canonicalPath).split(path.sep).join('/')
    }
  }

  private async readTreeFileHandle(
    handle: Awaited<ReturnType<typeof fs.open>>
  ) {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new DomainError(
        'TREE_FILE_UNSUPPORTED',
        'Only existing regular files can be edited',
        415
      )
    }

    if (stat.size > TREE_FILE_MAX_BYTES) {
      throw new DomainError(
        'TREE_FILE_TOO_LARGE',
        'Files larger than 2 MiB cannot be edited',
        413
      )
    }

    const buffer = Buffer.alloc(TREE_FILE_MAX_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead
      )
      if (read.bytesRead === 0) {
        break
      }

      bytesRead += read.bytesRead
    }
    if (bytesRead > TREE_FILE_MAX_BYTES) {
      throw new DomainError(
        'TREE_FILE_TOO_LARGE',
        'Files larger than 2 MiB cannot be edited',
        413
      )
    }

    const bytes = buffer.subarray(0, bytesRead)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new DomainError(
        'TREE_FILE_UNSUPPORTED',
        'Only UTF-8 text files can be edited',
        415
      )
    }
    if (content.includes('\0')) {
      throw new DomainError(
        'TREE_FILE_UNSUPPORTED',
        'Only UTF-8 text files can be edited',
        415
      )
    }

    return { bytes, content }
  }

  async listTreeFiles(panelId: string): Promise<TreeFileListing> {
    const { project, worktree } = await this.requireWebPanelTreeFiles(panelId)
    const root = await fs.realpath(worktree.path)
    const paths: string[] = []
    if (project.kind === 'repository') {
      const candidates = await this.deps.git.worktreeFiles(root)
      for (const relativePath of candidates) {
        if (paths.length > TREE_FILE_LIST_MAX_ENTRIES) {
          break
        }

        const candidate = path.resolve(root, relativePath)
        if (!isPathWithin(candidate, root)) {
          continue
        }

        const [canonicalPath, stat] = await Promise.all([
          fs.realpath(candidate).catch(() => null),
          fs.lstat(candidate).catch(() => null)
        ])
        if (
          canonicalPath &&
          isPathWithin(canonicalPath, root) &&
          stat?.isFile() &&
          !stat.isSymbolicLink()
        ) {
          paths.push(relativePath.split(path.sep).join('/'))
        }
      }
    } else {
      const directories = ['']
      while (
        directories.length > 0 &&
        paths.length <= TREE_FILE_LIST_MAX_ENTRIES
      ) {
        const relativeDirectory = directories.pop()!
        const entries = await fs
          .readdir(path.join(root, relativeDirectory), { withFileTypes: true })
          .then((values) =>
            values.sort((left, right) => right.name.localeCompare(left.name))
          )
        for (const entry of entries) {
          if (entry.name === '.git' && entry.isDirectory()) {
            continue
          }

          const relativePath = path.join(relativeDirectory, entry.name)
          if (entry.isDirectory()) {
            directories.push(relativePath)
          } else if (entry.isFile()) {
            paths.push(relativePath.split(path.sep).join('/'))
            if (paths.length > TREE_FILE_LIST_MAX_ENTRIES) {
              break
            }
          }
        }
      }
    }

    paths.sort()
    return {
      paths: paths.slice(0, TREE_FILE_LIST_MAX_ENTRIES),
      truncated: paths.length > TREE_FILE_LIST_MAX_ENTRIES
    }
  }

  async readTreeFile(
    panelId: string,
    requestedPath: string
  ): Promise<TreeFile> {
    const { worktree } = await this.requireWebPanelTreeFiles(panelId)
    const resolved = await this.resolveTreeFile(worktree.path, requestedPath)
    const handle = await fs
      .open(
        resolved.canonicalPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      )
      .catch((error) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          throw new DomainError(
            'TREE_FILE_NOT_FOUND',
            'The selected file does not exist',
            404
          )
        }

        throw error
      })
    try {
      const { bytes, content } = await this.readTreeFileHandle(handle)
      return {
        path: resolved.path,
        content,
        revision: crypto.createHash('sha256').update(bytes).digest('hex')
      }
    } finally {
      await handle.close()
    }
  }

  async writeTreeFile(
    panelId: string,
    input: TreeFileWrite
  ): Promise<TreeFileWriteResult> {
    const { worktree } = await this.requireWebPanelTreeFiles(panelId)
    const content = Buffer.from(input.content, 'utf8')

    if (content.length > TREE_FILE_MAX_BYTES) {
      throw new DomainError(
        'TREE_FILE_TOO_LARGE',
        'Files larger than 2 MiB cannot be edited',
        413
      )
    }

    if (input.content.includes('\0')) {
      throw new DomainError(
        'TREE_FILE_UNSUPPORTED',
        'Only UTF-8 text files can be edited',
        415
      )
    }

    const resolved = await this.resolveTreeFile(worktree.path, input.path)
    return this.treeFileMutations.enqueue(resolved.canonicalPath, async () => {
      const handle = await fs.open(
        resolved.canonicalPath,
        fsConstants.O_RDWR | fsConstants.O_NOFOLLOW
      )
      try {
        const current = await this.readTreeFileHandle(handle)
        const currentRevision = crypto
          .createHash('sha256')
          .update(current.bytes)
          .digest('hex')
        if (currentRevision !== input.expectedRevision) {
          throw new DomainError(
            'TREE_FILE_CHANGED',
            'The file changed after it was opened. Reload it before saving.',
            409
          )
        }

        let offset = 0
        while (offset < content.length) {
          const write = await handle.write(
            content,
            offset,
            content.length - offset,
            offset
          )
          if (write.bytesWritten === 0) {
            throw new Error('Could not write tree file')
          }

          offset += write.bytesWritten
        }
        await handle.truncate(content.length)
        await handle.sync()
        return {
          path: resolved.path,
          revision: crypto.createHash('sha256').update(content).digest('hex')
        }
      } finally {
        await handle.close()
      }
    })
  }

  async getWebPanelContext(panelId: string): Promise<WebPanelContext> {
    const [panelRow] = await this.deps.database.db
      .select()
      .from(webPanels)
      .where(eq(webPanels.id, panelId))
      .limit(1)
    if (!panelRow) {
      throw new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
    }

    const definition = (
      await this.effectiveWebPanelDefinitions(panelRow.worktreeId)
    ).find((candidate) => candidate.id === panelRow.definitionId)
    const permissionsGranted = definition
      ? await this.webPanelPermissionsGranted(panelRow.worktreeId, definition)
      : false
    const panel = mapWebPanel(
      panelRow,
      definition?.permissions ?? [],
      permissionsGranted
    )
    const worktree = await this.getWorktree(panel.worktreeId)
    const project = await this.getProject(worktree.projectId)
    return {
      apiVersion: 1,
      panel,
      launch: panel.launch,
      project: {
        id: project.id,
        name: project.name,
        kind: project.kind,
        defaultBranch:
          project.kind === 'repository' ? project.defaultBranch : null
      },
      worktree: {
        id: worktree.id,
        name: worktree.name,
        kind: worktree.kind,
        branch: worktree.branch,
        head: worktree.kind === 'folder' ? null : worktree.head
      }
    }
  }

  async getWebPanelDiff(panelId: string) {
    const context = await this.getWebPanelContext(panelId)
    if (
      context.project.kind !== 'repository' ||
      !context.project.defaultBranch
    ) {
      throw new DomainError(
        'GIT_NOT_AVAILABLE',
        'Git diff is not available for a folder project',
        409
      )
    }

    const worktree = await this.getWorktree(context.panel.worktreeId)
    return this.deps.git.worktreeDiff(
      worktree.path,
      context.project.defaultBranch
    )
  }

  async getBrowserPanelListeners(
    panelId: string
  ): Promise<WorktreeListenerDiscovery> {
    const panel = await this.getBrowserPanel(panelId)
    const worktree = await this.getWorktree(panel.worktreeId)
    const panes = await this.deps.terminalHost.listProcesses(worktree.id)
    return this.networkListeners.listeners({
      worktreePath: worktree.path,
      panes
    })
  }

  async getPanelListeners(panelId: string): Promise<WorktreeListenerDiscovery> {
    const [browserPanel] = await this.deps.database.db
      .select({ id: browserPanels.id })
      .from(browserPanels)
      .where(eq(browserPanels.id, panelId))
      .limit(1)
    return browserPanel
      ? this.getBrowserPanelListeners(panelId)
      : this.getWebPanelListeners(panelId)
  }

  async getWebPanelListeners(
    panelId: string
  ): Promise<WorktreeListenerDiscovery> {
    const context = await this.getWebPanelContext(panelId)
    const worktree = await this.getWorktree(context.panel.worktreeId)
    const panes = await this.deps.terminalHost.listProcesses(worktree.id)
    return this.networkListeners.listeners({
      worktreePath: worktree.path,
      panes
    })
  }

  async hasWebPanelStorage(panelId: string): Promise<boolean> {
    await this.getWebPanelContext(panelId)
    const [row] = await this.deps.database.db
      .select({ key: webPanelStorage.key })
      .from(webPanelStorage)
      .where(eq(webPanelStorage.panelId, panelId))
      .limit(1)
    return row !== undefined
  }

  async getWebPanelStorage(
    panelId: string,
    key: string
  ): Promise<JsonValue | undefined> {
    await this.getWebPanelContext(panelId)
    const [row] = await this.deps.database.db
      .select({ valueJson: webPanelStorage.valueJson })
      .from(webPanelStorage)
      .where(
        and(eq(webPanelStorage.panelId, panelId), eq(webPanelStorage.key, key))
      )
      .limit(1)
    // SAFETY: The surrounding boundary contract establishes this asserted value.
    return row ? (JSON.parse(row.valueJson) as JsonValue) : undefined
  }

  async setWebPanelStorage(
    panelId: string,
    key: string,
    value: JsonValue
  ): Promise<void> {
    await this.getWebPanelContext(panelId)
    const valueJson = JSON.stringify(value)
    const valueBytes = Buffer.byteLength(valueJson)
    if (valueBytes > WEB_PANEL_STORAGE_MAX_VALUE_BYTES) {
      throw new DomainError(
        'WEB_PANEL_STORAGE_VALUE_TOO_LARGE',
        'Web panel storage values are limited to 64 KiB',
        413
      )
    }

    const storedValues = await this.deps.database.db
      .select({ valueJson: webPanelStorage.valueJson })
      .from(webPanelStorage)
      .where(
        and(eq(webPanelStorage.panelId, panelId), ne(webPanelStorage.key, key))
      )
    const storedBytes = storedValues.reduce(
      (total, row) => total + Buffer.byteLength(row.valueJson),
      0
    )
    if (
      storedValues.length >= WEB_PANEL_STORAGE_MAX_ENTRIES ||
      storedBytes + valueBytes > WEB_PANEL_STORAGE_MAX_TOTAL_BYTES
    ) {
      throw new DomainError(
        'WEB_PANEL_STORAGE_QUOTA_EXCEEDED',
        'Web panel storage is limited to 256 values and 1 MiB per panel',
        413
      )
    }

    const updatedAt = now()
    await this.deps.database.db
      .insert(webPanelStorage)
      .values({ panelId, key, valueJson, updatedAt })
      .onConflictDoUpdate({
        target: [webPanelStorage.panelId, webPanelStorage.key],
        set: { valueJson, updatedAt }
      })
  }

  async deleteWebPanelStorage(panelId: string, key: string): Promise<void> {
    await this.getWebPanelContext(panelId)
    await this.deps.database.db
      .delete(webPanelStorage)
      .where(
        and(eq(webPanelStorage.panelId, panelId), eq(webPanelStorage.key, key))
      )
  }

  async resolveWebPanelAsset(
    panelId: string,
    requestedPath: string
  ): Promise<WebPanelAssetResolution> {
    const [panel] = await this.deps.database.db
      .select()
      .from(webPanels)
      .where(eq(webPanels.id, panelId))
      .limit(1)
    if (!panel) {
      throw new DomainError('PANEL_NOT_FOUND', 'Panel not found', 404)
    }

    const definition = (
      await this.effectiveWebPanelDefinitions(panel.worktreeId)
    ).find((candidate) => candidate.id === panel.definitionId)
    if (!definition) {
      throw new DomainError(
        'WEB_PANEL_DEFINITION_NOT_FOUND',
        'The definition for this panel is unavailable',
        404
      )
    }

    await this.requireWebPanelPermissions(panel.worktreeId, definition)
    const encodedPanelId = encodeURIComponent(panelId)
    return this.webPanelRuntime.resolve(
      definition,
      requestedPath,
      `/api/web-panels/${encodedPanelId}/assets/`
    )
  }

  async listBrowserPanels(): Promise<BrowserPanel[]> {
    return this.deps.database.db
      .select()
      .from(browserPanels)
      .orderBy(asc(browserPanels.createdAt), asc(browserPanels.id))
      .then((rows) => rows.map(mapBrowserPanel))
  }

  async listWebPanels(): Promise<WebPanel[]> {
    const rows = await this.deps.database.db
      .select()
      .from(webPanels)
      .orderBy(asc(webPanels.createdAt), asc(webPanels.id))
    return Promise.all(
      rows.map(async (row) => {
        const definition = (
          await this.effectiveWebPanelDefinitions(row.worktreeId).catch(
            () => []
          )
        ).find((candidate) => candidate.id === row.definitionId)
        return mapWebPanel(
          row,
          definition?.permissions ?? [],
          definition
            ? await this.webPanelPermissionsGranted(row.worktreeId, definition)
            : false
        )
      })
    )
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

  private async getTerminalFromBindings(
    terminalId: string
  ): Promise<TerminalRecord> {
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
        // SAFETY: The surrounding boundary contract establishes this asserted value.
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
          // SAFETY: The surrounding boundary contract establishes this asserted value.
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
      // SAFETY: The surrounding boundary contract establishes this asserted value.
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
          .findProjectRepositoryRoot(directoryPath)
          .then((checkout) =>
            checkout ? this.deps.git.resolveMainCheckout(checkout) : null
          )
          .then((mainCheckout) =>
            mainCheckout ? fs.realpath(mainCheckout) : null
          )
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
      project: exact
        ? repositoryPath
          ? { state: 'valid', kind: 'repository', path: repositoryPath }
          : { state: 'valid', kind: 'folder', path: directoryPath }
        : {
            state: 'incomplete',
            message: 'Choose a matching folder to continue.'
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
    const canonicalPath = await fs
      .realpath(path.resolve(inputPath))
      .catch((error) => {
        throw new DomainError(
          'FOLDER_UNREADABLE',
          error instanceof Error ? error.message : 'Folder cannot be read',
          400
        )
      })
    const folderStat = await fs.stat(canonicalPath, { bigint: true })
    if (!folderStat.isDirectory()) {
      throw new DomainError(
        'FOLDER_NOT_DIRECTORY',
        `Path is not a folder: ${canonicalPath}`,
        400
      )
    }

    const repositoryRoot =
      await this.deps.git.findProjectRepositoryRoot(canonicalPath)
    return repositoryRoot
      ? this.registerRepositoryProject(repositoryRoot, requestedName)
      : this.registerFolderProject(canonicalPath, requestedName)
  }

  private async registerRepositoryProject(
    inputPath: string,
    requestedName?: string
  ): Promise<ProjectRecord> {
    const checkout = await this.deps.git
      .canonicalizeRepositoryPath(inputPath)
      .catch((error) => {
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
    const repositoryIdentity =
      await this.deps.git.ensureRepositoryIdentity(repositoryPath)
    const [pathMatchRow, identityMatchRow] = await Promise.all([
      this.deps.database.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          or(
            eq(projects.repositoryPath, repositoryPath),
            eq(projects.mainWorktreePath, repositoryPath)
          )
        )
        .limit(1)
        .then(([row]) => row),
      this.deps.database.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.repositoryIdentity, repositoryIdentity))
        .limit(1)
        .then(([row]) => row)
    ])
    const [pathMatch, identityMatch] = await Promise.all([
      pathMatchRow ? this.storedProject(pathMatchRow.id) : null,
      identityMatchRow ? this.storedProject(identityMatchRow.id) : null
    ])
    const [pathMetadataRow] = pathMatch
      ? await this.deps.database.db
          .select({
            identity: projects.repositoryIdentity,
            device: projects.repositoryDevice,
            inode: projects.repositoryInode,
            nameIsCustom: projects.nameIsCustom
          })
          .from(projects)
          .where(eq(projects.id, pathMatch.id))
          .limit(1)
      : []
    const pathMetadata = pathMetadataRow
      ? {
          ...pathMetadataRow,
          nameIsCustom: Boolean(pathMetadataRow.nameIsCustom)
        }
      : null
    if (pathMatch && !pathMetadata) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The registered project is missing its repository identity metadata',
        409
      )
    }

    if (
      pathMatch &&
      ((pathMetadata?.identity !== null &&
        pathMetadata?.identity !== repositoryIdentity) ||
        (pathMetadata?.identity === null &&
          pathMetadata.inode !== repositoryInode))
    ) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The registered path now contains a different repository',
        409
      )
    }

    if (pathMatch && identityMatch && pathMatch.id !== identityMatch.id) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The repository identity and registered path belong to different projects',
        409
      )
    }

    if (
      identityMatch &&
      identityMatch.repositoryPath !== repositoryPath &&
      (await fs.realpath(identityMatch.repositoryPath).catch(() => null)) &&
      (await this.deps.git
        .repositoryIdentity(identityMatch.repositoryPath)
        .catch(() => null)) === repositoryIdentity
    ) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The same local repository identity exists at multiple paths; Treeport cannot choose between a move and a copy',
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
      const [existingMetadataRow] = existing
        ? await this.deps.database.db
            .select({
              identity: projects.repositoryIdentity,
              device: projects.repositoryDevice,
              inode: projects.repositoryInode,
              nameIsCustom: projects.nameIsCustom
            })
            .from(projects)
            .where(eq(projects.id, existing.id))
            .limit(1)
        : []
      const existingMetadata = existingMetadataRow
        ? {
            ...existingMetadataRow,
            nameIsCustom: Boolean(existingMetadataRow.nameIsCustom)
          }
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
      const verifiedIdentity =
        await this.deps.git.repositoryIdentity(repositoryPath)
      const verifiedStat = await fs.stat(repositoryPath, { bigint: true })
      if (
        verifiedIdentity !== repositoryIdentity ||
        verifiedStat.dev.toString() !== repositoryDevice ||
        verifiedStat.ino.toString() !== repositoryInode
      ) {
        throw new DomainError(
          'PROJECT_PATH_CONFLICT',
          'The repository changed during registration',
          409
        )
      }

      await this.deps.database.db.run(sql`
        INSERT INTO projects(
          id,name,project_kind,repository_path,main_worktree_path,default_branch,
          repository_identity,repository_device,repository_inode,name_is_custom,
          is_open,show_in_recents,last_opened_at,created_at,updated_at
        ) VALUES(
          ${projectId},${name},'repository',${repositoryPath},${mainPath},${defaultBranch},
          ${repositoryIdentity},${repositoryDevice},${repositoryInode},
          ${nameIsCustom ? 1 : 0},1,0,${timestamp},
          ${existing?.createdAt ?? timestamp},${timestamp}
        )
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,
          project_kind=excluded.project_kind,
          repository_path=excluded.repository_path,
          main_worktree_path=excluded.main_worktree_path,
          default_branch=excluded.default_branch,
          repository_identity=excluded.repository_identity,
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
    await this.packages.registerProject(await this.getProject(projectId))
    await this.ensureProjectTerminals(projectId).catch(() => undefined)
    this.invalidateProjectsSnapshot()
    this.events.publish('project.created', { projectId })
    return this.getProjectSnapshot(projectId)
  }

  private async registerFolderProject(
    folderPath: string,
    requestedName?: string
  ): Promise<ProjectRecord> {
    const folderStat = await fs.stat(folderPath, { bigint: true })
    const device = folderStat.dev.toString()
    const inode = folderStat.ino.toString()
    const [pathMatchRow] = await this.deps.database.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.repositoryPath, folderPath))
      .limit(1)
    const identityMatchId = [...this.observedFolderIdentities].find(
      ([, identity]) => identity.device === device && identity.inode === inode
    )?.[0]
    const [pathMatch, identityMatch] = await Promise.all([
      pathMatchRow ? this.storedProject(pathMatchRow.id) : null,
      identityMatchId ? this.storedProject(identityMatchId) : null
    ])
    if (pathMatch?.kind === 'repository') {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The selected folder is registered as a Git repository, but Git no longer recognizes it',
        409
      )
    }

    const observedPathIdentity = pathMatch
      ? this.observedFolderIdentities.get(pathMatch.id)
      : null
    if (
      observedPathIdentity &&
      (observedPathIdentity.device !== device ||
        observedPathIdentity.inode !== inode)
    ) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The registered folder path now refers to a different folder',
        409
      )
    }

    if (pathMatch && identityMatch && pathMatch.id !== identityMatch.id) {
      throw new DomainError(
        'PROJECT_PATH_CONFLICT',
        'The folder identity and registered path belong to different projects',
        409
      )
    }

    const existing = identityMatch ?? pathMatch
    const projectId = existing?.id ?? id('proj')
    const updateRegistration = async (): Promise<void> => {
      const timestamp = now()
      const [metadata] = existing
        ? await this.deps.database.db
            .select({ nameIsCustom: projects.nameIsCustom })
            .from(projects)
            .where(eq(projects.id, existing.id))
            .limit(1)
        : []
      const requested = requestedName?.trim() || null
      const nameIsCustom = requested ? true : Boolean(metadata?.nameIsCustom)
      const name =
        requested ||
        (existing &&
        !nameIsCustom &&
        existing.name === path.basename(existing.rootPath)
          ? path.basename(folderPath)
          : existing?.name) ||
        path.basename(folderPath)
      const [verifiedPath, verifiedStat] = await Promise.all([
        fs.realpath(folderPath),
        fs.stat(folderPath, { bigint: true })
      ])
      if (
        verifiedPath !== folderPath ||
        !verifiedStat.isDirectory() ||
        verifiedStat.dev.toString() !== device ||
        verifiedStat.ino.toString() !== inode
      ) {
        throw new DomainError(
          'PROJECT_PATH_CONFLICT',
          'The folder changed during registration',
          409
        )
      }

      const existingWorktreeRows = existing
        ? await this.deps.database.db
            .select()
            .from(worktrees)
            .where(eq(worktrees.projectId, projectId))
        : []
      if (
        existingWorktreeRows.length > 1 ||
        existingWorktreeRows.some((worktree) => worktree.kind !== 'folder')
      ) {
        throw new DomainError(
          'PROJECT_PATH_CONFLICT',
          'The folder registration contains incompatible Git worktrees',
          409
        )
      }

      const existingWorktree = existingWorktreeRows[0]
      const worktreeId = existingWorktree?.id ?? id('wt')
      await this.deps.database.db.transaction(async (tx) => {
        await tx.run(sql`
          INSERT INTO projects(
            id,name,project_kind,repository_path,main_worktree_path,default_branch,
            repository_identity,repository_device,repository_inode,name_is_custom,
            is_open,show_in_recents,last_opened_at,created_at,updated_at
          ) VALUES(
            ${projectId},${name},'folder',${folderPath},${folderPath},'',
            NULL,${device},${inode},${nameIsCustom ? 1 : 0},1,0,${timestamp},
            ${existing?.createdAt ?? timestamp},${timestamp}
          )
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            project_kind='folder',
            repository_path=excluded.repository_path,
            main_worktree_path=excluded.main_worktree_path,
            default_branch='',
            repository_identity=NULL,
            repository_device=excluded.repository_device,
            repository_inode=excluded.repository_inode,
            name_is_custom=excluded.name_is_custom,
            is_open=1,
            show_in_recents=0,
            last_opened_at=excluded.last_opened_at,
            updated_at=excluded.updated_at
        `)
        if (existingWorktree) {
          await tx.run(sql`
            UPDATE worktrees
            SET path=${folderPath},git_worktree_key=NULL,head='',branch=NULL,
                detached=0,locked=0,lock_reason=NULL,prunable=0,kind='folder',
                managed_wrapper_path=NULL,pr_state='unknown',pr_number=NULL,
                pr_url=NULL,pr_base_branch=NULL,pr_head_branch=NULL,
                pr_merged_at=NULL,pr_refreshed_at=NULL,updated_at=${timestamp}
            WHERE id=${worktreeId}
          `)
        } else {
          await tx.run(sql`
            INSERT INTO worktrees(
              id,project_id,path,git_worktree_key,head,branch,detached,locked,
              lock_reason,prunable,kind,created_at,updated_at
            ) VALUES(
              ${worktreeId},${projectId},${folderPath},NULL,'',NULL,0,0,NULL,0,
              'folder',${timestamp},${timestamp}
            )
          `)
        }
      })
    }

    const register = async () => {
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
      } finally {
        this.projectLocks.delete(projectId)
      }
    }

    if (existing) {
      await this.serializeProjectObservation(projectId, register)
    } else {
      await register()
    }

    this.observedFolderIdentities.set(projectId, { device, inode })

    await this.packages.registerProject(await this.getProject(projectId))
    await this.ensureProjectTerminals(projectId).catch(() => undefined)
    this.invalidateProjectsSnapshot()
    this.events.publish(existing ? 'project.updated' : 'project.created', {
      projectId
    })
    return this.getProjectSnapshot(projectId)
  }

  private async observeAvailableProject(
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
            this.worktreeMutations.has(project.id)
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
        this.projectLocks.delete(projectId)
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
          'A project tree is already being modified',
          409
        )
      }

      this.projectLocks.add(projectId)
      const lockedWorktreeIds = project.worktrees.map((worktree) => worktree.id)
      for (const worktreeId of lockedWorktreeIds) {
        this.worktreeLocks.add(worktreeId)
      }

      try {
        await this.deps.database.db
          .update(projects)
          .set({ isOpen: 0, showInRecents: 1, updatedAt: now() })
          .where(eq(projects.id, projectId))

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
      (!allowClosed && (await this.projectOpenState(projectId)) !== true)
    ) {
      return
    }

    const storedProject = await this.getProject(projectId)
    const [storedIdentity] = await this.deps.database.db
      .select({
        identity: projects.repositoryIdentity,
        device: projects.repositoryDevice,
        inode: projects.repositoryInode,
        nameIsCustom: projects.nameIsCustom
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
    if (!storedIdentity) {
      throw new Error('Registered project is missing its repository metadata')
    }

    let repositoryIdentity = storedIdentity.identity
    let canonicalRepository = await fs
      .realpath(repositoryPath)
      .catch(() => null)
    let canonicalStat = canonicalRepository
      ? await fs.stat(canonicalRepository, { bigint: true }).catch(() => null)
      : null
    let markerAtStoredPath = canonicalRepository
      ? await this.deps.git.repositoryIdentity(canonicalRepository)
      : null

    if (repositoryIdentity === null) {
      if (
        !canonicalRepository ||
        canonicalRepository !== storedProject.repositoryPath ||
        !canonicalStat?.isDirectory() ||
        (markerAtStoredPath === null &&
          canonicalStat.ino.toString() !== storedIdentity.inode)
      ) {
        throw new Error(
          'Legacy repository identity could not be enrolled; explicitly re-link the repository'
        )
      }

      const canonical =
        await this.deps.git.canonicalizeRepositoryPath(canonicalRepository)
      const resolvedMain = await this.deps.git.resolveMainCheckout(canonical)
      const enrollmentInventory = await this.deps.git.listWorktrees(canonical)
      const verifiedStat = await fs.stat(canonicalRepository, { bigint: true })
      if (
        canonical !== canonicalRepository ||
        resolvedMain !== canonicalRepository ||
        !enrollmentInventory.some(
          (item) =>
            !item.bare &&
            !item.prunable &&
            item.path === canonicalRepository &&
            item.gitWorktreeKey !== null
        ) ||
        verifiedStat.dev !== canonicalStat.dev ||
        verifiedStat.ino !== canonicalStat.ino
      ) {
        throw new Error(
          'Legacy repository changed while its durable identity was enrolled'
        )
      }

      repositoryIdentity =
        markerAtStoredPath ??
        (await this.deps.git.ensureRepositoryIdentity(canonicalRepository))
      const [identityOwner] = await this.deps.database.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.repositoryIdentity, repositoryIdentity))
        .limit(1)
      if (identityOwner && identityOwner.id !== projectId) {
        throw new Error(
          'The local Treeport repository identity belongs to another registered project'
        )
      }

      markerAtStoredPath =
        await this.deps.git.repositoryIdentity(canonicalRepository)
      const enrolledStat = await fs.stat(canonicalRepository, { bigint: true })
      if (
        markerAtStoredPath !== repositoryIdentity ||
        enrolledStat.dev !== canonicalStat.dev ||
        enrolledStat.ino !== canonicalStat.ino
      ) {
        throw new Error(
          'Repository identity changed while legacy enrollment completed'
        )
      }
    } else if (markerAtStoredPath !== repositoryIdentity) {
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
        if (!candidate || candidates.has(candidate)) {
          continue
        }

        const candidateMarker = await this.deps.git
          .repositoryIdentity(candidate)
          .catch(() => null)
        if (candidateMarker === repositoryIdentity) {
          const candidateTopLevel = await this.deps.git
            .canonicalizeRepositoryPath(candidate)
            .catch(() => null)
          if (candidateTopLevel === candidate) {
            candidates.add(candidate)
          }
        }
      }

      if (candidates.size !== 1) {
        throw new Error(
          candidates.size > 1
            ? 'Moved-repository recovery is ambiguous because the local identity exists at multiple paths'
            : markerAtStoredPath === null
              ? 'The registered repository marker is missing and no moved repository could be identified'
              : 'The registered path now contains a different repository'
        )
      }

      canonicalRepository = [...candidates][0]!
      canonicalStat = await fs.stat(canonicalRepository, { bigint: true })
    }

    if (
      !repositoryIdentity ||
      !canonicalRepository ||
      !canonicalStat?.isDirectory()
    ) {
      throw new Error('Registered main checkout is unavailable')
    }

    repositoryPath = canonicalRepository
    mainPath = canonicalRepository
    const repositoryRenamed = repositoryPath !== storedProject.repositoryPath
    const canonical =
      await this.deps.git.canonicalizeRepositoryPath(repositoryPath)
    if (canonical !== repositoryPath) {
      throw new Error('Repository is not the Git top-level main checkout')
    }

    if (repositoryRenamed) {
      if (
        (await this.deps.git.repositoryIdentity(repositoryPath)) !==
        repositoryIdentity
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
      (!allowClosed && (await this.projectOpenState(projectId)) !== true)
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

    const [repositoryStat, verifiedIdentity] = await Promise.all([
      fs.stat(repositoryPath, { bigint: true }),
      this.deps.git.repositoryIdentity(repositoryPath)
    ])
    const repositoryDevice = repositoryStat.dev.toString()
    const repositoryInode = repositoryStat.ino.toString()
    if (
      canonicalStat.dev !== repositoryStat.dev ||
      canonicalStat.ino !== repositoryStat.ino ||
      verifiedIdentity !== repositoryIdentity
    ) {
      throw new Error('Registered main checkout changed during observation')
    }

    const projectIdentityChanged =
      storedIdentity.identity === null ||
      repositoryRenamed ||
      storedIdentity.device !== repositoryDevice ||
      storedIdentity.inode !== repositoryInode
    const timestamp = now()
    const known = await this.deps.database.db.all<{
      id: string
      path: string
      git_worktree_key: string | null
      kind: 'main' | 'linked'
      managed_wrapper_path: string | null
      created_at: string
      head: string
      branch: string | null
      detached: number
      locked: number
      lock_reason: string | null
      prunable: number
    }>(sql`
      SELECT id,path,git_worktree_key,kind,
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
        (worktree) => worktree.kind === 'linked' && !matchedIds.has(worktree.id)
      )
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
    const changed = matched.filter(({ item, existing }) => {
      if (!existing) {
        return true
      }

      const kind = item.path === mainPath ? 'main' : 'linked'
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
        existing.kind !== kind
      )
    })
    const changedExistingIds = new Set(
      changed.flatMap(({ existing }) => (existing ? [existing.id] : []))
    )
    for (const worktree of retired) {
      const terminalIds = new Set(
        this.terminalIdsByWorktree.get(worktree.id) ?? []
      )
      const sessions = await this.deps.terminalHost.listTerminals(worktree.id)
      for (const terminal of sessions) {
        if (terminal.worktreeId === worktree.id) {
          terminalIds.add(terminal.id)
        }
      }
      await this.deps.terminalHost.killWorktree(worktree.id)

      const [acceptedRemoval] = await this.deps.database.db.all<{
        id: string
      }>(sql`
        SELECT id FROM operations
        WHERE worktree_id=${worktree.id} AND kind='remove'
          AND status IN ('pending','running')
        ORDER BY created_at DESC,id DESC LIMIT 1
      `)
      const retiredAt = now()
      await this.deps.database.db.transaction(async (tx) => {
        if (!acceptedRemoval) {
          await tx.run(sql`
            INSERT INTO operations(
              id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at
            ) VALUES(
              ${id('op')},'external_remove',${projectId},${
                worktree.id
              },'completed',
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

      if (!acceptedRemoval && worktree.managed_wrapper_path) {
        await fs.rmdir(worktree.managed_wrapper_path).catch(() => undefined)
      }

      this.events.publish('worktree.removed', {
        projectId,
        worktreeId: worktree.id
      })
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
              main_worktree_path=${mainPath},
              repository_identity=${repositoryIdentity},
              repository_device=${repositoryDevice},
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
                git_worktree_key=${
                  item.gitWorktreeKey ?? existing.git_worktree_key
                },
                head=${item.head ?? ''},branch=${item.branch},
                detached=${item.detached ? 1 : 0},locked=${item.locked ? 1 : 0},
                lock_reason=${item.lockReason},prunable=${
                  item.prunable ? 1 : 0
                },
                kind=${kind},
                updated_at=${timestamp}
            WHERE id=${existing.id}
          `)
          continue
        }

        await tx.run(sql`
          INSERT INTO worktrees(
            id,project_id,path,git_worktree_key,head,branch,detached,locked,lock_reason,
            prunable,kind,created_at,updated_at
          ) VALUES(
            ${id('wt')},${projectId},${item.path},${item.gitWorktreeKey},
            ${item.head ?? ''},${item.branch},${item.detached ? 1 : 0},
            ${item.locked ? 1 : 0},${item.lockReason},${item.prunable ? 1 : 0},
            ${kind},${timestamp},${timestamp}
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

  async listActiveOperations(
    filters: {
      projectId?: string
      kind?: OperationRecord['kind']
    } = {}
  ): Promise<OperationRecord[]> {
    if (filters.projectId) {
      await this.requireOpenProject(filters.projectId)
    }

    const rows = await this.deps.database.db
      .select()
      .from(operations)
      .where(
        and(
          or(
            eq(operations.status, 'pending'),
            eq(operations.status, 'running')
          ),
          ...(filters.projectId
            ? [eq(operations.projectId, filters.projectId)]
            : []),
          ...(filters.kind ? [eq(operations.kind, filters.kind)] : [])
        )
      )
      .orderBy(asc(operations.createdAt), asc(operations.id))
    return rows.map(mapOperation)
  }

  async beginCreateWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Promise<OperationRecord> {
    const project = await this.requireOpenProject(projectId)
    if (project.kind === 'folder') {
      throw new DomainError(
        'PROJECT_HAS_NO_GIT_REPOSITORY',
        'Linked worktrees require a Git repository project',
        409
      )
    }

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
      this.projectLocks.has(projectId) &&
      !this.worktreeMutations.has(projectId)
    ) {
      throw new DomainError(
        'PROJECT_BUSY',
        'Project is already being modified',
        409
      )
    }

    const operationId = id('op')
    const timestamp = now()
    const request: CreateOperationRequest = { name, base }
    if (initialTerminal) {
      request.initialTerminal = initialTerminal
    }

    if (sourceWorktreeId) {
      request.sourceWorktreeId = sourceWorktreeId
    }

    if (treeContext && Object.keys(treeContext).length > 0) {
      request.context = treeContext
    }

    await this.deps.database.db.run(sql`
      INSERT INTO operations(
        id,kind,project_id,worktree_id,status,request_json,result_json,error,
        created_at,updated_at
      ) VALUES(
        ${operationId},'create',${projectId},NULL,'pending',
        ${serializeOperation(request)},NULL,NULL,${timestamp},${timestamp}
      )
    `)
    const operation = await this.getOperation(operationId)
    this.events.publish('create.started', { projectId, operationId })

    void this.worktreeMutations
      .enqueue(projectId, () =>
        this.executeCreateOperation(
          operationId,
          projectId,
          name,
          base,
          initialTerminal,
          sourceWorktreeId,
          treeContext
        )
      )
      .catch(() => undefined)
    return operation
  }

  private async executeCreateOperation(
    operationId: string,
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Promise<void> {
    await this.deps.database.db.run(sql`
      UPDATE operations SET status='running',updated_at=${now()}
      WHERE id=${operationId} AND status='pending'
    `)
    try {
      const result = await this.executeCreateWorktree(
        projectId,
        inputName,
        base,
        initialTerminal,
        sourceWorktreeId,
        treeContext
      )
      const timestamp = now()
      await this.deps.database.db.run(sql`
        UPDATE operations
        SET status='completed',worktree_id=${result.worktree.id},
            result_json=${serializeOperation({
              worktreeId: result.worktree.id,
              terminalId: result.terminal?.id ?? null,
              terminalError: result.terminalError,
              setupError: result.setupError
            })},error=NULL,updated_at=${timestamp}
        WHERE id=${operationId}
      `)
      this.events.publish('create.completed', {
        projectId,
        operationId,
        worktreeId: result.worktree.id
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.database.db.run(sql`
        UPDATE operations
        SET status='failed',error=${message.slice(0, 4_096)},updated_at=${now()}
        WHERE id=${operationId}
      `)
      this.events.publish('create.failed', { projectId, operationId })
    }
  }

  async createWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Promise<CreateWorktreeResult> {
    const project = await this.requireOpenProject(projectId)
    if (project.kind === 'folder') {
      throw new DomainError(
        'PROJECT_HAS_NO_GIT_REPOSITORY',
        'Linked worktrees require a Git repository project',
        409
      )
    }

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
        sourceWorktreeId,
        treeContext
      )
    )
  }

  private async executeCreateWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Promise<CreateWorktreeResult> {
    const contextValues = treeContextValuesSchema.parse(treeContext ?? {})
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
      if (project.kind === 'folder') {
        throw new DomainError(
          'PROJECT_HAS_NO_GIT_REPOSITORY',
          'Linked worktrees require a Git repository project',
          409
        )
      }

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
            worktree.name.localeCompare(name, undefined, {
              sensitivity: 'accent'
            }) === 0
        )
      ) {
        throw new DomainError(
          'WORKTREE_EXISTS',
          `A tree named ${name} already exists`,
          409
        )
      }

      const destination = await resolveZedWorktreePath(
        project.mainWorktreePath,
        name
      ).catch((error) => {
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
            'A source tree is required when starting from current',
            400
          )
        }

        const source = await this.getWorktree(sourceWorktreeId)
        if (source.projectId !== projectId || source.prunable) {
          throw new DomainError(
            'INVALID_SOURCE_WORKTREE',
            'The source tree must be active and belong to the project',
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
        SET managed_wrapper_path=${wrapperCreated ? wrapperPath : null},
            tree_context_json=${JSON.stringify(contextValues)}
        WHERE path=${worktreePath}
      `)
      const [worktreeRow] = await this.deps.database.db
        .select({
          worktree: worktrees,
          mainWorktreePath: projects.mainWorktreePath
        })
        .from(worktrees)
        .innerJoin(projects, eq(worktrees.projectId, projects.id))
        .where(eq(worktrees.path, worktreePath!))
        .limit(1)
      const worktree = worktreeRow
        ? mapWorktree(worktreeRow.worktree, worktreeRow.mainWorktreePath)
        : null
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
        const launchOptions: TerminalLaunchOptions = {}
        if (initialTerminal.initialTitle) {
          launchOptions.initialTitle = initialTerminal.initialTitle
        }

        if (initialTerminal.returnToShell) {
          launchOptions.returnToShell = true
        }

        if (initialTerminal.initialSize) {
          launchOptions.initialSize = initialTerminal.initialSize
        }

        const initialTerminalCreation = this.executeCreateTerminal(
          worktree.id,
          initialTerminal.name,
          initialTerminal.argv,
          launchOptions
        )
        const setupResolution = resolveWorktreeSetupTasks({
          shell: this.deps.config.shell,
          mainWorktreePath: project.mainWorktreePath,
          worktreePath: worktree.path
        }).then(
          (tasks) => ({ tasks, error: null }),
          (error) => ({
            // SAFETY: The surrounding boundary contract establishes this asserted value.
            tasks: [] as WorktreeSetupTask[],
            error: `Tree setup: ${
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
            setupError ??= 'Tree setup: no persistent terminal could be started'
          } else {
            try {
              const setupOptions: TerminalLaunchOptions = {
                setup: { tasks: setup.tasks, error: setupError },
                closeOnSuccess: true
              }
              if (initialTerminal.initialSize) {
                setupOptions.initialSize = initialTerminal.initialSize
              }

              await this.executeCreateTerminal(
                worktree.id,
                'Setup',
                ['true'],
                setupOptions
              )
            } catch (error) {
              const setupTerminalError = `Tree setup terminal${
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
        const setupResults = await resolveWorktreeSetupTasks({
          shell: this.deps.config.shell,
          mainWorktreePath: project.mainWorktreePath,
          worktreePath: worktree.path
        })
          .then((tasks) =>
            runWorktreeSetupTasks({ runner: this.deps.runner, tasks })
          )
          .catch((error) => [
            {
              label: 'Tree setup',
              error: error instanceof Error ? error.message : String(error)
            }
          ])
        const setupFailure = setupResults.find((result) => result.error)
        setupError = setupFailure
          ? `${setupFailure.label}: ${setupFailure.error}`.slice(0, 4_096)
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
    if ((await this.projectOpenState(projectId)) !== true) {
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
      const worktree = await this.storedWorktree(worktreeId)
      if (
        !worktree ||
        (await this.projectOpenState(worktree.projectId)) !== true ||
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

  private async executeCreateTerminal(
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
        this.projectLocks.has(worktree.projectId) ||
        this.worktreeLocks.has(worktreeId) ||
        worktree.prunable
      ) {
        throw new DomainError(
          'WORKTREE_BUSY',
          'Cannot create a terminal while the tree is being modified',
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
      await this.deps.terminalHost.renameTerminal(terminal.id, name, now())
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
    const worktree = await this.storedWorktree(worktreeId)
    if (!worktree) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
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
          'Every open tree must keep at least one terminal',
          409
        )
      }

      await this.deps.terminalHost.killTerminal(terminal.id)
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
    const current = await this.storedWorktree(worktreeId)

    if (!current) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
    }

    if (this.worktreeLocks.has(worktreeId)) {
      throw new DomainError(
        'WORKTREE_UNAVAILABLE',
        'Cannot refresh a pull request while the tree is being removed',
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

  private async prepareRemovePreview(worktreeId: string): Promise<{
    preview: RemovePreview
    statusFingerprint: string
    prunable: boolean
  }> {
    const worktree = await this.requireAvailableWorktree(worktreeId, true)
    worktree.terminals = await this.listWorktreeTerminals(worktree)
    const project = await this.getProject(worktree.projectId)
    if (project.kind === 'folder') {
      throw new DomainError(
        'FOLDER_WORKSPACE_NOT_REMOVABLE',
        'Remove the folder project instead of its folder workspace',
        409
      )
    }

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
    const status = live.prunable
      ? {
          dirty: {
            dirty: false,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicts: 0,
            total: 0
          },
          fingerprint: `prunable:${live.head ?? ''}:${live.branch ?? ''}`
        }
      : await this.deps.git.dirtyStatus(worktree.path)
    const dirty = status.dirty
    const reachable =
      live.detached && head
        ? await this.deps.git.isCommitReachable(
            live.prunable ? project.repositoryPath : worktree.path,
            head
          )
        : null
    const reasons: string[] = []
    const warnings: string[] = []
    if (worktree.kind === 'main') {
      reasons.push('The main checkout cannot be removed')
    }

    if (live.locked) {
      reasons.push(
        live.lockReason
          ? `The tree is locked: ${live.lockReason}`
          : 'The tree is locked'
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
      statusFingerprint: status.fingerprint,
      prunable: live.prunable
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
    const [activeRemoval] = await this.deps.database.db.all<{ id: string }>(sql`
      SELECT id FROM operations
      WHERE worktree_id=${worktreeId} AND kind='remove'
        AND status IN ('pending','running')
      LIMIT 1
    `)
    if (activeRemoval) {
      throw new DomainError(
        'REMOVE_IN_PROGRESS',
        'The tree is already being removed',
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
        'The tree or project is already being modified',
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
      this.projectLocks.has(worktree.projectId)
    ) {
      throw new DomainError(
        'REMOVE_IN_PROGRESS',
        'The tree or project is already being modified',
        409
      )
    }

    this.worktreeLocks.add(worktreeId)
    let operationStarted = false
    try {
      const { preview, prunable } = await this.prepareRemovePreview(worktreeId)
      if (!preview.eligible) {
        throw new DomainError(
          'REMOVE_REFUSED',
          'The tree cannot be removed',
          409,
          preview
        )
      }

      if (request.confirmationToken !== preview.confirmationToken) {
        throw new DomainError(
          'REMOVE_PREVIEW_STALE',
          'The tree changed after the removal preview; review it again',
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
      const [projectMetadata] = await this.deps.database.db
        .select({ identity: projects.repositoryIdentity })
        .from(projects)
        .where(eq(projects.id, worktree.projectId))
        .limit(1)
      const repositoryIdentity = await this.deps.git.repositoryIdentity(
        prunable
          ? (await this.getProject(worktree.projectId)).repositoryPath
          : preview.path
      )
      if (
        !projectMetadata?.identity ||
        repositoryIdentity !== projectMetadata.identity
      ) {
        throw new DomainError(
          'REMOVE_PREVIEW_STALE',
          'The repository identity changed after the removal preview; review it again',
          409,
          preview
        )
      }

      const operationId = id('op')
      let checkoutIdentity: RemovalCheckoutIdentity | null = null
      if (prunable) {
        if (!checkoutBinding?.git_worktree_key) {
          throw new DomainError(
            'REMOVE_PREVIEW_STALE',
            'The prunable tree changed after the removal preview; review it again',
            409,
            preview
          )
        }
      } else {
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
            'The tree checkout changed after the removal preview; review it again',
            409,
            preview
          )
        }

        checkoutIdentity = {
          path: preview.path,
          device: checkout.dev.toString(),
          inode: checkout.ino.toString(),
          gitWorktreeKey: checkoutBinding.git_worktree_key,
          gitMarker,
          repositoryIdentity,
          managedWrapperPath: checkoutBinding.managed_wrapper_path,
          quarantinePath: path.join(
            path.dirname(preview.path),
            `.${path.basename(preview.path)}.treeport-removing-${operationId}`
          )
        }
      }

      const timestamp = now()
      await this.deps.database.db.transaction(async (tx) => {
        await tx.run(sql`
          INSERT INTO operations(
            id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at
          ) VALUES(
            ${operationId},'remove',${
              worktree.projectId
            },${worktreeId},'pending',
            ${serializeOperation({
              ...request,
              preview,
              checkoutIdentity,
              prunable,
              gitWorktreeKey: checkoutBinding.git_worktree_key,
              repositoryIdentity,
              phase: 'accepted',
              managedWrapperPath: checkoutBinding.managed_wrapper_path
            })},
            NULL,NULL,${timestamp},${timestamp}
          )
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
    const operation = await this.storedOperation(operationId)
    if (
      operation?.kind !== 'remove' ||
      !operation.projectId ||
      !operation.request.preview
    ) {
      this.worktreeLocks.delete(lockedWorktreeId)
      return
    }

    const request = operation.request
    const preview = request.preview!
    const project = await this.storedProject(operation.projectId)
    if (!project) {
      this.worktreeLocks.delete(lockedWorktreeId)
      return
    }

    const persistPhase = async (
      phase: NonNullable<typeof request.phase>
    ): Promise<void> => {
      request.phase = phase
      await this.deps.database.db.run(sql`
        UPDATE operations
        SET request_json=${serializeOperation(request)},updated_at=${now()}
        WHERE id=${operationId}
      `)
    }

    await this.deps.database.db.run(sql`
      UPDATE operations SET status='running',error=NULL,updated_at=${now()}
      WHERE id=${operationId}
    `)
    let gitRemoved =
      request.phase === 'git_removed' || request.phase === 'cleanup_pending'
    let retiredNow = false
    try {
      const liveWorktrees = await this.deps.git.listWorktrees(
        project.repositoryPath
      )
      const acceptedKey = request.gitWorktreeKey
      const liveAccepted = liveWorktrees.find(
        (item) =>
          item.path === preview.path &&
          (request.prunable
            ? item.prunable
            : acceptedKey !== null && item.gitWorktreeKey === acceptedKey)
      )
      const liveRepositoryIdentity = await this.deps.git.repositoryIdentity(
        project.repositoryPath
      )

      if (liveAccepted) {
        if (
          !request.repositoryIdentity ||
          liveRepositoryIdentity !== request.repositoryIdentity
        ) {
          throw new Error(
            'Removal revalidation failed before destructive effects: the repository identity changed after removal was accepted'
          )
        }

        if (request.prunable) {
          if (!liveAccepted.prunable) {
            throw new Error(
              'Removal revalidation failed before destructive effects: the accepted tree is no longer prunable'
            )
          }
        } else {
          const authorizationError = await this.authorizedCheckoutError(
            preview.path,
            request.checkoutIdentity
          )
          if (authorizationError) {
            throw new Error(
              `Removal revalidation failed before destructive effects: ${authorizationError}`
            )
          }
        }

        await this.deps.terminalHost.killWorktree(lockedWorktreeId)

        await persistPhase('terminals_stopped')

        if (request.prunable) {
          await this.deps.git.pruneWorktrees(project.repositoryPath)
        } else {
          await this.deps.git.removeWorktree(
            project.repositoryPath,
            preview.path,
            force
          )
        }

        const stillReported = (
          await this.deps.git.listWorktrees(project.repositoryPath)
        ).some(
          (item) =>
            item.path === preview.path &&
            (request.prunable
              ? item.prunable
              : item.gitWorktreeKey === acceptedKey)
        )
        if (stillReported) {
          throw new Error(
            'Git still reports the accepted worktree after removal'
          )
        }
      }

      gitRemoved = true
      await persistPhase('git_removed')

      const [storedBinding] = await this.deps.database.db.all<{
        id: string
        git_worktree_key: string | null
      }>(sql`
        SELECT id,git_worktree_key FROM worktrees WHERE id=${preview.worktreeId}
      `)
      if (
        storedBinding &&
        (!acceptedKey || storedBinding.git_worktree_key === acceptedKey)
      ) {
        const deletion = await this.deps.database.db.run(sql`
          DELETE FROM worktrees WHERE id=${preview.worktreeId}
        `)
        retiredNow = deletion.rowsAffected > 0
        if (retiredNow) {
          this.clearWorktreeTerminalState(preview.worktreeId)
          this.invalidateProjectsSnapshot()
          this.events.publish('worktree.removed', {
            projectId: project.id,
            worktreeId: preview.worktreeId
          })
        }
      }

      await persistPhase('cleanup_pending')
      let cleanupWarning: string | null = null
      let residualPath: string | null = null
      const currentRepositoryIdentity = await this.deps.git
        .repositoryIdentity(project.repositoryPath)
        .catch(() => null)
      if (
        request.repositoryIdentity &&
        currentRepositoryIdentity !== request.repositoryIdentity
      ) {
        cleanupWarning =
          'The repository identity changed after removal was accepted; residual files were preserved'
        residualPath = preview.path
      } else if (request.checkoutIdentity) {
        let cleanup: CheckoutCleanupResult = {
          removed: false,
          error: null
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          cleanup = await this.removeAuthorizedCheckout(
            preview.path,
            request.checkoutIdentity
          ).catch((error) => ({
            removed: false,
            error: `Automatic residual-checkout cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          }))
          if (!cleanup.error || !cleanup.error.startsWith('Automatic ')) {
            break
          }

          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
        if (cleanup.error) {
          cleanupWarning = cleanup.error.slice(0, 4_096)
          residualPath = (await this.checkoutStat(
            request.checkoutIdentity.quarantinePath
          ))
            ? request.checkoutIdentity.quarantinePath
            : preview.path
        }
      } else if (request.prunable) {
        const worktreeAtPath = (
          await this.deps.git.listWorktrees(project.repositoryPath)
        ).some((item) => item.path === preview.path)
        if (!worktreeAtPath) {
          await fs.rmdir(preview.path).catch(() => undefined)
        }
      } else if (await this.checkoutStat(preview.path)) {
        cleanupWarning =
          'The residual checkout has no matching filesystem identity and was preserved'
        residualPath = preview.path
      }

      if (request.managedWrapperPath) {
        await fs.rmdir(request.managedWrapperPath).catch(() => undefined)
      }

      const timestamp = now()
      await this.deps.database.db.run(sql`
        UPDATE operations
        SET status='completed',
            result_json=${serializeOperation({
              removed: true,
              worktreeId: preview.worktreeId,
              name: preview.name,
              branchPreserved: preview.branch,
              path: preview.path,
              recovered: operation.status === 'running' || !retiredNow,
              cleanup: {
                status: cleanupWarning ? 'preserved' : 'completed',
                residualPath,
                warning: cleanupWarning
              }
            })},
            error=NULL,
            updated_at=${timestamp}
        WHERE id=${operationId}
      `)
      this.events.publish('remove.completed', {
        operationId,
        worktreeId: preview.worktreeId
      })
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error)
      if (gitRemoved) {
        const warning = base.slice(0, 4_096)
        await this.deps.database.db.run(sql`
          UPDATE operations
          SET status='completed',
              result_json=${serializeOperation({
                removed: true,
                worktreeId: preview.worktreeId,
                name: preview.name,
                branchPreserved: preview.branch,
                path: preview.path,
                recovered: true,
                cleanup: {
                  status: 'preserved',
                  residualPath: preview.path,
                  warning
                }
              })},
              error=NULL,
              updated_at=${now()}
          WHERE id=${operationId}
        `)
        this.events.publish('remove.completed', {
          operationId,
          worktreeId: preview.worktreeId
        })
      } else {
        const message = (
          request.phase === 'terminals_stopped'
            ? `Terminals were stopped, but Git removal failed: ${base}`
            : base
        ).slice(0, 4_096)
        await this.deps.database.db.run(sql`
          UPDATE operations
          SET status='failed',result_json=NULL,error=${message},updated_at=${now()}
          WHERE id=${operationId}
        `)
        this.events.publish('remove.failed', {
          operationId,
          worktreeId: preview.worktreeId,
          error: message
        })
      }
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
        'A project tree is already being modified',
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
          'A project tree is already being modified',
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

  async drainMutations(): Promise<void> {
    await Promise.all([
      this.worktreeMutations.drain(),
      this.terminalMutations.drain(),
      this.treeFileMutations.drain()
    ])
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
