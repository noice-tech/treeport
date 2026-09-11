import { NodeRuntime } from '@effect/platform-node'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { makeTerminalHostSessions } from './terminal-host-sessions'
import { makeTerminalHostServer } from './terminal-host-server'
import { tracingLayerFromEnvironment } from './tracing'

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
  const socketPath = yield* required('TREEPORT_TERMINAL_HOST_SOCKET')
  const recordPath = yield* required('TREEPORT_TERMINAL_HOST_RECORD')
  const appVersion = yield* Config.string('TREEPORT_APP_VERSION').pipe(
    Config.withDefault('unknown')
  )

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
        socketPath,
        recordPath,
        sessions
      })
      yield* Effect.raceFirst(host.shutdown, signal)
    })
  ).pipe(
    Effect.provide(
      tracingLayerFromEnvironment('treeport-terminal-host', appVersion)
    )
  )
})

NodeRuntime.runMain(program)
