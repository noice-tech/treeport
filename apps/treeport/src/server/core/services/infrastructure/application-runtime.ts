import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FiberSet from 'effect/FiberSet'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import type { AppConfig } from '../../config.ts'
import type { EffectCommandRunner } from '../../command.ts'
import { DatabaseLayer, type DatabasePort } from '../../database.ts'
import type { ProductEventBus } from '../../events.ts'
import { GitLayer, type GitPort } from '../../git.ts'
import {
  NetworkListenersLayer,
  type NetworkListenerPort
} from '../../network-listeners.ts'
import type { PackageSystem } from '../../package-system.ts'
import { SetupLive, type Setup } from '../../setup.ts'
import type { TerminalSessionBackend } from '../../terminal.ts'
import { ZedLive, type Zed } from '../../zed.ts'
import {
  WebAppRuntimeLayer,
  type WebAppRuntimePort
} from '../../web-app-vite-runtime.ts'
import { tracingLayerFromEnvironment } from '../../../tracing.ts'
import {
  AppOperations,
  ProjectObservationOperations,
  ProjectRegistrationOperations,
  ProjectSnapshotOperations,
  TerminalOperations,
  WorktreeOperations,
  WorktreeReconciliation
} from '../domain-services.ts'
import type { AppService } from '../app/app-service.ts'
import { PackageMutations } from '../package/package-mutations.ts'
import { ProjectFolderIdentities } from '../project/project-folder-identities.ts'
import type { ProjectObservationService } from '../project/project-observation-service.ts'
import type { ProjectRegistrationService } from '../project/project-registration-service.ts'
import type { ProjectSnapshotService } from '../project/project-snapshot-service.ts'
import {
  ProjectStoreLive,
  type ProjectStore
} from '../project/project-store.ts'
import type { TerminalService } from '../terminal/terminal-service.ts'
import { TerminalState } from '../terminal/terminal-state.ts'
import type { WorktreeReconciler } from '../worktree/worktree-reconciler.ts'
import type { WorktreeService } from '../worktree/worktree-service.ts'
import { makeMutationCoordinator } from './mutation-coordinator.ts'
import { MutationLocks } from './mutation-locks.ts'
import {
  CommandPort,
  ConfigPort,
  EventBusPort,
  PackageSystemPort,
  TerminalHostPort
} from './ports.ts'

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

export class ApplicationFibers extends Effect.Service<ApplicationFibers>()(
  'treeport/ApplicationFibers',
  {
    scoped: Effect.gen(function* () {
      const fibers = yield* FiberSet.make<unknown, never>()

      return {
        // EXTERNAL: The application scope owns accepted work, not the request's
        // interruption mask. Inheriting that mask can deadlock races while
        // they wait for losing command/timeout fibers to be interrupted.
        fork: (effect) =>
          FiberSet.run(fibers, Effect.interruptible(effect)).pipe(
            Effect.asVoid
          ),
        awaitEmpty: FiberSet.awaitEmpty(fibers)
      } satisfies ApplicationFiberSet
    })
  }
) {}

export interface ApplicationResources {
  readonly config: AppConfig
  readonly runner: EffectCommandRunner
  readonly terminalHost: TerminalSessionBackend
  readonly events: ProductEventBus
  readonly packages: PackageSystem
  readonly appService: AppService
  readonly projectObservationService: ProjectObservationService
  readonly projectRegistrationService: ProjectRegistrationService
  readonly projectSnapshotService: ProjectSnapshotService
  readonly terminalService: TerminalService
  readonly worktreeReconciler: WorktreeReconciler
  readonly worktreeService: WorktreeService
}

export function makeApplicationRuntime(resources: ApplicationResources) {
  const adapters = Layer.mergeAll(
    Layer.succeed(ConfigPort, resources.config),
    DatabaseLayer(resources.config.databasePath),
    Layer.succeed(CommandPort, resources.runner),
    GitLayer(resources.runner, resources.config.gitPath),
    Layer.succeed(TerminalHostPort, resources.terminalHost),
    Layer.succeed(EventBusPort, resources.events),
    Layer.succeed(PackageSystemPort, resources.packages),
    Layer.succeed(AppOperations, resources.appService),
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
    NetworkListenersLayer(resources.runner),
    WebAppRuntimeLayer(resources.config)
  )

  const projectStore = ProjectStoreLive.pipe(Layer.provide(adapters))

  return ManagedRuntime.make(
    Layer.mergeAll(
      adapters,
      SetupLive,
      ZedLive,
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
  | TerminalHostPort
  | EventBusPort
  | PackageSystemPort
  | AppOperations
  | ProjectObservationOperations
  | ProjectRegistrationOperations
  | ProjectSnapshotOperations
  | TerminalOperations
  | WorktreeReconciliation
  | WorktreeOperations
  | NetworkListenerPort
  | WebAppRuntimePort
  | Setup
  | Zed
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
