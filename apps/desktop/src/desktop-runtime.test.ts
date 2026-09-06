import { expect, it } from 'vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import { DesktopRuntime } from './desktop-runtime'

it('closes children, interrupts tasks, and awaits resource finalizers exactly once', async () => {
  const app = new DesktopRuntime()
  const window = new DesktopRuntime(app)
  const guest = new DesktopRuntime(window)
  const entered = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  const events: string[] = []
  const task = guest.fork(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => events.push('acquired')),
        () =>
          Effect.gen(function* () {
            events.push('releasing')
            yield* Deferred.await(release)
            events.push('released')
          })
      )
      yield* Deferred.succeed(entered, undefined)
      yield* Effect.never
    })
  )
  await Effect.runPromise(Deferred.await(entered))
  const closing = Effect.runPromise(app.close)
  expect(app.isClosed).toBe(true)
  expect(guest.isClosed).toBe(true)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Promise.all([closing, Effect.runPromise(app.close)])
  expect(events).toEqual(['acquired', 'releasing', 'released'])
  await Effect.runPromise(Fiber.await(task))
  const late = guest.run(Effect.sync(() => events.push('late')))
  await expect(late).rejects.toThrow()
  expect(events).not.toContain('late')
})

it('replaces a resource without closing its sibling or retaining its finalizer', async () => {
  const app = new DesktopRuntime()
  const first = new DesktopRuntime(app)
  const sibling = new DesktopRuntime(app)
  let closes = 0
  Effect.runSync(
    Scope.addFinalizer(
      first.scope,
      Effect.sync(() => {
        closes++
      })
    )
  )
  await Effect.runPromise(first.close)
  expect(closes).toBe(1)
  expect(await sibling.run(Effect.succeed('alive'))).toBe('alive')
  await Effect.runPromise(app.close)
  expect(closes).toBe(1)
})
