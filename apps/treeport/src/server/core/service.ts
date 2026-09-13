import * as Effect from 'effect/Effect'
import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse
} from 'node:http'
import type { Duplex } from 'node:stream'
import type { AppConfig } from './config'
import { asEffectCommandRunner, type CommandRunner } from './command'
import type { DomainError } from './domain'
import { ProductEventBus } from './events'
import { PackageSystem } from './package-system'
import {
  type WebPanelViteRuntime,
  WebPanelRuntimePort
} from './web-panel-vite-runtime'
import { ApplicationLifecycle } from './services/infrastructure/application-lifecycle'
import {
  type ApplicationRuntime,
  type ApplicationServices,
  ApplicationFibers,
  TerminalAttachmentMutations,
  TerminalMetadataMutations,
  TerminalUploadMutations,
  makeApplicationRuntime,
  runApplicationEffect
} from './services/infrastructure/application-runtime'
import type { TerminalSessionBackend } from './terminal'
import { PackageService } from './services/package/package-service'
import { ProjectObservationService } from './services/project/project-observation-service'
import { ProjectRegistrationService } from './services/project/project-registration-service'
import { ProjectSnapshotService } from './services/project/project-snapshot-service'
import { ProjectService } from './services/project/project-service'
import { PanelService } from './services/panel/panel-service'
import { TerminalPresetService } from './services/terminal/terminal-preset-service'
import { TerminalService } from './services/terminal/terminal-service'
import { TreeFileService } from './services/tree-file/tree-file-service'
import { WorktreeService } from './services/worktree/worktree-service'
import { WorktreeReconciler } from './services/worktree/worktree-reconciler'

interface ServiceDependencies {
  config: AppConfig
  runner: CommandRunner
  terminalHost: TerminalSessionBackend
  events?: ProductEventBus
}

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
  | 'reconcile'
  | 'registerProject'
  | 'requestWorkspaceOpen'
  | 'resolveRegisteredProject'
  | 'resolveProject'
  | 'resolveWorktree'
  | 'updateProjectColor'
  | 'updateTerminalLayout'
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
  | 'getKnownTerminal'
  | 'refreshTerminalStatus'
  | 'renameTerminal'
  | 'reorderTerminals'
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
  | 'getWebPanelDiffImage'
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
  | 'reorderPanels'
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
  private readonly packages: PackageSystem
  private readonly packageService: PackageService
  private readonly projectObservationService: ProjectObservationService
  private readonly projectRegistrationService: ProjectRegistrationService
  private readonly projectSnapshotService: ProjectSnapshotService
  private readonly projectService: ProjectService
  private readonly panelService: PanelService
  private readonly terminalService: TerminalService
  private readonly terminalPresetService: TerminalPresetService
  private readonly treeFileService: TreeFileService
  private readonly worktreeService: WorktreeService
  private readonly worktreeReconciler: WorktreeReconciler
  private webPanelRuntime: WebPanelViteRuntime | null = null
  private readonly runtime: ApplicationRuntime
  private readonly lifecycle: ApplicationLifecycle

  constructor(deps: ServiceDependencies) {
    this.events = deps.events ?? new ProductEventBus()
    this.packages = new PackageSystem(deps.config, deps.runner)
    this.terminalService = new TerminalService()
    this.terminalPresetService = new TerminalPresetService()
    this.panelService = new PanelService()
    this.packageService = new PackageService()
    this.treeFileService = new TreeFileService()
    this.worktreeReconciler = new WorktreeReconciler()
    this.projectObservationService = new ProjectObservationService()
    this.projectSnapshotService = new ProjectSnapshotService()
    this.projectRegistrationService = new ProjectRegistrationService()
    this.projectService = new ProjectService()
    this.worktreeService = new WorktreeService()
    this.lifecycle = new ApplicationLifecycle()
    this.runtime = makeApplicationRuntime({
      ...deps,
      runner: asEffectCommandRunner(deps.runner),
      events: this.events,
      packages: this.packages,
      panelService: this.panelService,
      projectObservationService: this.projectObservationService,
      projectRegistrationService: this.projectRegistrationService,
      projectSnapshotService: this.projectSnapshotService,
      terminalService: this.terminalService,
      worktreeReconciler: this.worktreeReconciler,
      worktreeService: this.worktreeService
    })
  }

  runEffect<Result, Failure>(
    effect: Effect.Effect<Result, Failure, ApplicationServices>
  ): Promise<Result> {
    return runApplicationEffect(this.runtime, effect)
  }

  forkEffect<Result, Failure>(
    effect: Effect.Effect<Result, Failure, ApplicationServices>
  ) {
    return this.runtime.runFork(effect)
  }

  forkApplicationEffect(
    effect: Effect.Effect<unknown, never, ApplicationServices>
  ): void {
    this.runtime.runFork(
      Effect.flatMap(ApplicationFibers, (fibers) => fibers.fork(effect))
    )
  }

  terminalAttachmentMutation<Result>(
    terminalId: string,
    effect: Effect.Effect<Result, unknown, ApplicationServices>
  ): Effect.Effect<Result, unknown, ApplicationServices> {
    return Effect.flatMap(TerminalAttachmentMutations, (mutations) =>
      mutations.enqueue(terminalId, effect)
    )
  }

  terminalMetadataMutation(
    terminalId: string,
    effect: Effect.Effect<void, DomainError<unknown>, ApplicationServices>
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    return Effect.flatMap(TerminalMetadataMutations, (mutations) =>
      mutations.enqueue(terminalId, effect)
    )
  }

  drainTerminalMetadataMutations(): Effect.Effect<
    void,
    never,
    ApplicationServices
  > {
    return Effect.flatMap(
      TerminalMetadataMutations,
      (mutations) => mutations.drain
    )
  }

  terminalUploadMutation<Result, Failure>(
    effect: Effect.Effect<Result, Failure, ApplicationServices>
  ): Effect.Effect<Result, Failure, ApplicationServices> {
    return Effect.flatMap(TerminalUploadMutations, (mutations) =>
      mutations.enqueue('uploads', effect)
    )
  }

  private requireWebPanelRuntime(): WebPanelViteRuntime {
    if (!this.webPanelRuntime) {
      throw new Error('Treeport service is not initialized')
    }

    return this.webPanelRuntime
  }

  attachHttpServer(server: HttpServer): void {
    this.requireWebPanelRuntime().attachHttpServer(server)
  }

  handleWebPanelDevelopmentRequest(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void
  ): void {
    this.requireWebPanelRuntime().handleDevelopmentRequest(
      request,
      response,
      next
    )
  }

  handleWebPanelDevelopmentUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): boolean {
    return this.requireWebPanelRuntime().handleDevelopmentUpgrade(
      request,
      socket,
      head
    )
  }

  async disposeRuntime(): Promise<void> {
    await this.runtime.dispose()
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

  prepareStartup(): Effect.Effect<void, never, ApplicationServices> {
    return Effect.gen(this, function* () {
      this.webPanelRuntime = yield* WebPanelRuntimePort
      yield* this.lifecycle.prepareStartup()
    })
  }

  activateStartup(): Effect.Effect<void, never, ApplicationServices> {
    return this.lifecycle.activateStartup()
  }

  drainMutations(): Effect.Effect<void, never, ApplicationServices> {
    return this.lifecycle.drain()
  }
}
