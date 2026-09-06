import {
  decodeUnknownOrNull,
  desktopHealthResponseSchema
} from '@treeport/shared'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

export const checkHealth = (origin: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(new URL('/api/health', origin).toString(), {
      redirect: 'error',
      signal
    })
    return response.ok
      ? decodeUnknownOrNull(desktopHealthResponseSchema, await response.json())
      : null
  }).pipe(
    Effect.timeoutOption('1500 millis'),
    Effect.map(Option.getOrNull),
    Effect.catchAll(() => Effect.succeed(null))
  )

// Canceling the consumer interrupts both backoff and the current fetch/body.
// Emit unavailable once after the grace period, then keep trying until ready.
export const watchBackendHealth = (origin: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const retryDelays = [0, 250, 500, 1_000, 2_000]
      let attempt = 0
      let unavailable = false
      return Stream.repeatEffect(
        Effect.gen(function* () {
          yield* Effect.sleep(
            retryDelays[Math.min(attempt++, retryDelays.length - 1)]!
          )
          const health = yield* checkHealth(origin)
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt
          if (health) {
            return Option.some(health)
          }

          if (!unavailable && elapsed >= 3_000) {
            unavailable = true
            return Option.some(null)
          }

          return Option.none()
        })
      ).pipe(
        Stream.filterMap((value) => value),
        Stream.takeUntil((health) => health !== null)
      )
    })
  )
