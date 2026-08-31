import { TerminalHostSessionManager } from './terminal-host-sessions'
import { startTerminalHostServer } from './terminal-host-server'

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
  const host = await startTerminalHostServer({
    hostId: requiredEnvironment('TREEPORT_TERMINAL_HOST_ID'),
    hostKey: requiredEnvironment('TREEPORT_TERMINAL_HOST_KEY'),
    token: requiredEnvironment('TREEPORT_TERMINAL_HOST_TOKEN'),
    socketPath: requiredEnvironment('TREEPORT_TERMINAL_HOST_SOCKET'),
    recordPath: requiredEnvironment('TREEPORT_TERMINAL_HOST_RECORD'),
    sessions,
    onShutdown: async () => {
      await sessions.shutdown()
      process.exit(0)
    }
  })

  let stopping = false
  const stop = () => {
    if (stopping) {
      return
    }

    stopping = true
    void host.close().finally(async () => {
      await sessions.shutdown()
      process.exit(0)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

await main()
