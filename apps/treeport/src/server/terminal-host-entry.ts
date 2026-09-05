import { TerminalHostSessionManager } from './terminal-host-sessions'
import {
  startTerminalHostServer,
  type TerminalHostServerOptions
} from './terminal-host-server'
import { makeHostTraceRuntime } from './tracing'

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required`)
  }

  return value
}

async function main(): Promise<void> {
  const runtimeDir = requiredEnvironment('TREEPORT_TERMINAL_HOST_RUNTIME_DIR')
  const launcherPath = requiredEnvironment('TREEPORT_TERMINAL_HOST_LAUNCHER')
  const sessions = new TerminalHostSessionManager(runtimeDir, launcherPath)
  const traceRuntime = makeHostTraceRuntime(
    process.env.TREEPORT_APP_VERSION ?? 'unknown'
  )
  const trace: TerminalHostServerOptions['trace'] = traceRuntime
    ? (name, parent, attributes, evaluate) =>
        traceRuntime.run(name, parent, attributes, evaluate)
    : undefined
  const options: TerminalHostServerOptions = {
    hostId: requiredEnvironment('TREEPORT_TERMINAL_HOST_ID'),
    hostKey: requiredEnvironment('TREEPORT_TERMINAL_HOST_KEY'),
    token: requiredEnvironment('TREEPORT_TERMINAL_HOST_TOKEN'),
    socketPath: requiredEnvironment('TREEPORT_TERMINAL_HOST_SOCKET'),
    recordPath: requiredEnvironment('TREEPORT_TERMINAL_HOST_RECORD'),
    sessions,
    onShutdown: async () => {
      await sessions.shutdown()
      await traceRuntime?.dispose()
      process.exit(0)
    }
  }
  if (trace) {
    options.trace = trace
  }

  const host = await startTerminalHostServer(options)

  let stopping = false
  const stop = () => {
    if (stopping) {
      return
    }

    stopping = true
    void host
      .close()
      .then(() => sessions.shutdown())
      .then(() => traceRuntime?.dispose())
      .then(
        () => process.exit(0),
        (error) => {
          console.error(
            '[Treeport terminal host] Shutdown failed:',
            error instanceof Error ? error.message : String(error)
          )
          process.exit(1)
        }
      )
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

await main()
