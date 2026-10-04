import * as Effect from 'effect/Effect'
import * as SynchronizedRef from 'effect/SynchronizedRef'

type ProjectLockKind = 'mutation' | 'worktree-creation'

interface LockState {
  readonly projects: Map<string, ProjectLockKind>
  readonly worktrees: Set<string>
  readonly removals: Map<string, string>
}

interface LockRequest {
  readonly projectId?: string
  readonly projectLockKind?: ProjectLockKind
  // A shared project lease lasting through residual cleanup, even after the
  // worktree catalog row is retired. Only creation may overlap these leases.
  readonly worktreeRemovalProjectId?: string
  // Only relax checkProjectIds; acquiring a project key remains exclusive.
  readonly allowWorktreeCreation?: boolean
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
        projects: new Map(),
        worktrees: new Set(),
        removals: new Map()
      })

      const update = (
        request: LockRequest,
        mode: 'acquire' | 'release'
      ): Effect.Effect<void> =>
        SynchronizedRef.update(state, (current) => {
          const projects = new Map(current.projects)
          const worktrees = new Set(current.worktrees)
          const removals = new Map(current.removals)
          if (request.projectId) {
            if (mode === 'acquire') {
              projects.set(
                request.projectId,
                request.projectLockKind ?? 'mutation'
              )
            } else {
              projects.delete(request.projectId)
            }
          }

          for (const worktreeId of request.worktreeIds ?? []) {
            worktrees[mode === 'acquire' ? 'add' : 'delete'](worktreeId)
            if (mode === 'acquire' && request.worktreeRemovalProjectId) {
              removals.set(worktreeId, request.worktreeRemovalProjectId)
            } else if (mode === 'release') {
              removals.delete(worktreeId)
            }
          }
          return { projects, worktrees, removals }
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
            const checkedProjectIds = [...(request.checkProjectIds ?? [])]
            const checkedWorktreeIds = [
              ...worktreeIds,
              ...(request.checkWorktreeIds ?? [])
            ]
            if (
              (request.projectId !== undefined &&
                (current.projects.has(request.projectId) ||
                  (request.projectLockKind !== 'worktree-creation' &&
                    [...current.removals.values()].includes(
                      request.projectId
                    )))) ||
              checkedProjectIds.some((projectId) => {
                const kind = current.projects.get(projectId)
                return (
                  kind !== undefined &&
                  !(
                    request.allowWorktreeCreation &&
                    kind === 'worktree-creation'
                  )
                )
              }) ||
              checkedWorktreeIds.some((worktreeId) =>
                current.worktrees.has(worktreeId)
              )
            ) {
              return [false, current] as const
            }

            const projects = new Map(current.projects)
            const worktrees = new Set(current.worktrees)
            const removals = new Map(current.removals)
            if (request.projectId) {
              projects.set(
                request.projectId,
                request.projectLockKind ?? 'mutation'
              )
            }

            for (const worktreeId of worktreeIds) {
              worktrees.add(worktreeId)
              if (request.worktreeRemovalProjectId) {
                removals.set(worktreeId, request.worktreeRemovalProjectId)
              }
            }
            return [true, { projects, worktrees, removals }] as const
          }),
        acquire: (request: LockRequest) => update(request, 'acquire'),
        release: (request: LockRequest) => update(request, 'release')
      } satisfies MutationLockState
    })
  }
) {}
