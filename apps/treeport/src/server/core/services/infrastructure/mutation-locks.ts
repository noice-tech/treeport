import * as Effect from 'effect/Effect'
import * as SynchronizedRef from 'effect/SynchronizedRef'

interface LockState {
  readonly projects: Set<string>
  readonly worktrees: Set<string>
}

interface LockRequest {
  readonly projectId?: string
  readonly worktreeIds?: Iterable<string>
  readonly checkProjectIds?: Iterable<string>
  readonly checkWorktreeIds?: Iterable<string>
}

interface MutationLockState {
  readonly isProjectLocked: (projectId: string) => Effect.Effect<boolean>
  readonly isWorktreeLocked: (worktreeId: string) => Effect.Effect<boolean>
  readonly anyWorktreeLocked: (
    worktreeIds: Iterable<string>
  ) => Effect.Effect<boolean>
  readonly tryAcquire: (request: LockRequest) => Effect.Effect<boolean>
  readonly acquire: (request: LockRequest) => Effect.Effect<void>
  readonly release: (request: LockRequest) => Effect.Effect<void>
}

export class MutationLocks extends Effect.Service<MutationLocks>()(
  'treeport/MutationLocks',
  {
    effect: Effect.gen(function* () {
      const state = yield* SynchronizedRef.make<LockState>({
        projects: new Set(),
        worktrees: new Set()
      })

      const update = (
        request: LockRequest,
        mode: 'acquire' | 'release'
      ): Effect.Effect<void> =>
        SynchronizedRef.update(state, (current) => {
          const projects = new Set(current.projects)
          const worktrees = new Set(current.worktrees)
          if (request.projectId) {
            projects[mode === 'acquire' ? 'add' : 'delete'](request.projectId)
          }

          for (const worktreeId of request.worktreeIds ?? []) {
            worktrees[mode === 'acquire' ? 'add' : 'delete'](worktreeId)
          }
          return { projects, worktrees }
        })

      return {
        isProjectLocked: (projectId: string) =>
          SynchronizedRef.get(state).pipe(
            Effect.map((current) => current.projects.has(projectId))
          ),
        isWorktreeLocked: (worktreeId: string) =>
          SynchronizedRef.get(state).pipe(
            Effect.map((current) => current.worktrees.has(worktreeId))
          ),
        anyWorktreeLocked: (worktreeIds: Iterable<string>) =>
          SynchronizedRef.get(state).pipe(
            Effect.map((current) =>
              [...worktreeIds].some((worktreeId) =>
                current.worktrees.has(worktreeId)
              )
            )
          ),
        tryAcquire: (request: LockRequest) =>
          SynchronizedRef.modify(state, (current) => {
            const worktreeIds = [...(request.worktreeIds ?? [])]
            const projectIds = [
              ...(request.projectId ? [request.projectId] : []),
              ...(request.checkProjectIds ?? [])
            ]
            const checkedWorktreeIds = [
              ...worktreeIds,
              ...(request.checkWorktreeIds ?? [])
            ]
            if (
              projectIds.some((projectId) => current.projects.has(projectId)) ||
              checkedWorktreeIds.some((worktreeId) =>
                current.worktrees.has(worktreeId)
              )
            ) {
              return [false, current] as const
            }

            const projects = new Set(current.projects)
            const worktrees = new Set(current.worktrees)
            if (request.projectId) {
              projects.add(request.projectId)
            }

            for (const worktreeId of worktreeIds) {
              worktrees.add(worktreeId)
            }
            return [true, { projects, worktrees }] as const
          }),
        acquire: (request: LockRequest) => update(request, 'acquire'),
        release: (request: LockRequest) => update(request, 'release')
      } satisfies MutationLockState
    })
  }
) {}
