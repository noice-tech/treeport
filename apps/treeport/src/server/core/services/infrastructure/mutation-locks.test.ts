import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { MutationLocks } from './mutation-locks'

describe('MutationLocks', () => {
  it('admits only one competing acquisition and releases all keys together', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const locks = yield* MutationLocks
        const competing = yield* Effect.all(
          [
            locks.tryAcquire({
              projectId: 'project',
              worktreeIds: ['tree-a', 'tree-b']
            }),
            locks.tryAcquire({ worktreeIds: ['tree-a'] })
          ],
          { concurrency: 'unbounded' }
        )
        const busy = yield* locks.anyWorktreeLocked(['tree-a', 'tree-b'])
        yield* locks.release({
          projectId: 'project',
          worktreeIds: ['tree-a', 'tree-b']
        })
        return {
          competing,
          busy,
          projectBusy: yield* locks.isProjectLocked('project'),
          worktreeBusy: yield* locks.isWorktreeLocked('tree-a')
        }
      }).pipe(Effect.provide(MutationLocks.Default))
    )

    expect(result.competing.filter(Boolean)).toHaveLength(1)
    expect(result.busy).toBe(true)
    expect(result.projectBusy).toBe(false)
    expect(result.worktreeBusy).toBe(false)
  })

  it('supports fail-fast project checks without acquiring the project key', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const locks = yield* MutationLocks
        yield* locks.acquire({ projectId: 'project' })
        const acquired = yield* locks.tryAcquire({
          worktreeIds: ['tree'],
          checkProjectIds: ['project']
        })
        const worktreeBusy = yield* locks.isWorktreeLocked('tree')
        yield* locks.release({ projectId: 'project' })
        return { acquired, worktreeBusy }
      }).pipe(Effect.provide(MutationLocks.Default))
    )

    expect(result).toEqual({ acquired: false, worktreeBusy: false })
  })
})
