import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { type TerminalSessionState } from './state'

export type SessionTimer =
  | 'degraded'
  | 'bell'
  | 'fileTransfer'
  | 'cursorRestore'
  | 'resizeSettle'

interface Dependencies {
  failRendering(cause: unknown): void
}

export function makeTimers(
  state: Pick<TerminalSessionState, 'disposed'>,
  dependencies: Dependencies
) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope
    const timers = new Map<SessionTimer, Fiber.RuntimeFiber<void, never>>()

    function cancelTimer(key: SessionTimer): void {
      const fiber = timers.get(key)
      timers.delete(key)
      if (fiber) {
        Effect.runSync(Fiber.interruptFork(fiber))
      }
    }

    function scheduleTimer(
      key: SessionTimer,
      callback: () => void,
      delay: number
    ): void {
      cancelTimer(key)
      if (state.disposed) {
        return
      }

      const fiber = Effect.runSync(
        Effect.forkIn(
          Effect.sleep(delay).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (timers.get(key) !== fiber) {
                  return
                }

                timers.delete(key)
                if (!state.disposed) {
                  callback()
                }
              })
            ),
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                if (!Cause.isInterruptedOnly(cause)) {
                  dependencies.failRendering(Cause.squash(cause))
                }
              })
            )
          ),
          scope
        )
      )
      timers.set(key, fiber)
    }

    function clearTimers(): void {
      for (const key of timers.keys()) {
        cancelTimer(key)
      }
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearTimers()
      })
    )

    return {
      cancelTimer,
      scheduleTimer,
      hasTimer: (key: SessionTimer) => timers.has(key)
    }
  })
}
