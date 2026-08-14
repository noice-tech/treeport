import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import type { ViteDevServer } from 'vite'
import {
  checkRuntimePrerequisites,
  GhAdapter,
  GitAdapter,
  loadConfig,
  SpawnCommandRunner,
  TmuxAdapter,
  openDatabase,
  TreeportService
} from './core/index'
import { createApp } from './app'
import { acquireDaemonOwnership } from './daemon-ownership'
import { createSocketServer } from './socket-server'
import { TerminalMetadataManager } from './terminal-metadata'

const config = loadConfig()
const ownership = await acquireDaemonOwnership(config)
const prerequisites = await checkRuntimePrerequisites(config)
const runner = new SpawnCommandRunner()
const database = await openDatabase(config.databasePath, {
  backupDirectory: path.join(config.dataDir, 'database-backups')
})
const git = new GitAdapter(runner, config.gitPath)
const launcherPath = fileURLToPath(
  new URL('./core/launcher.js', import.meta.url)
)
const tmux = new TmuxAdapter(
  runner,
  config.runtimeDir,
  config.tmuxPath,
  launcherPath
)
const gh = new GhAdapter(runner, config.ghPath)
const service = new TreeportService({ config, database, runner, git, tmux, gh })
await service.initialize()
const terminalMetadata = new TerminalMetadataManager(
  service,
  tmux,
  config.tmuxPath
)
await terminalMetadata.initialize()

const app = createApp({ service, config, tmux, terminalMetadata })
const honoListener = getRequestListener(app.fetch)
let vite: ViteDevServer | null = null
const server = createServer((request, response) => {
  service.handleWebPanelDevelopmentRequest(request, response, () => {
    if (vite && !request.url?.startsWith('/api')) {
      vite.middlewares(request, response, () => {
        honoListener(request, response)
      })
      return
    }

    honoListener(request, response)
  })
})
if (config.webDevelopment) {
  const { createServer: createViteServer } = await import('vite')
  vite = await createViteServer({
    configFile: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../vite.config.ts'
    ),
    appType: 'spa',
    server: {
      middlewareMode: true,
      hmr: { server }
    }
  })
}

service.attachHttpServer(server)
const { io, attachments } = createSocketServer(server, {
  service,
  config,
  tmux,
  terminalMetadata
})
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(config.port, config.host, () => {
    server.off('error', reject)
    resolve()
  })
})
await ownership.publish()

console.log(`Treeport ${config.appVersion} listening on ${config.apiUrl}`)
console.log(`database: ${config.databasePath}`)
console.log(`git: ${prerequisites.gitVersion}`)
console.log(`tmux: ${prerequisites.tmuxVersion}`)
if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
  console.warn(
    'Authentication is disabled; anyone who can reach this address has full terminal access.'
  )
}

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  attachments.dispose()
  terminalMetadata.dispose()
  io.close(() => {
    void Promise.all([service.drainMutations(), terminalMetadata.drain()]).then(
      async () => {
        await service.disposeWebPanelRuntime()
        await vite?.close()
        database.close()
        await ownership.release()
        process.exit(0)
      }
    )
  })
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
