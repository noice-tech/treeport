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
  loadConfig,
  SpawnCommandRunner,
  TreeportService
} from './core/index'
import { createApp } from './app'
import { ApplicationDaemons } from './core/services/infrastructure/application-runtime'
import { createApplicationUpdateManager } from './application-update'
import { BrowserSessionManager } from './browser-sessions'
import { acquireDaemonOwnership } from './daemon-ownership'
import {
  authenticatedPrincipals,
  authorizeRequest,
  rejectHttpRequest
} from './request-security'
import { WorkspacePresenceManager } from './workspace-presence'
import { createSocketServer } from './socket-server'
import { makeRpcHttpApp } from './rpc-server'
import { acquireTerminalMetadataManager } from './terminal-metadata'
import { connectOrStartTerminalHost } from './terminal-host-client'

async function main(): Promise<void> {
  const config = loadConfig()
  process.title = config.webDevelopment
    ? 'treeport-server-dev'
    : 'treeport-server'
  const resourceScope = await Effect.runPromise(Scope.make())

  try {
    const ownership = await Effect.runPromise(
      Scope.extend(acquireDaemonOwnership(config), resourceScope)
    )
    const runner = new SpawnCommandRunner()
    const prerequisites = await Effect.runPromise(
      checkRuntimePrerequisites(config, runner)
    )
    const launcherPath = fileURLToPath(
      new URL('./core/launcher.js', import.meta.url)
    )
    const terminalHost = await Effect.runPromise(
      Scope.extend(
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
        }),
        resourceScope
      )
    )
    const service = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.sync(
            () => new TreeportService({ config, runner, terminalHost })
          ),
          (application) =>
            Effect.tryPromise(() =>
              application.runEffect(application.drainMutations())
            )
              .pipe(Effect.orDie)
              .pipe(
                Effect.ensuring(
                  Effect.tryPromise(() => application.disposeRuntime()).pipe(
                    Effect.orDie
                  )
                )
              )
        ).pipe(
          Effect.tap((application) =>
            Effect.tryPromise(() =>
              application.runEffect(application.initialize())
            ).pipe(Effect.orDie)
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
          (sessions) =>
            Effect.tryPromise(() => sessions.dispose()).pipe(Effect.orDie)
        ),
        resourceScope
      )
    )

    const presence = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.sync(() => new WorkspacePresenceManager(service.events)),
          (manager) => Effect.sync(() => manager.dispose())
        ),
        resourceScope
      )
    )
    const rpcHttpApp = await service.runEffect(
      Scope.extend(
        makeRpcHttpApp(service, terminalMetadata, presence),
        resourceScope
      )
    )
    const app = createApp({
      service,
      config,
      terminalHost,
      applicationUpdate,
      terminalMetadata,
      browserSessions,
      presence,
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

              if (security.principal) {
                authenticatedPrincipals.set(request, security.principal)
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
            Effect.tryPromise(() =>
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
            ).pipe(Effect.orDie),
            (developmentServer) =>
              Effect.tryPromise(() => developmentServer.close()).pipe(
                Effect.orDie
              )
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
          (sockets) =>
            Effect.tryPromise(() => sockets.close()).pipe(Effect.orDie)
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
    await Effect.runPromise(ownership.publish())
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
    await Effect.runPromise(Scope.close(resourceScope, Exit.fail(error)))
    throw error
  }
}

await main()
