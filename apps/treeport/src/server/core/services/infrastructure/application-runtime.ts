import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
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
import {
  type MutationCoordinator,
  makeMutationCoordinator
} from './mutation-coordinator'
import { type LockRequest, MutationLocks } from './mutation-locks'
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
    scoped: makeMutationCoordinator<string>()
  }
) {}

export class TerminalMutations extends Effect.Service<TerminalMutations>()(
  'treeport/TerminalMutations',
  {
    scoped: makeMutationCoordinator<string>()
  }
) {}

export class TreeFileMutations extends Effect.Service<TreeFileMutations>()(
  'treeport/TreeFileMutations',
  {
    scoped: makeMutationCoordinator<string>()
  }
) {}

export class ProjectObservations extends Effect.Service<ProjectObservations>()(
  'treeport/ProjectObservations',
  {
    scoped: makeMutationCoordinator<string>()
  }
) {}

export class TerminalMetadataMutations extends Effect.Service<TerminalMetadataMutations>()(
  'treeport/TerminalMetadataMutations',
  {
    scoped: makeMutationCoordinator<string>()
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
    Layer.succeed(NetworkListenerPort, resources.networkListeners),
    Layer.scoped(
      WebPanelRuntimePort,
      Effect.acquireRelease(
        Effect.succeed(resources.webPanelRuntime),
        (runtime) => Effect.promise(() => runtime.dispose())
      )
    )
  )

  return ManagedRuntime.make(
    Layer.mergeAll(
      adapters,
      WorktreeMutations.Default,
      TerminalMutations.Default,
      TreeFileMutations.Default,
      ProjectObservations.Default,
      TerminalMetadataMutations.Default,
      MutationLocks.Default
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
  | NetworkListenerPort
  | WebPanelRuntimePort
  | WorktreeMutations
  | TerminalMutations
  | TreeFileMutations
  | ProjectObservations
  | TerminalMetadataMutations
  | MutationLocks

/** Preserve typed domain failures instead of exposing Effect's FiberFailure. */
async function runPromise<Result, Failure>(
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

export function mutationQueue<
  Service extends MutationCoordinator<string>,
  Tag extends ApplicationServices
>(
  runtime: ApplicationRuntime,
  tag: Effect.Effect<Service, never, Tag>
): PromiseMutationQueue {
  const coordinator = Effect.map(tag, (service) => service)
  return {
    enqueue: (key, task) =>
      runPromise(
        runtime,
        Effect.flatMap(coordinator, (service) =>
          service.enqueue(
            key,
            Effect.tryPromise({
              try: () => Promise.resolve(task()),
              catch: (error) => error
            })
          )
        )
      ),
    isBusy: (key) =>
      runPromise(
        runtime,
        Effect.flatMap(coordinator, (service) => service.isBusy(key))
      ),
    drain: () =>
      runPromise(
        runtime,
        Effect.flatMap(coordinator, (service) => service.drain)
      )
  }
}

export function mutationLocks(
  runtime: ApplicationRuntime
): PromiseMutationLocks {
  return {
    isProjectLocked: (projectId) =>
      runPromise(
        runtime,
        Effect.flatMap(MutationLocks, (locks) =>
          locks.isProjectLocked(projectId)
        )
      ),
    isWorktreeLocked: (worktreeId) =>
      runPromise(
        runtime,
        Effect.flatMap(MutationLocks, (locks) =>
          locks.isWorktreeLocked(worktreeId)
        )
      ),
    anyWorktreeLocked: (worktreeIds) =>
      runPromise(
        runtime,
        Effect.flatMap(MutationLocks, (locks) =>
          locks.anyWorktreeLocked(worktreeIds)
        )
      ),
    tryAcquire: (request) =>
      runPromise(
        runtime,
        Effect.flatMap(MutationLocks, (locks) => locks.tryAcquire(request))
      ),
    acquire: (request) =>
      runPromise(
        runtime,
        Effect.flatMap(MutationLocks, (locks) => locks.acquire(request))
      ),
    release: (request) =>
      runPromise(
        runtime,
        Effect.flatMap(MutationLocks, (locks) => locks.release(request))
      )
  }
}

export interface PromiseMutationLocks {
  isProjectLocked(projectId: string): Promise<boolean>
  isWorktreeLocked(worktreeId: string): Promise<boolean>
  anyWorktreeLocked(worktreeIds: Iterable<string>): Promise<boolean>
  tryAcquire(request: LockRequest): Promise<boolean>
  acquire(request: LockRequest): Promise<void>
  release(request: LockRequest): Promise<void>
}

export interface PromiseMutationQueue {
  enqueue<Result>(
    key: string,
    task: () => PromiseLike<Result> | Result
  ): Promise<Result>
  isBusy(key: string): Promise<boolean>
  drain(): Promise<void>
}
