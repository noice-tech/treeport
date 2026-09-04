import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import type { ViteDevServer } from 'vite'
import {
  checkRuntimePrerequisites,
  GhAdapter,
  GitAdapter,
  loadConfig,
  SpawnCommandRunner,
  openDatabase,
  TreeportService
} from './core/index'
import { createApp } from './app'
import { ApplicationDaemons } from './core/services/infrastructure/application-runtime'
import { createApplicationUpdateManager } from './application-update'
import { BrowserSessionManager } from './browser-sessions'
import { acquireDaemonOwnership } from './daemon-ownership'
import { authorizeRequest, rejectHttpRequest } from './request-security'
import { createSocketServer } from './socket-server'
import { acquireTerminalMetadataManager } from './terminal-metadata'
import { createUpdateStartupReporter } from './update-startup'
import { connectOrStartTerminalHost } from './terminal-host-client'

async function main(): Promise<void> {
  const config = loadConfig()
  process.title = config.webDevelopment
    ? 'treeport-server-dev'
    : 'treeport-server'
  const updateStartup = await createUpdateStartupReporter(config)
  const resourceScope = await Effect.runPromise(Scope.make())

  try {
    const ownership = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.promise(() => acquireDaemonOwnership(config)),
          (owned) => Effect.promise(() => owned.release())
        ),
        resourceScope
      )
    )
    const prerequisites = await checkRuntimePrerequisites(config)
    const runner = new SpawnCommandRunner()
    await updateStartup.databaseOpening()
    const database = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.promise(() =>
            openDatabase(config.databasePath, {
              backupDirectory: path.join(config.dataDir, 'database-backups')
            })
          ),
          (opened) => Effect.sync(() => opened.close())
        ),
        resourceScope
      )
    )
    await updateStartup.databaseOpened({
      migrationState: database.migrationState,
      snapshotPaths: database.migrationSnapshotPaths
    })
    const git = new GitAdapter(runner, config.gitPath)
    const launcherPath = fileURLToPath(
      new URL('./core/launcher.js', import.meta.url)
    )
    const gh = new GhAdapter(runner, config.ghPath)
    const terminalHost = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.promise(() =>
            connectOrStartTerminalHost({
              dataDir: config.dataDir,
              runtimeDir: config.runtimeDir,
              launcherPath,
              hostEntryPath: fileURLToPath(
                new URL('./terminal-host-entry.js', import.meta.url)
              )
            })
          ),
          (host) => Effect.sync(() => host.dispose())
        ),
        resourceScope
      )
    )
    const service = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.sync(
            () =>
              new TreeportService({
                config,
                database,
                runner,
                git,
                terminalHost,
                gh
              })
          ),
          (application) =>
            Effect.promise(() =>
              application.runEffect(application.drainMutations())
            ).pipe(
              Effect.ensuring(
                Effect.promise(() => application.disposeRuntime())
              )
            )
        ).pipe(
          Effect.tap((application) =>
            Effect.promise(() =>
              application.runEffect(application.initialize())
            )
          )
        ),
        resourceScope
      )
    )
    const terminalMetadata = await Effect.runPromise(
      Scope.extend(
        acquireTerminalMetadataManager(service, terminalHost),
        resourceScope
      )
    )
    const applicationUpdate = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.sync(() => createApplicationUpdateManager(config)),
          (manager) => Effect.sync(() => manager.dispose())
        ),
        resourceScope
      )
    )
    const browserSessions = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.sync(() => new BrowserSessionManager(service, config)),
          (sessions) => Effect.promise(() => sessions.dispose())
        ),
        resourceScope
      )
    )

    const app = createApp({
      service,
      config,
      terminalHost,
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
    const socketDependencies: Parameters<typeof createSocketServer>[1] = {
      service,
      config,
      terminalMetadata,
      terminalHost,
      browserSessions
    }

    const { io, attachments } = createSocketServer(server, socketDependencies)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await ownership.publish()
    await updateStartup.ready()
    await service.runEffect(
      Effect.flatMap(ApplicationDaemons, (daemons) =>
        daemons.fork(applicationUpdate.polling)
      )
    )

    console.log(`Treeport ${config.appVersion} listening on ${config.apiUrl}`)
    console.log(`database: ${config.databasePath}`)
    console.log(`git: ${prerequisites.gitVersion}`)
    console.log(`terminal host: ${terminalHost.record.pid}`)

    let shuttingDown = false
    function shutdown(): void {
      if (shuttingDown) {
        return
      }

      shuttingDown = true
      attachments.dispose()
      const viteClosed = vite?.close()
      io.close(() => {
        void Promise.resolve(viteClosed)
          .then(() => Effect.runPromise(Scope.close(resourceScope, Exit.void)))
          .then(() => process.exit(0))
      })
      setTimeout(() => process.exit(1), 5_000).unref()
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch (error) {
    await Effect.runPromise(Scope.close(resourceScope, Exit.fail(error)))
    await updateStartup.failed(
      error instanceof Error ? error : new Error(String(error))
    )
    throw error
  }
}

await main()
