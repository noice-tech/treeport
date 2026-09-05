import { createServer, type IncomingMessage } from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { NodeHttpServer } from '@effect/platform-node'
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
import { makeRpcHttpApp } from './rpc-server'
import { acquireTerminalMetadataManager } from './terminal-metadata'
import { createUpdateStartupReporter } from './update-startup'
import { connectOrStartTerminalHost } from './terminal-host-client'

async function main(): Promise<void> {
  const config = loadConfig()
  process.title = config.webDevelopment
    ? 'treeport-server-dev'
    : 'treeport-server'
  let updateStartup: Awaited<
    ReturnType<typeof createUpdateStartupReporter>
  > | null = null
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
    updateStartup = await createUpdateStartupReporter(config)
    const prerequisites = await checkRuntimePrerequisites(config)
    const runner = new SpawnCommandRunner()
    await updateStartup.databaseOpening()
    const database = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.promise(() =>
            openDatabase(config.databasePath, {
              backupDirectory: path.join(config.dataDir, 'database-backups'),
              onMigrationSnapshot: async (snapshotPath) => {
                console.log(`Pre-migration snapshot: ${snapshotPath}`)
                await updateStartup!.snapshotCreated(snapshotPath)
              }
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
              ),
              environment: {
                ...process.env,
                TREEPORT_APP_VERSION: config.appVersion
              }
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
    const terminalMetadata = await service.runEffect(
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

    const rpcHttpApp = await service.runEffect(
      Scope.extend(makeRpcHttpApp(service, terminalMetadata), resourceScope)
    )
    const app = createApp({
      service,
      config,
      terminalHost,
      applicationUpdate,
      terminalMetadata,
      browserSessions,
      rpcHttpApp
    })
    const effectListener = await service.runEffect(
      NodeHttpServer.makeHandler(app.httpApp)
    )
    let vite: ViteDevServer | null = null
    let viteUpgrade:
      | ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)
      | null = null
    const server = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.sync(() =>
            createServer((request, response) => {
              const security = authorizeRequest(request)
              if (!security.allowed) {
                rejectHttpRequest(request, response, security)
                return
              }

              service.handleWebPanelDevelopmentRequest(
                request,
                response,
                () => {
                  if (vite && !request.url?.startsWith('/api')) {
                    vite.middlewares(request, response, () => {
                      effectListener(request, response)
                    })
                    return
                  }

                  effectListener(request, response)
                }
              )
            })
          ),
          (httpServer) =>
            Effect.async<void>((resume) => {
              if (!httpServer.listening) {
                resume(Effect.void)
                return
              }

              httpServer.close(() => resume(Effect.void))
            })
        ),
        resourceScope
      )
    )
    let socketServer: ReturnType<typeof createSocketServer> | null = null
    server.on('upgrade', (request, socket, head) => {
      const security = authorizeRequest(request, { socketUpgrade: true })
      if (security.allowed) {
        if (socketServer?.handleUpgrade(request, socket, head)) {
          return
        }

        if (service.handleWebPanelDevelopmentUpgrade(request, socket, head)) {
          return
        }

        const pathname = new URL(request.url ?? '/', 'http://treeport.local')
          .pathname
        if (pathname === '/@vite-hmr' && viteUpgrade) {
          viteUpgrade(request, socket, head)
          return
        }

        socket.destroy()
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
      const previousUpgradeListeners = new Set(server.listeners('upgrade'))
      vite = await Effect.runPromise(
        Scope.extend(
          Effect.acquireRelease(
            Effect.promise(() =>
              createViteServer({
                configFile: path.resolve(
                  path.dirname(fileURLToPath(import.meta.url)),
                  '../../../vite.config.ts'
                ),
                appType: 'spa',
                server: {
                  middlewareMode: true,
                  hmr: { server, path: '/@vite-hmr' }
                }
              })
            ),
            (developmentServer) =>
              Effect.promise(() => developmentServer.close())
          ),
          resourceScope
        )
      )
      const addedUpgradeListeners = server
        .listeners('upgrade')
        .filter((listener) => !previousUpgradeListeners.has(listener))
      if (addedUpgradeListeners.length !== 1) {
        throw new Error('Vite did not register one HMR upgrade handler')
      }

      // SAFETY: Vite registered this listener on Node's upgrade event above.
      viteUpgrade = addedUpgradeListeners[0] as (
        request: IncomingMessage,
        socket: Duplex,
        head: Buffer
      ) => void
      server.removeListener('upgrade', viteUpgrade)
    }

    service.attachHttpServer(server)
    const socketDependencies: Parameters<typeof createSocketServer>[0] = {
      service,
      config,
      terminalMetadata,
      terminalHost,
      browserSessions
    }

    socketServer = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.sync(() => createSocketServer(socketDependencies)),
          (sockets) => Effect.promise(() => sockets.close())
        ),
        resourceScope
      )
    )
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
      void Effect.runPromise(Scope.close(resourceScope, Exit.void)).then(() =>
        process.exit(0)
      )
      setTimeout(() => {
        server.closeAllConnections()
        process.exit(1)
      }, 5_000).unref()
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch (error) {
    await (
      updateStartup?.failed(
        error instanceof Error ? error : new Error(String(error))
      ) ?? Promise.resolve()
    ).finally(() =>
      Effect.runPromise(Scope.close(resourceScope, Exit.fail(error)))
    )
    throw error
  }
}

await main()
