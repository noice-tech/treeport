import { Worker } from 'node:worker_threads'
import * as Effect from 'effect/Effect'
import type { EngineWorkerOptions } from '../terminal-runtime/engine-worker'
import { TerminalHostConnectionError } from '../terminal-runtime/api'

/** The emulator shares the daemon lifetime, but never its JavaScript thread. */
export function startTerminalEngineWorker(
  entry: string,
  options: EngineWorkerOptions,
  environment: NodeJS.ProcessEnv
) {
  return Effect.gen(function* () {
    const state = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const worker = new Worker(entry, {
            workerData: options,
            env: environment,
            execArgv: []
          })

          let ready = false
          let exited = false

          const stopped = new Promise<void>((resolve) => {
            worker.once('exit', () => {
              exited = true
              resolve()
            })
          })

          const started = new Promise<void>((resolve, reject) => {
            worker.once('message', (message: 'ready') => {
              if (message === 'ready') {
                ready = true
                resolve()
              } else {
                reject(new Error('Invalid terminal engine readiness message'))
              }
            })
            // Keep the error listener for the worker's whole lifetime. Once ready,
            // its socket closing propagates failure to terminal clients.
            worker.on('error', reject)
            worker.once('exit', (code) => {
              if (!ready) {
                reject(
                  new Error(`Terminal engine exited during startup (${code})`)
                )
              }
            })
          })

          return { worker, started, stopped, hasExited: () => exited }
        },
        catch: (cause) => new TerminalHostConnectionError({ cause })
      }),
      ({ worker, stopped, hasExited }) =>
        Effect.promise(async () => {
          if (hasExited()) {
            return
          }

          worker.postMessage('stop')

          const deadline = setTimeout(() => {
            void worker.terminate()
          }, 5_000)

          await stopped.finally(() => clearTimeout(deadline))
        })
    )

    yield* Effect.tryPromise({
      try: () => state.started,
      catch: (cause) => new TerminalHostConnectionError({ cause })
    }).pipe(
      Effect.timeoutFail({
        duration: 10_000,
        onTimeout: () =>
          new TerminalHostConnectionError({
            cause: new Error('Terminal engine startup timed out')
          })
      })
    )
  })
}
