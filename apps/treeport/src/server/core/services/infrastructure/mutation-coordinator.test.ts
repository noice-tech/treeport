import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { describe, expect, it } from 'vitest'
import { ApplicationDaemons } from './application-runtime'
import { makeMutationCoordinator } from './mutation-coordinator'

class TestValue extends Context.Tag('treeport/test/MutationCoordinatorValue')<
  TestValue,
  string
>() {}

describe('Application daemon ownership', () => {
  it('interrupts long-running daemons when its layer scope closes', async () => {
    let finalized = false

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const daemons = yield* ApplicationDaemons
          const started = yield* Deferred.make<void>()
          yield* daemons.fork(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Effect.never
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  finalized = true
                })
              )
            )
          )
          yield* Deferred.await(started)
        }).pipe(Effect.provide(ApplicationDaemons.Default))
      )
    )

    expect(finalized).toBe(true)
  })
})

describe('MutationCoordinator', () => {
  it('preserves keyed ordering, cross-key concurrency, and failure isolation', async () => {
    const calls = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* makeMutationCoordinator<string>()
          const firstGate = yield* Deferred.make<void>()
          const secondKeyGate = yield* Deferred.make<void>()
          const firstStarted = yield* Deferred.make<void>()
          const secondKeyStarted = yield* Deferred.make<void>()
          const calls: string[] = []

          const first = yield* Effect.forkScoped(
            coordinator.enqueue(
              'project',
              Effect.gen(function* () {
                calls.push('first:start')
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(firstGate)
                calls.push('first:end')
                return 1
              })
            )
          )
          const failed = yield* Effect.forkScoped(
            coordinator.enqueue(
              'project',
              Effect.gen(function* () {
                calls.push('failed')
                return yield* Effect.fail('expected failure')
              })
            )
          )
          const last = yield* Effect.forkScoped(
            coordinator.enqueue(
              'project',
              Effect.sync(() => {
                calls.push('last')
                return 3
              })
            )
          )
          const otherKey = yield* Effect.forkScoped(
            coordinator.enqueue(
              'other',
              Effect.gen(function* () {
                calls.push('other:start')
                yield* Deferred.succeed(secondKeyStarted, undefined)
                yield* Deferred.await(secondKeyGate)
                calls.push('other:end')
              })
            )
          )

          yield* Deferred.await(firstStarted)
          yield* Deferred.await(secondKeyStarted)
          expect(calls).toEqual(['first:start', 'other:start'])
          expect(yield* coordinator.isBusy('project')).toBe(true)

          yield* Deferred.succeed(firstGate, undefined)
          expect(yield* Fiber.join(first)).toBe(1)
          expect(yield* Fiber.await(failed)).toMatchObject({
            _tag: 'Failure'
          })
          expect(yield* Fiber.join(last)).toBe(3)
          expect(calls).toEqual([
            'first:start',
            'other:start',
            'first:end',
            'failed',
            'last'
          ])
          expect(yield* coordinator.isBusy('project')).toBe(false)

          yield* Deferred.succeed(secondKeyGate, undefined)
          yield* Fiber.join(otherKey)
          yield* coordinator.drain
          return calls
        })
      )
    )

    expect(calls.at(-1)).toBe('other:end')
  })

  it('captures the service context of each queued workflow', async () => {
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* makeMutationCoordinator<string>()
          const gate = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()

          const first = yield* Effect.forkScoped(
            coordinator
              .enqueue(
                'project',
                Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(gate)
                  return yield* TestValue
                })
              )
              .pipe(Effect.provideService(TestValue, 'first'))
          )
          yield* Deferred.await(started)
          const second = yield* Effect.forkScoped(
            coordinator
              .enqueue('project', TestValue)
              .pipe(Effect.provideService(TestValue, 'second'))
          )

          yield* Deferred.succeed(gate, undefined)
          return yield* Effect.all([Fiber.join(first), Fiber.join(second)])
        })
      )
    )

    expect(values).toEqual(['first', 'second'])
  })

  it('drains running and queued work', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* makeMutationCoordinator<string>()
          const firstGate = yield* Deferred.make<void>()
          const secondGate = yield* Deferred.make<void>()
          const firstStarted = yield* Deferred.make<void>()
          const secondStarted = yield* Deferred.make<void>()

          yield* Effect.forkScoped(
            coordinator.enqueue(
              'project',
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(firstGate)
              })
            )
          )
          yield* Effect.forkScoped(
            coordinator.enqueue(
              'project',
              Effect.gen(function* () {
                yield* Deferred.succeed(secondStarted, undefined)
                yield* Deferred.await(secondGate)
              })
            )
          )
          yield* Deferred.await(firstStarted)

          const drain = yield* Effect.forkScoped(coordinator.drain)
          yield* Deferred.succeed(firstGate, undefined)
          yield* Deferred.await(secondStarted)
          expect(yield* Fiber.poll(drain)).toMatchObject({ _tag: 'None' })
          yield* Deferred.succeed(secondGate, undefined)
          yield* Fiber.join(drain)
        })
      )
    )
  })

  it('interrupts owned workers when its scope closes', async () => {
    let finalized = false

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* makeMutationCoordinator<string>()
          const started = yield* Deferred.make<void>()
          yield* Effect.forkScoped(
            coordinator.enqueue(
              'project',
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined)
                yield* Effect.never
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized = true
                  })
                )
              )
            )
          )
          yield* Deferred.await(started)
        })
      )
    )

    expect(finalized).toBe(true)
  })
})
