import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FiberSet from 'effect/FiberSet'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import type { AppConfig } from '../../config'
import type { CommandRunner } from '../../command'
import type { TreeportDatabase } from '../../database'
import type { ProductEventBus } from '../../events'
import type { GhAdapter } from '../../gh'
import type { GitAdapter } from '../../git'
import type { NetworkListenerAdapter } from '../../network-listeners'
import type { PackageSystem } from '../../package-system'
import type { TerminalSessionBackend } from '../../terminal'
import type { WebPanelViteRuntime } from '../../web-panel-vite-runtime'
import { tracingLayerFromEnvironment } from '../../../tracing'
import {
  PanelOperations,
  ProjectObservationOperations,
  ProjectRegistrationOperations,
  ProjectSnapshotOperations,
  TerminalOperations,
  WorktreeOperations,
  WorktreeReconciliation
} from '../domain-services'
import type { PanelService } from '../panel/panel-service'
import { PackageMutations } from '../package/package-mutations'
import { ProjectFolderIdentities } from '../project/project-folder-identities'
import type { ProjectObservationService } from '../project/project-observation-service'
import type { ProjectRegistrationService } from '../project/project-registration-service'
import type { ProjectSnapshotService } from '../project/project-snapshot-service'
import { ProjectStoreLive, type ProjectStore } from '../project/project-store'
import type { TerminalService } from '../terminal/terminal-service'
import { TerminalState } from '../terminal/terminal-state'
import type { WorktreeReconciler } from '../worktree/worktree-reconciler'
import type { WorktreeService } from '../worktree/worktree-service'
import { makeMutationCoordinator } from './mutation-coordinator'
import { MutationLocks } from './mutation-locks'
import {
  CommandPort,
  ConfigPort,
  DatabasePort,
  EventBusPort,
  GitHubPort,
  GitPort,
  NetworkListenerPort,
  PackageSystemPort,
  TerminalHostPort,
  WebPanelRuntimePort
} from './ports'

export class WorktreeMutations extends Effect.Service<WorktreeMutations>()(
  'treeport/WorktreeMutations',
  {
    scoped: makeMutationCoordinator<string>('worktree')
  }
) {}

export class TerminalMutations extends Effect.Service<TerminalMutations>()(
  'treeport/TerminalMutations',
  {
    scoped: makeMutationCoordinator<string>('terminal')
  }
) {}

export class TreeFileMutations extends Effect.Service<TreeFileMutations>()(
  'treeport/TreeFileMutations',
  {
    scoped: makeMutationCoordinator<string>('tree_file')
  }
) {}

export class ProjectObservations extends Effect.Service<ProjectObservations>()(
  'treeport/ProjectObservations',
  {
    scoped: makeMutationCoordinator<string>('project_observation')
  }
) {}

export class TerminalMetadataMutations extends Effect.Service<TerminalMetadataMutations>()(
  'treeport/TerminalMetadataMutations',
  {
    scoped: makeMutationCoordinator<string>('terminal_metadata')
  }
) {}

export class TerminalAttachmentMutations extends Effect.Service<TerminalAttachmentMutations>()(
  'treeport/TerminalAttachmentMutations',
  {
    scoped: makeMutationCoordinator<string>('terminal_attachment')
  }
) {}

export class TerminalUploadMutations extends Effect.Service<TerminalUploadMutations>()(
  'treeport/TerminalUploadMutations',
  {
    scoped: makeMutationCoordinator<string>('terminal_upload')
  }
) {}

interface ApplicationFiberSet {
  readonly fork: <Requirements>(
    effect: Effect.Effect<unknown, never, Requirements>
  ) => Effect.Effect<void, never, Requirements>
  readonly awaitEmpty: Effect.Effect<void>
}

/** Owns application daemons that run until the application scope closes. */
export class ApplicationDaemons extends Effect.Service<ApplicationDaemons>()(
  'treeport/ApplicationDaemons',
  {
    scoped: Effect.gen(function* () {
      const fibers = yield* FiberSet.make<unknown, never>()
      return {
        fork: <Requirements>(
          effect: Effect.Effect<unknown, never, Requirements>
        ) => FiberSet.run(fibers, effect).pipe(Effect.asVoid)
      }
    })
  }
) {}

/** Owns finite background work accepted before shutdown starts. */
export class ApplicationFibers extends Effect.Service<ApplicationFibers>()(
  'treeport/ApplicationFibers',
  {
    scoped: Effect.gen(function* () {
      const fibers = yield* FiberSet.make<unknown, never>()
      return {
        fork: (effect) => FiberSet.run(fibers, effect).pipe(Effect.asVoid),
        awaitEmpty: FiberSet.awaitEmpty(fibers)
      } satisfies ApplicationFiberSet
    })
  }
) {}

export interface ApplicationResources {
  readonly config: AppConfig
  readonly database: TreeportDatabase
  readonly runner: CommandRunner
  readonly git: GitAdapter
  readonly terminalHost: TerminalSessionBackend
  readonly gh: GhAdapter
  readonly events: ProductEventBus
  readonly packages: PackageSystem
  readonly panelService: PanelService
  readonly projectObservationService: ProjectObservationService
  readonly projectRegistrationService: ProjectRegistrationService
  readonly projectSnapshotService: ProjectSnapshotService
  readonly terminalService: TerminalService
  readonly worktreeReconciler: WorktreeReconciler
  readonly worktreeService: WorktreeService
  readonly networkListeners: NetworkListenerAdapter
  readonly webPanelRuntime: WebPanelViteRuntime
}

export function makeApplicationRuntime(resources: ApplicationResources) {
  const adapters = Layer.mergeAll(
    Layer.succeed(ConfigPort, resources.config),
    Layer.succeed(DatabasePort, resources.database),
    Layer.succeed(CommandPort, resources.runner),
    Layer.succeed(GitPort, resources.git),
    Layer.succeed(GitHubPort, resources.gh),
    Layer.succeed(TerminalHostPort, resources.terminalHost),
    Layer.succeed(EventBusPort, resources.events),
    Layer.succeed(PackageSystemPort, resources.packages),
    Layer.succeed(PanelOperations, resources.panelService),
    Layer.succeed(
      ProjectObservationOperations,
      resources.projectObservationService
    ),
    Layer.succeed(
      ProjectRegistrationOperations,
      resources.projectRegistrationService
    ),
    Layer.succeed(ProjectSnapshotOperations, resources.projectSnapshotService),
    Layer.succeed(TerminalOperations, resources.terminalService),
    Layer.succeed(WorktreeReconciliation, resources.worktreeReconciler),
    Layer.succeed(WorktreeOperations, resources.worktreeService),
    Layer.succeed(NetworkListenerPort, resources.networkListeners),
    Layer.scoped(
      WebPanelRuntimePort,
      Effect.acquireRelease(
        Effect.succeed(resources.webPanelRuntime),
        (runtime) => Effect.promise(() => runtime.dispose())
      )
    )
  )

  const projectStore = ProjectStoreLive.pipe(Layer.provide(adapters))

  return ManagedRuntime.make(
    Layer.mergeAll(
      adapters,
      projectStore,
      ProjectFolderIdentities.Default,
      WorktreeMutations.Default,
      TerminalMutations.Default,
      TreeFileMutations.Default,
      ProjectObservations.Default,
      PackageMutations.Default,
      TerminalMetadataMutations.Default,
      TerminalAttachmentMutations.Default,
      TerminalUploadMutations.Default,
      MutationLocks.Default,
      ApplicationDaemons.Default,
      ApplicationFibers.Default,
      TerminalState.Default,
      tracingLayerFromEnvironment(
        'treeport',
        resources.config.appVersion ?? 'unknown'
      )
    )
  )
}

export type ApplicationRuntime = ReturnType<typeof makeApplicationRuntime>
export type ApplicationServices =
  | ConfigPort
  | DatabasePort
  | CommandPort
  | GitPort
  | GitHubPort
  | TerminalHostPort
  | EventBusPort
  | PackageSystemPort
  | PanelOperations
  | ProjectObservationOperations
  | ProjectRegistrationOperations
  | ProjectSnapshotOperations
  | TerminalOperations
  | WorktreeReconciliation
  | WorktreeOperations
  | NetworkListenerPort
  | WebPanelRuntimePort
  | ProjectStore
  | ProjectFolderIdentities
  | WorktreeMutations
  | TerminalMutations
  | TreeFileMutations
  | ProjectObservations
  | PackageMutations
  | TerminalMetadataMutations
  | TerminalAttachmentMutations
  | TerminalUploadMutations
  | MutationLocks
  | ApplicationDaemons
  | ApplicationFibers
  | TerminalState

/** Preserve typed domain failures instead of exposing Effect's FiberFailure. */
export async function runApplicationEffect<Result, Failure>(
  runtime: ApplicationRuntime,
  effect: Effect.Effect<Result, Failure, ApplicationServices>
): Promise<Result> {
  const exit = await runtime.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    return exit.value
  }

  const failure = Cause.failureOption(exit.cause)
  if (Option.isSome(failure)) {
    throw failure.value
  }

  throw Cause.squash(exit.cause)
}
