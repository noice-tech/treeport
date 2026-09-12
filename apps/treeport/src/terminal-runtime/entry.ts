import { NodeRuntime } from '@effect/platform-node'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { makeTerminalHostServer } from './server'
import { makeTerminalHostSessions } from './sessions'

const required = (name: string) => Config.nonEmptyString(name)

const signal = Effect.async<void>((resume) => {
  const stop = () => resume(Effect.void)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return Effect.sync(() => {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  })
})

const program = Effect.gen(function* () {
  const runtimeDir = yield* required('TREEPORT_TERMINAL_HOST_RUNTIME_DIR')
  const launcherPath = yield* required('TREEPORT_TERMINAL_HOST_LAUNCHER')
  const hostId = yield* required('TREEPORT_TERMINAL_HOST_ID')
  const hostKey = yield* required('TREEPORT_TERMINAL_HOST_KEY')
  const token = yield* required('TREEPORT_TERMINAL_HOST_TOKEN')
  const tokenPath = yield* required('TREEPORT_TERMINAL_HOST_TOKEN_PATH')
  const socketPath = yield* required('TREEPORT_TERMINAL_HOST_SOCKET')
  const recordPath = yield* required('TREEPORT_TERMINAL_HOST_RECORD')
  const startupTransactionId = yield* Config.string(
    'TREEPORT_TERMINAL_HOST_STARTUP_TRANSACTION'
  ).pipe(Config.option)

  yield* Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* makeTerminalHostSessions({
        runtimeDir,
        launcherPath
      })
      const host = yield* makeTerminalHostServer({
        hostId,
        hostKey,
        token,
        tokenPath,
        socketPath,
        recordPath,
        sessions,
        launcherPath,
        startupTransactionId:
          startupTransactionId._tag === 'Some'
            ? startupTransactionId.value
            : undefined
      })
      yield* Effect.raceFirst(host.shutdown, signal)
    })
  )
})

NodeRuntime.runMain(program)
