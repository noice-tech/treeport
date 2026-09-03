import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FiberSet from 'effect/FiberSet'
import * as Queue from 'effect/Queue'
import * as SynchronizedRef from 'effect/SynchronizedRef'
import type * as Scope from 'effect/Scope'

interface QueuedMutation {
  readonly effect: Effect.Effect<unknown, unknown>
  readonly result: Deferred.Deferred<unknown, unknown>
}

interface KeyState {
  readonly queue: Queue.Queue<QueuedMutation>
  readonly pending: number
}

interface CoordinatorState<Key> {
  readonly keys: Map<Key, KeyState>
  readonly drainWaiters: Set<Deferred.Deferred<void>>
}

export interface MutationCoordinator<Key> {
  readonly enqueue: <Result, Error, Requirements>(
    key: Key,
    effect: Effect.Effect<Result, Error, Requirements>
  ) => Effect.Effect<Result, Error, Requirements>
  readonly isBusy: (key: Key) => Effect.Effect<boolean>
  readonly drain: Effect.Effect<void>
}

/**
 * A scoped, keyed FIFO coordinator. Work for different keys is forked into
 * separate fibers, while work for one key is consumed by a single worker.
 */
export function makeMutationCoordinator<Key>(): Effect.Effect<
  MutationCoordinator<Key>,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const fibers = yield* FiberSet.make<unknown, never>()
    const state = yield* SynchronizedRef.make<CoordinatorState<Key>>({
      keys: new Map(),
      drainWaiters: new Set()
    })

    const runKey = (
      key: Key,
      queue: Queue.Queue<QueuedMutation>
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const mutation = yield* Queue.take(queue)
        const result = yield* Effect.exit(mutation.effect)
        yield* Deferred.done(mutation.result, result)

        const continuation = yield* SynchronizedRef.modifyEffect(
          state,
          (current) => {
            const active = current.keys.get(key)
            if (active?.queue !== queue) {
              return Effect.succeed([false, current] as const)
            }

            if (active.pending > 1) {
              const keys = new Map(current.keys)
              keys.set(key, { ...active, pending: active.pending - 1 })
              return Effect.succeed([true, { ...current, keys }] as const)
            }

            const keys = new Map(current.keys)
            keys.delete(key)
            if (keys.size > 0 || current.drainWaiters.size === 0) {
              return Effect.succeed([false, { ...current, keys }] as const)
            }

            return Effect.forEach(current.drainWaiters, (waiter) =>
              Deferred.succeed(waiter, undefined)
            ).pipe(
              Effect.as([
                false,
                { keys, drainWaiters: new Set<Deferred.Deferred<void>>() }
              ] as const)
            )
          }
        )

        if (continuation) {
          yield* runKey(key, queue)
        }
      })

    const enqueue = <Result, Failure, Requirements>(
      key: Key,
      effect: Effect.Effect<Result, Failure, Requirements>
    ): Effect.Effect<Result, Failure, Requirements> =>
      Effect.gen(function* () {
        const context = yield* Effect.context<Requirements>()
        const provided = Effect.provide(effect, context)
        const result = yield* Deferred.make<unknown, unknown>()
        const worker = yield* SynchronizedRef.modifyEffect(state, (current) => {
          const active = current.keys.get(key)
          if (active) {
            const keys = new Map(current.keys)
            keys.set(key, { ...active, pending: active.pending + 1 })
            return Queue.offer(active.queue, {
              effect: provided,
              result
            }).pipe(Effect.as([null, { ...current, keys }] as const))
          }

          return Effect.gen(function* () {
            const queue = yield* Queue.unbounded<QueuedMutation>()
            yield* Queue.offer(queue, { effect: provided, result })
            const created: KeyState = { queue, pending: 1 }
            const keys = new Map(current.keys)
            keys.set(key, created)
            return [created, { ...current, keys }] as const
          })
        })

        if (worker) {
          yield* FiberSet.run(fibers, runKey(key, worker.queue))
        }

        // SAFETY: The queued effect and deferred are created from the same
        // Result/Failure pair in this invocation; the queue only erases it.
        return yield* Deferred.await(result) as Effect.Effect<Result, Failure>
      })

    const drain = Effect.gen(function* () {
      const waiter = yield* Deferred.make<void>()
      const idle = yield* SynchronizedRef.modify(state, (current) => {
        if (current.keys.size === 0) {
          return [true, current] as const
        }

        const drainWaiters = new Set(current.drainWaiters)
        drainWaiters.add(waiter)
        return [false, { ...current, drainWaiters }] as const
      })
      if (!idle) {
        yield* Deferred.await(waiter)
      }

      yield* FiberSet.awaitEmpty(fibers)
    })

    return {
      enqueue,
      isBusy: (key) =>
        SynchronizedRef.get(state).pipe(
          Effect.map((current) => current.keys.has(key))
        ),
      drain
    }
  })
}
