import type {
  BrowserPanel,
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
  RemovePreview,
  TerminalPreset,
  TerminalPresetDefinitionListing,
  TerminalRecord,
  TerminalSize,
  TreeContextFieldListing,
  TreeContextValues,
  TreeFile,
  TreeFileListing,
  TreeFileSearchResult,
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
import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse
} from 'node:http'
import type { AppConfig } from './config'
import type { CommandRunner } from './command'
import type { TreeportDatabase } from './database'
import { ProductEventBus } from './events'
import type { GhAdapter } from './gh'
import type { GitAdapter } from './git'
import { NetworkListenerAdapter } from './network-listeners'
import { PackageSystem } from './package-system'
import type { WorktreeSetupTask } from './setup'
import {
  WebPanelViteRuntime,
  type WebPanelAssetResolution
} from './web-panel-vite-runtime'
import { ApplicationLifecycle } from './services/infrastructure/application-lifecycle'
import {
  type ApplicationRuntime,
  ProjectObservations,
  TerminalMetadataMutations,
  TerminalMutations,
  TreeFileMutations,
  WorktreeMutations,
  makeApplicationRuntime,
  mutationLocks,
  mutationQueue,
  type PromiseMutationLocks,
  type PromiseMutationQueue
} from './services/infrastructure/application-runtime'
import type { TerminalSessionBackend } from './terminal'
import { PackageService } from './services/package/package-service'
import { ProjectService } from './services/project/project-service'
import { PanelService } from './services/panel/panel-service'
import { TerminalPresetService } from './services/terminal/terminal-preset-service'
import { TerminalService } from './services/terminal/terminal-service'
import { TreeFileService } from './services/tree-file/tree-file-service'
import {
  type CreateWorktreeResult,
  WorktreeService
} from './services/worktree/worktree-service'
import { WorktreeReconciler } from './services/worktree/worktree-reconciler'
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

interface ServiceDependencies {
  config: AppConfig
  database: TreeportDatabase
  runner: CommandRunner
  git: GitAdapter
  terminalHost: TerminalSessionBackend
  gh: GhAdapter
  events?: ProductEventBus
}

export type { CreateWorktreeResult } from './services/worktree/worktree-service'

type ProjectApi = Pick<
  ProjectService,
  | 'browseDirectory'
  | 'closeProject'
  | 'deleteProject'
  | 'dismissRecentProject'
  | 'getOperation'
  | 'getProject'
  | 'getProjectSnapshot'
  | 'getWorktree'
  | 'getWorktreeContext'
  | 'getWorktreeSnapshot'
  | 'listProjects'
  | 'listRecentProjects'
  | 'listTreeContextFields'
  | 'openProject'
  | 'refreshProject'
  | 'registerProject'
  | 'requestWorkspaceOpen'
  | 'resolveRegisteredProject'
  | 'resolveProject'
  | 'resolveWorktree'
  | 'updateProjectColor'
>
type WorktreeApi = Pick<
  WorktreeService,
  | 'beginCreateWorktree'
  | 'beginRemove'
  | 'createWorktree'
  | 'listActiveOperations'
  | 'refreshPr'
  | 'removePreview'
>
type TerminalApi = Pick<
  TerminalService,
  | 'createTerminal'
  | 'deleteTerminal'
  | 'getTerminal'
  | 'refreshTerminalStatus'
  | 'renameTerminal'
  | 'terminateAllTerminals'
>
type TerminalPresetApi = Pick<
  TerminalPresetService,
  | 'createTerminalPreset'
  | 'deleteTerminalPreset'
  | 'listTerminalPresetDefinitions'
  | 'listTerminalPresets'
  | 'updateTerminalPreset'
>
type PanelApi = Pick<
  PanelService,
  | 'authorizeBrowserPanel'
  | 'createBrowserPanel'
  | 'createWebPanel'
  | 'deleteBrowserPanel'
  | 'deletePanel'
  | 'deleteWebPanel'
  | 'deleteWebPanelStorage'
  | 'getBrowserPanel'
  | 'getBrowserPanelListeners'
  | 'getPanelListeners'
  | 'getWebPanelContext'
  | 'getWebPanelDiff'
  | 'getWebPanelListeners'
  | 'getWebPanelStorage'
  | 'hasWebPanelStorage'
  | 'listBrowserPanels'
  | 'listWebPanelDefinitions'
  | 'listWebPanels'
  | 'openBrowserPanel'
  | 'openBrowserPanelFromPanel'
  | 'openBrowserPanelFromTerminal'
  | 'openWebPanel'
  | 'resolveWebPanelAsset'
  | 'setWebPanelPermissionGrant'
  | 'setWebPanelStorage'
  | 'updateBrowserPanelState'
>
type TreeFileApi = Pick<
  TreeFileService,
  'listTreeFiles' | 'readTreeFile' | 'searchTreeFiles' | 'writeTreeFile'
>
type PackageManagementApi = Pick<
  PackageService,
  | 'installPackage'
  | 'listPackages'
  | 'reloadPackages'
  | 'removePackage'
  | 'updatePackages'
>

export class TreeportService {
  readonly events: ProductEventBus
  private readonly locks: PromiseMutationLocks
  private readonly worktreeMutations: PromiseMutationQueue
  private readonly terminalMutations: PromiseMutationQueue
  private readonly treeFileMutations: PromiseMutationQueue
  readonly terminalMetadataMutations: PromiseMutationQueue
  private readonly projectObservations: PromiseMutationQueue
  private readonly packages: PackageSystem
  private readonly packageService: PackageService
  private readonly projectService: ProjectService
  private readonly panelService: PanelService
  private readonly terminalService: TerminalService
  private readonly terminalPresetService: TerminalPresetService
  private readonly treeFileService: TreeFileService
  private readonly worktreeService: WorktreeService
  private readonly worktreeReconciler: WorktreeReconciler
  private readonly networkListeners: NetworkListenerAdapter
  private readonly webPanelRuntime: WebPanelViteRuntime
  private readonly runtime: ApplicationRuntime
  private readonly lifecycle: ApplicationLifecycle

  constructor(private readonly deps: ServiceDependencies) {
    this.events = deps.events ?? new ProductEventBus()
    this.packages = new PackageSystem(deps.config, deps.runner)
    this.networkListeners = new NetworkListenerAdapter(deps.runner)
    this.webPanelRuntime = new WebPanelViteRuntime(deps.config)
    this.runtime = makeApplicationRuntime({
      ...deps,
      events: this.events,
      packages: this.packages,
      networkListeners: this.networkListeners,
      webPanelRuntime: this.webPanelRuntime
    })
    this.locks = mutationLocks(this.runtime)
    this.worktreeMutations = mutationQueue(this.runtime, WorktreeMutations)
    this.terminalMutations = mutationQueue(this.runtime, TerminalMutations)
    this.treeFileMutations = mutationQueue(this.runtime, TreeFileMutations)
    this.projectObservations = mutationQueue(this.runtime, ProjectObservations)
    this.terminalMetadataMutations = mutationQueue(
      this.runtime,
      TerminalMetadataMutations
    )
    this.terminalService = new TerminalService({
      config: deps.config,
      terminalHost: deps.terminalHost,
      events: this.events,
      locks: this.locks,
      worktreeMutations: this.worktreeMutations,
      terminalMutations: this.terminalMutations,
      storedProjects: (openOnly) => this.storedProjects(openOnly),
      storedWorktree: (worktreeId) => this.storedWorktree(worktreeId),
      projectOpenState: (projectId) => this.projectOpenState(projectId),
      getProject: (projectId) => this.getProject(projectId),
      getWorktree: (worktreeId) => this.getWorktree(worktreeId),
      requireOpenProject: (projectId) => this.requireOpenProject(projectId),
      requireAvailableWorktree: (worktreeId, allowPrunable) =>
        this.requireAvailableWorktree(worktreeId, allowPrunable),
      listProjects: () => this.listProjects(),
      invalidateProjectsSnapshot: () => this.invalidateProjectsSnapshot(),
      drainMutations: () => this.drainMutations()
    })
    this.terminalPresetService = new TerminalPresetService({
      config: deps.config,
      database: deps.database,
      packages: this.packages,
      getProject: (projectId) => this.getProject(projectId),
      getWorktree: (worktreeId) => this.getWorktree(worktreeId)
    })
    this.panelService = new PanelService({
      ...deps,
      events: this.events,
      packages: this.packages,
      networkListeners: this.networkListeners,
      webPanelRuntime: this.webPanelRuntime,
      requireAvailableWorktree: (worktreeId, allowPrunable) =>
        this.requireAvailableWorktree(worktreeId, allowPrunable),
      getProject: (projectId) => this.getProject(projectId),
      getWorktree: (worktreeId) => this.getWorktree(worktreeId),
      getTerminalFromBindings: (terminalId) =>
        this.getTerminalFromBindings(terminalId),
      invalidateProjectsSnapshot: () => this.invalidateProjectsSnapshot()
    })
    this.packageService = new PackageService({
      database: deps.database,
      events: this.events,
      packages: this.packages,
      webPanelRuntime: this.webPanelRuntime,
      storedProjects: (openOnly) => this.storedProjects(openOnly),
      getProject: (projectId) => this.getProject(projectId),
      invalidateProjectsSnapshot: () => this.invalidateProjectsSnapshot(),
      effectiveWebPanelDefinitions: (worktreeId) =>
        this.effectiveWebPanelDefinitions(worktreeId),
      webPanelPermissionSourceKey: (worktreeId, definition) =>
        this.webPanelPermissionSourceKey(worktreeId, definition)
    })
    this.treeFileService = new TreeFileService({
      git: deps.git,
      mutations: this.treeFileMutations,
      authorize: (panelId) => this.requireWebPanelTreeFiles(panelId)
    })
    this.worktreeReconciler = new WorktreeReconciler({
      database: deps.database,
      git: deps.git,
      terminalHost: deps.terminalHost,
      events: this.events,
      locks: this.locks,
      worktreeMutations: this.worktreeMutations,
      trackedTerminalIds: (worktreeId) =>
        this.terminalService.trackedTerminalIds(worktreeId),
      rememberTerminalIds: (worktreeId, terminalIds) =>
        this.terminalService.rememberTerminalIds(worktreeId, terminalIds),
      projectOpenState: (projectId) => this.projectOpenState(projectId),
      getProject: (projectId) => this.getProject(projectId),
      clearWorktreeTerminalState: (worktreeId, terminalIds) =>
        this.clearWorktreeTerminalState(worktreeId, terminalIds),
      invalidateProjectsSnapshot: () => this.invalidateProjectsSnapshot()
    })
    this.projectService = new ProjectService({
      config: deps.config,
      database: deps.database,
      git: deps.git,
      terminalHost: deps.terminalHost,
      events: this.events,
      packages: this.packages,
      locks: this.locks,
      worktreeMutations: this.worktreeMutations,
      projectObservations: this.projectObservations,
      listWorktreeTerminals: (worktree) =>
        this.terminalService.listWorktreeTerminals(worktree),
      ensureProjectTerminals: (projectId) =>
        this.terminalService.ensureProjectTerminals(projectId),
      clearWorktreeTerminalState: (worktreeId, terminalIds) =>
        this.terminalService.clearWorktreeTerminalState(
          worktreeId,
          terminalIds
        ),
      trackedTerminalIds: (worktreeId) =>
        this.terminalService.trackedTerminalIds(worktreeId),
      rememberTerminalIds: (worktreeId, terminalIds) =>
        this.terminalService.rememberTerminalIds(worktreeId, terminalIds),
      listWebPanelDefinitions: (worktreeId) =>
        this.panelService.listWebPanelDefinitions(worktreeId),
      reconcileProjectWorktrees: (
        projectId,
        repositoryPath,
        mainPath,
        allowProjectLock,
        allowClosed
      ) =>
        this.worktreeReconciler.reconcileProjectWorktrees(
          projectId,
          repositoryPath,
          mainPath,
          allowProjectLock,
          allowClosed
        )
    })
    this.worktreeService = new WorktreeService({
      ...deps,
      events: this.events,
      locks: this.locks,
      worktreeMutations: this.worktreeMutations,
      terminalMutations: this.terminalMutations,
      requireOpenProject: (projectId) => this.requireOpenProject(projectId),
      observeAvailableProject: (project, allowClosed) =>
        this.observeAvailableProject(project, allowClosed),
      importWorktrees: (
        projectId,
        repositoryPath,
        mainPath,
        allowProjectLock,
        allowClosed
      ) =>
        this.importWorktrees(
          projectId,
          repositoryPath,
          mainPath,
          allowProjectLock,
          allowClosed
        ),
      getProject: (projectId) => this.getProject(projectId),
      getWorktree: (worktreeId) => this.getWorktree(worktreeId),
      getOperation: (operationId) => this.getOperation(operationId),
      storedProject: (projectId) => this.storedProject(projectId),
      storedWorktree: (worktreeId) => this.storedWorktree(worktreeId),
      storedOperation: (operationId) => this.storedOperation(operationId),
      requireAvailableWorktree: (worktreeId, allowPrunable) =>
        this.requireAvailableWorktree(worktreeId, allowPrunable),
      listWorktreeTerminals: (worktree) => this.listWorktreeTerminals(worktree),
      createTerminal: (worktreeId, name, argv, options) =>
        this.executeCreateTerminal(worktreeId, name, argv, options),
      ensureWorktreeTerminal: (worktreeId) =>
        this.ensureWorktreeTerminal(worktreeId),
      clearWorktreeTerminalState: (worktreeId, terminalIds) =>
        this.clearWorktreeTerminalState(worktreeId, terminalIds),
      invalidateProjectsSnapshot: () => this.invalidateProjectsSnapshot()
    })
    this.lifecycle = new ApplicationLifecycle({
      database: deps.database,
      terminalHost: deps.terminalHost,
      packages: this.packages,
      locks: this.locks,
      worktreeMutations: this.worktreeMutations,
      terminalMutations: this.terminalMutations,
      treeFileMutations: this.treeFileMutations,
      projectObservations: this.projectObservations,
      reconcileProjects: () => this.projectService.reconcile(),
      storedOperation: (operationId) =>
        this.projectService.storedOperation(operationId),
      resumeRemove: (operationId, worktreeId, force) =>
        this.worktreeService.resumeRemove(operationId, worktreeId, force),
      storedProjects: () => this.projectService.storedProjects()
    })
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
    await this.runtime.dispose()
  }

  get database(): TreeportDatabase {
    return this.deps.database
  }

  get projects(): ProjectApi {
    return this.projectService
  }

  get worktrees(): WorktreeApi {
    return this.worktreeService
  }

  get terminals(): TerminalApi {
    return this.terminalService
  }

  get terminalPresets(): TerminalPresetApi {
    return this.terminalPresetService
  }

  get panels(): PanelApi {
    return this.panelService
  }

  get treeFiles(): TreeFileApi {
    return this.treeFileService
  }

  get packageManagement(): PackageManagementApi {
    return this.packageService
  }

  private storedProjects(openOnly = false): Promise<ProjectRecord[]> {
    return this.projectService.storedProjects(openOnly)
  }

  private storedProject(projectId: string): Promise<ProjectRecord | null> {
    return this.projectService.storedProject(projectId)
  }

  private storedWorktree(worktreeId: string): Promise<WorktreeRecord | null> {
    return this.projectService.storedWorktree(worktreeId)
  }

  private projectOpenState(projectId: string): Promise<boolean | null> {
    return this.projectService.projectOpenState(projectId)
  }

  private storedOperation(
    operationId: string
  ): Promise<OperationRecord | null> {
    return this.projectService.storedOperation(operationId)
  }

  initialize(): Promise<void> {
    return this.lifecycle.initialize()
  }

  private invalidateProjectsSnapshot(): void {
    this.projectService.invalidateProjectsSnapshot()
  }

  private clearWorktreeTerminalState(
    worktreeId: string,
    discoveredTerminalIds: Iterable<string> = []
  ): void {
    this.terminalService.clearWorktreeTerminalState(
      worktreeId,
      discoveredTerminalIds
    )
  }

  listProjects(): Promise<ProjectRecord[]> {
    return this.projectService.listProjects()
  }

  listRecentProjects(): Promise<RecentProjectRecord[]> {
    return this.projectService.listRecentProjects()
  }

  private listWorktreeTerminals(
    worktree: WorktreeRecord
  ): Promise<TerminalRecord[]> {
    return this.terminalService.listWorktreeTerminals(worktree)
  }

  getProjectSnapshot(projectId: string): Promise<ProjectRecord> {
    return this.projectService.getProjectSnapshot(projectId)
  }

  getWorktreeSnapshot(worktreeId: string): Promise<WorktreeRecord> {
    return this.projectService.getWorktreeSnapshot(worktreeId)
  }

  private requireAvailableWorktree(
    worktreeId: string,
    allowPrunable = false
  ): Promise<WorktreeRecord> {
    return this.projectService.requireAvailableWorktree(
      worktreeId,
      allowPrunable
    )
  }

  getProject(projectId: string): Promise<ProjectRecord> {
    return this.projectService.getProject(projectId)
  }

  private requireOpenProject(projectId: string): Promise<ProjectRecord> {
    return this.projectService.requireOpenProject(projectId)
  }

  resolveRegisteredProject(identifier: string): Promise<ProjectRecord> {
    return this.projectService.resolveRegisteredProject(identifier)
  }

  listPackages(): Promise<{
    packages: PackageListing[]
    diagnostics: PackageResourceDiagnostic[]
  }> {
    return this.packageService.listPackages()
  }

  installPackage(
    source: string,
    projectId?: string
  ): Promise<PackageOperationResult> {
    return this.packageService.installPackage(source, projectId)
  }

  removePackage(
    source: string,
    projectId?: string
  ): Promise<PackageOperationResult> {
    return this.packageService.removePackage(source, projectId)
  }

  updatePackages(source?: string): Promise<PackageOperationResult[]> {
    return this.packageService.updatePackages(source)
  }

  reloadPackages(projectId?: string): Promise<{
    results: PackageOperationResult[]
    diagnostics: PackageResourceDiagnostic[]
  }> {
    return this.packageService.reloadPackages(projectId)
  }

  updateProjectColor(
    projectId: string,
    color: ProjectColor | null
  ): Promise<ProjectRecord> {
    return this.projectService.updateProjectColor(projectId, color)
  }

  listTreeContextFields(projectId: string): Promise<TreeContextFieldListing> {
    return this.projectService.listTreeContextFields(projectId)
  }

  listTerminalPresets(): Promise<TerminalPreset[]> {
    return this.terminalPresetService.listTerminalPresets()
  }

  listTerminalPresetDefinitions(context?: {
    projectId?: string | undefined
    worktreeId?: string | undefined
  }): Promise<TerminalPresetDefinitionListing> {
    return this.terminalPresetService.listTerminalPresetDefinitions(context)
  }

  createTerminalPreset(
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'> &
      Partial<Pick<TerminalPreset, 'closeOnSuccess'>>
  ): Promise<TerminalPreset> {
    return this.terminalPresetService.createTerminalPreset(input)
  }

  updateTerminalPreset(
    presetId: string,
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'> & {
      closeOnSuccess?: boolean | undefined
    },
    expectedUpdatedAt: string
  ): Promise<TerminalPreset> {
    return this.terminalPresetService.updateTerminalPreset(
      presetId,
      input,
      expectedUpdatedAt
    )
  }

  deleteTerminalPreset(
    presetId: string,
    expectedUpdatedAt: string
  ): Promise<void> {
    return this.terminalPresetService.deleteTerminalPreset(
      presetId,
      expectedUpdatedAt
    )
  }

  private effectiveWebPanelDefinitions(worktreeId: string) {
    return this.panelService.effectiveWebPanelDefinitions(worktreeId)
  }

  private webPanelPermissionSourceKey(
    worktreeId: string,
    definition: WebPanelDefinition
  ): Promise<string> {
    return this.panelService.webPanelPermissionSourceKey(worktreeId, definition)
  }

  listWebPanelDefinitions(worktreeId: string): Promise<WebPanelDefinition[]> {
    return this.panelService.listWebPanelDefinitions(worktreeId)
  }

  setWebPanelPermissionGrant(
    worktreeId: string,
    definitionId: string,
    granted: boolean,
    expectedPermissions: WebPanelPermission[]
  ): Promise<WebPanelDefinition> {
    return this.panelService.setWebPanelPermissionGrant(
      worktreeId,
      definitionId,
      granted,
      expectedPermissions
    )
  }

  createBrowserPanel(
    worktreeId: string,
    requestedUrl?: string
  ): Promise<BrowserPanel> {
    return this.panelService.createBrowserPanel(worktreeId, requestedUrl)
  }

  openBrowserPanel(
    worktreeId: string | null,
    requestedUrl?: string,
    sourceTerminalId?: string | null,
    sourcePanelId?: string | null
  ): Promise<OpenBrowserPanelResult> {
    return this.panelService.openBrowserPanel(
      worktreeId,
      requestedUrl,
      sourceTerminalId,
      sourcePanelId
    )
  }

  openBrowserPanelFromTerminal(
    terminalId: string,
    requestedUrl: string
  ): Promise<OpenBrowserPanelResult> {
    return this.panelService.openBrowserPanelFromTerminal(
      terminalId,
      requestedUrl
    )
  }

  openBrowserPanelFromPanel(
    panelId: string,
    requestedUrl: string
  ): Promise<OpenBrowserPanelResult> {
    return this.panelService.openBrowserPanelFromPanel(panelId, requestedUrl)
  }

  getBrowserPanel(panelId: string): Promise<BrowserPanel> {
    return this.panelService.getBrowserPanel(panelId)
  }

  authorizeBrowserPanel(panelId: string): Promise<{
    panel: BrowserPanel
    worktreePath: string
  }> {
    return this.panelService.authorizeBrowserPanel(panelId)
  }

  updateBrowserPanelState(
    panelId: string,
    state: { url: string; title: string }
  ): Promise<BrowserPanel> {
    return this.panelService.updateBrowserPanelState(panelId, state)
  }

  deleteBrowserPanel(panelId: string): Promise<void> {
    return this.panelService.deleteBrowserPanel(panelId)
  }

  deletePanel(panelId: string, discardStoredData = false): Promise<void> {
    return this.panelService.deletePanel(panelId, discardStoredData)
  }

  createWebPanel(
    worktreeId: string,
    definitionId: string,
    launch?: WebPanelLaunch
  ): Promise<WebPanel> {
    return this.panelService.createWebPanel(worktreeId, definitionId, launch)
  }

  openWebPanel(
    worktreeId: string,
    definitionId: string,
    launch?: WebPanelLaunch,
    newInstance = false,
    sourceTerminalId?: string | null
  ): Promise<OpenWebPanelResult> {
    return this.panelService.openWebPanel(
      worktreeId,
      definitionId,
      launch,
      newInstance,
      sourceTerminalId
    )
  }

  deleteWebPanel(panelId: string, discardStoredData = false): Promise<void> {
    return this.panelService.deleteWebPanel(panelId, discardStoredData)
  }

  private requireWebPanelTreeFiles(panelId: string) {
    return this.panelService.requireWebPanelTreeFiles(panelId)
  }

  listTreeFiles(panelId: string): Promise<TreeFileListing> {
    return this.treeFileService.listTreeFiles(panelId)
  }

  readTreeFile(panelId: string, requestedPath: string): Promise<TreeFile> {
    return this.treeFileService.readTreeFile(panelId, requestedPath)
  }

  searchTreeFiles(
    panelId: string,
    query: string
  ): Promise<TreeFileSearchResult> {
    return this.treeFileService.searchTreeFiles(panelId, query)
  }

  writeTreeFile(
    panelId: string,
    input: TreeFileWrite
  ): Promise<TreeFileWriteResult> {
    return this.treeFileService.writeTreeFile(panelId, input)
  }

  getWebPanelContext(panelId: string): Promise<WebPanelContext> {
    return this.panelService.getWebPanelContext(panelId)
  }

  getWebPanelDiff(panelId: string) {
    return this.panelService.getWebPanelDiff(panelId)
  }

  getBrowserPanelListeners(
    panelId: string
  ): Promise<WorktreeListenerDiscovery> {
    return this.panelService.getBrowserPanelListeners(panelId)
  }

  getPanelListeners(panelId: string): Promise<WorktreeListenerDiscovery> {
    return this.panelService.getPanelListeners(panelId)
  }

  getWebPanelListeners(panelId: string): Promise<WorktreeListenerDiscovery> {
    return this.panelService.getWebPanelListeners(panelId)
  }

  hasWebPanelStorage(panelId: string): Promise<boolean> {
    return this.panelService.hasWebPanelStorage(panelId)
  }

  getWebPanelStorage(
    panelId: string,
    key: string
  ): Promise<JsonValue | undefined> {
    return this.panelService.getWebPanelStorage(panelId, key)
  }

  setWebPanelStorage(
    panelId: string,
    key: string,
    value: JsonValue
  ): Promise<void> {
    return this.panelService.setWebPanelStorage(panelId, key, value)
  }

  deleteWebPanelStorage(panelId: string, key: string): Promise<void> {
    return this.panelService.deleteWebPanelStorage(panelId, key)
  }

  resolveWebPanelAsset(
    panelId: string,
    requestedPath: string
  ): Promise<WebPanelAssetResolution> {
    return this.panelService.resolveWebPanelAsset(panelId, requestedPath)
  }

  listBrowserPanels(): Promise<BrowserPanel[]> {
    return this.panelService.listBrowserPanels()
  }

  listWebPanels(): Promise<WebPanel[]> {
    return this.panelService.listWebPanels()
  }

  getWorktree(worktreeId: string): Promise<WorktreeRecord> {
    return this.projectService.getWorktree(worktreeId)
  }

  getWorktreeContext(worktreeId: string): Promise<TreeContextValues> {
    return this.projectService.getWorktreeContext(worktreeId)
  }

  requestWorkspaceOpen(
    worktreeId: string,
    sourceTerminalId: string
  ): Promise<void> {
    return this.projectService.requestWorkspaceOpen(
      worktreeId,
      sourceTerminalId
    )
  }

  getTerminal(terminalId: string): Promise<TerminalRecord> {
    return this.terminalService.getTerminal(terminalId)
  }

  private getTerminalFromBindings(terminalId: string): Promise<TerminalRecord> {
    return this.terminalService.getTerminalFromBindings(terminalId)
  }

  getOperation(operationId: string): Promise<OperationRecord> {
    return this.projectService.getOperation(operationId)
  }

  resolveProject(identifier: string): Promise<ProjectRecord> {
    return this.projectService.resolveProject(identifier)
  }

  resolveWorktree(identifier: string): Promise<WorktreeRecord> {
    return this.projectService.resolveWorktree(identifier)
  }

  browseDirectory(
    inputPath: string,
    showHidden = false
  ): Promise<DirectoryBrowseResponse> {
    return this.projectService.browseDirectory(inputPath, showHidden)
  }

  registerProject(
    inputPath: string,
    requestedName?: string
  ): Promise<ProjectRecord> {
    return this.projectService.registerProject(inputPath, requestedName)
  }

  private observeAvailableProject(
    project: ProjectRecord,
    allowClosed = false
  ): Promise<ProjectRecord> {
    return this.projectService.observeAvailableProject(project, allowClosed)
  }

  refreshProject(projectId: string): Promise<ProjectRecord> {
    return this.projectService.refreshProject(projectId)
  }

  openProject(projectId: string): Promise<ProjectRecord> {
    return this.projectService.openProject(projectId)
  }

  closeProject(projectId: string): Promise<void> {
    return this.projectService.closeProject(projectId)
  }

  dismissRecentProject(projectId: string): Promise<void> {
    return this.projectService.dismissRecentProject(projectId)
  }

  private importWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock = false,
    allowClosed = false
  ): Promise<void> {
    return this.projectService.importWorktrees(
      projectId,
      repositoryPath,
      mainPath,
      allowProjectLock,
      allowClosed
    )
  }

  private reconcileProjectWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock: boolean,
    allowClosed = false
  ): Promise<void> {
    return this.worktreeReconciler.reconcileProjectWorktrees(
      projectId,
      repositoryPath,
      mainPath,
      allowProjectLock,
      allowClosed
    )
  }

  listActiveOperations(
    filters: {
      projectId?: string
      kind?: OperationRecord['kind']
    } = {}
  ): Promise<OperationRecord[]> {
    return this.worktreeService.listActiveOperations(filters)
  }

  beginCreateWorktree(
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
    return this.worktreeService.beginCreateWorktree(
      projectId,
      inputName,
      base,
      initialTerminal,
      sourceWorktreeId,
      treeContext
    )
  }

  createWorktree(
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
    return this.worktreeService.createWorktree(
      projectId,
      inputName,
      base,
      initialTerminal,
      sourceWorktreeId,
      treeContext
    )
  }

  private ensureProjectTerminals(projectId: string): Promise<void> {
    return this.terminalService.ensureProjectTerminals(projectId)
  }

  private ensureWorktreeTerminal(
    worktreeId: string
  ): Promise<TerminalRecord | null> {
    return this.terminalService.ensureWorktreeTerminal(worktreeId)
  }

  createTerminal(
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
  ): Promise<TerminalRecord> {
    return this.terminalService.createTerminal(worktreeId, name, argv, options)
  }

  private executeCreateTerminal(
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
  ): Promise<TerminalRecord> {
    return this.terminalService.executeCreateTerminal(
      worktreeId,
      name,
      argv,
      options
    )
  }

  refreshTerminalStatus(
    terminalId: string,
    observeGit = true
  ): Promise<TerminalRecord> {
    return this.terminalService.refreshTerminalStatus(terminalId, observeGit)
  }

  renameTerminal(terminalId: string, name: string): Promise<TerminalRecord> {
    return this.terminalService.renameTerminal(terminalId, name)
  }

  deleteTerminal(terminalId: string): Promise<void> {
    return this.terminalService.deleteTerminal(terminalId)
  }

  refreshPr(worktreeId: string, force = false): Promise<PrInfo> {
    return this.worktreeService.refreshPr(worktreeId, force)
  }

  removePreview(worktreeId: string): Promise<RemovePreview> {
    return this.worktreeService.removePreview(worktreeId)
  }

  beginRemove(
    worktreeId: string,
    request: { confirmationToken: string; confirmDestructive: boolean }
  ): Promise<OperationRecord> {
    return this.worktreeService.beginRemove(worktreeId, request)
  }

  deleteProject(projectId: string): Promise<void> {
    return this.projectService.deleteProject(projectId)
  }

  terminateAllTerminals(): Promise<number> {
    return this.terminalService.terminateAllTerminals()
  }

  drainMutations(): Promise<void> {
    return this.lifecycle.drain()
  }

  reconcile(): Promise<void> {
    return this.projectService.reconcile()
  }
}
