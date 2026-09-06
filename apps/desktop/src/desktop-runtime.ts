import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as ExecutionStrategy from 'effect/ExecutionStrategy'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'

// Electron callbacks are the Promise/Effect boundary. Every asynchronous task
// belongs to an app, window, guest or bridge scope; none outlive their owner.
export class DesktopRuntime {
  readonly scope: Scope.CloseableScope
  private closed = false
  readonly close = Effect.runSync(
    Effect.cached(
      Effect.suspend(() => {
        this.closed = true
        return Scope.close(this.scope, Exit.void)
      })
    )
  )

  constructor(private readonly parent: DesktopRuntime | null = null) {
    // Scope.fork unlinks closed children; repeated bridge/capture replacement
    // must not retain every historical guest in the application scope.
    this.scope = Effect.runSync(
      parent
        ? Scope.fork(parent.scope, ExecutionStrategy.sequential)
        : Scope.make()
    )
  }

  get isClosed(): boolean {
    return this.closed || (this.parent?.isClosed ?? false)
  }

  run<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
    return Effect.runPromise(
      this.task(effect).pipe(
        Effect.forkIn(this.scope),
        Effect.flatMap(Fiber.join)
      )
    )
  }

  fork<A, E>(
    effect: Effect.Effect<A, E, Scope.Scope>
  ): Fiber.RuntimeFiber<void> {
    return Effect.runSync(
      this.task(effect).pipe(
        Effect.asVoid,
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError(cause)
        ),
        Effect.forkIn(this.scope)
      )
    )
  }

  private task<A, E>(effect: Effect.Effect<A, E, Scope.Scope>) {
    return Effect.suspend(() =>
      this.isClosed ? Effect.interrupt : Scope.extend(effect, this.scope)
    )
  }
}
