import crypto from 'node:crypto'
import fs from 'node:fs/promises'
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
import { createApplicationUpdateManager } from './application-update'
import { BrowserSessionManager } from './browser-sessions'
import { acquireDaemonOwnership } from './daemon-ownership'
import { authorizeRequest, rejectHttpRequest } from './request-security'
import { createSocketServer } from './socket-server'
import { TerminalMetadataManager } from './terminal-metadata'
import { createUpdateStartupReporter } from './update-startup'

async function main(): Promise<void> {
  const config = loadConfig()
  const updateStartup = await createUpdateStartupReporter(config)

  try {
    const ownership = await acquireDaemonOwnership(config)
    const prerequisites = await checkRuntimePrerequisites(config)
    const runner = new SpawnCommandRunner()
    await updateStartup.databaseOpening()
    const database = await openDatabase(config.databasePath, {
      backupDirectory: path.join(config.dataDir, 'database-backups')
    })
    await updateStartup.databaseOpened({
      migrationState: database.migrationState,
      snapshotPaths: database.migrationSnapshotPaths
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
    const trustedHostBrowserPackageIds =
      config.installationMethod === 'development'
        ? await Promise.all(
            [
              path.resolve(process.cwd(), 'packages/web-panel-browser'),
              path.resolve(process.cwd(), '../../packages/web-panel-browser')
            ].map(async (source) => {
              const canonical = await fs.realpath(source).catch(() => source)
              return `local:${crypto
                .createHash('sha256')
                .update(canonical)
                .digest('hex')
                .slice(0, 16)}`
            })
          )
        : []
    const service = new TreeportService({
      config,
      database,
      runner,
      git,
      tmux,
      gh,
      trustedHostBrowserPackageIds
    })
    await service.initialize()
    const terminalMetadata = new TerminalMetadataManager(
      service,
      tmux,
      config.tmuxPath
    )
    await terminalMetadata.initialize()
    const applicationUpdate = createApplicationUpdateManager(config)
    const browserSessions = new BrowserSessionManager(service, config)

    const app = createApp({
      service,
      config,
      tmux,
      applicationUpdate,
      terminalMetadata,
      browserSessions
    })
    const honoListener = getRequestListener(app.fetch)
    let vite: ViteDevServer | null = null
    const server = createServer((request, response) => {
      const security = authorizeRequest(request)
      if (!security.allowed) {
        rejectHttpRequest(request, response, security)
        return
      }

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
    server.on('upgrade', (request, socket) => {
      const security = authorizeRequest(request, { socketUpgrade: true })
      if (security.allowed) {
        return
      }

      const statusText =
        security.status === 400
          ? 'Bad Request'
          : security.status === 403
            ? 'Forbidden'
            : 'Unauthorized'
      socket.write(
        `HTTP/1.1 ${security.status} ${statusText}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`
      )
      socket.destroy()
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
      terminalMetadata,
      browserSessions
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await ownership.publish()
    await updateStartup.ready()
    applicationUpdate.beginPolling()

    console.log(`Treeport ${config.appVersion} listening on ${config.apiUrl}`)
    console.log(`database: ${config.databasePath}`)
    console.log(`git: ${prerequisites.gitVersion}`)
    console.log(`tmux: ${prerequisites.tmuxVersion}`)

    let shuttingDown = false
    function shutdown(): void {
      if (shuttingDown) {
        return
      }

      shuttingDown = true
      applicationUpdate.dispose()
      attachments.dispose()
      terminalMetadata.dispose()
      const viteClosed = vite?.close()
      io.close(() => {
        void Promise.all([
          service.drainMutations(),
          terminalMetadata.drain(),
          viteClosed
        ]).then(async () => {
          await browserSessions.dispose()
          await service.disposeWebPanelRuntime()
          database.close()
          await ownership.release()
          process.exit(0)
        })
      })
      setTimeout(() => process.exit(1), 5_000).unref()
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch (error) {
    await updateStartup.failed(
      error instanceof Error ? error : new Error(String(error))
    )
    throw error
  }
}

await main()
