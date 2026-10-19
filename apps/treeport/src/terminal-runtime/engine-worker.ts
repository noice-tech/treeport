import { parentPort, workerData } from 'node:worker_threads'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { makeTerminalHostServer } from './server'
import { makeTerminalHostSessions } from './sessions'

export interface EngineWorkerOptions {
  readonly runtimeDir: string
  readonly launcherPath: string
  readonly sessionExecutable: string
  readonly journalLimitBytes: number | undefined
  readonly hostId: string
  readonly hostKey: string
  readonly token: string
  readonly socketPath: string
  readonly recordPath: string
}

// SAFETY: Only the daemon creates this worker, with EngineWorkerOptions.
const options = workerData as EngineWorkerOptions
const port = parentPort!
const stop = Effect.async<void>((resume) => {
  const shutdown = () => resume(Effect.void)
  port.once('message', shutdown)
  return Effect.sync(() => port.off('message', shutdown))
})

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* makeTerminalHostSessions(options)
      yield* makeTerminalHostServer({
        ...options,
        sessions,
        embedded: true,
        binaryOutput: true
      })
      // Install shutdown before advertising readiness, including startup cancellation.
      const stopped = yield* Effect.forkScoped(stop)
      port.postMessage('ready')
      yield* Fiber.join(stopped)
    })
  )
).finally(() => port.close())
