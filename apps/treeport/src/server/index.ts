import fs from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { NodeHttpServer } from '@effect/platform-node'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import type { ViteDevServer } from 'vite'
import { z } from 'zod'
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

const updateStartupTransactionSchema = z.looseObject({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  ownerPid: z.number().int().positive(),
  createdAt: z.number().int().positive()
})

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // SAFETY: Node reports process signaling failures as ErrnoException objects.
    return (cause as NodeJS.ErrnoException).code === 'EPERM'
  }
}

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
              application.runEffect(application.prepareStartup())
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

    const startupDescriptorPath = path.join(
      config.dataDir,
      'updates',
      'startup-transaction.json'
    )
    const startupDescriptor = await fs
      .readFile(startupDescriptorPath, 'utf8')
      .then((source) =>
        updateStartupTransactionSchema.safeParse(JSON.parse(source))
      )
      .catch(() => null)
    const requestedTransaction =
      process.env.TREEPORT_UPDATE_STARTUP_TRANSACTION?.trim()
    const externallyVerifiedStartup =
      startupDescriptor?.success &&
      Date.now() - startupDescriptor.data.createdAt < 5 * 60_000 &&
      processExists(startupDescriptor.data.ownerPid) &&
      (!requestedTransaction ||
        requestedTransaction === startupDescriptor.data.operationId)
        ? startupDescriptor.data
        : null

    // Ordinary starts commit after all daemon subsystems and the listener are
    // ready. An updater-owned start keeps a newly created host provisional
    // until its separate health verification commits the transaction below.
    if (!externallyVerifiedStartup) {
      await Effect.runPromise(terminalHost.commitStartup())
      await service.runEffect(service.activateStartup())
    }

    await Effect.runPromise(ownership.publish())
    if (externallyVerifiedStartup) {
      const requestPath = path.join(
        config.dataDir,
        'updates',
        `startup-commit-${externallyVerifiedStartup.operationId}`
      )
      const acknowledgementPath = `${requestPath}.ack`
      await Effect.runPromise(
        Scope.extend(
          Effect.forkScoped(
            Effect.gen(function* () {
              while (true) {
                const commitRequested = yield* Effect.tryPromise(() =>
                  fs.access(requestPath)
                ).pipe(
                  Effect.as(true),
                  Effect.catchAll(() => Effect.succeed(false))
                )
                if (commitRequested) {
                  yield* terminalHost.commitStartup()
                  yield* Effect.tryPromise(() =>
                    service.runEffect(service.activateStartup())
                  ).pipe(Effect.orDie)
                  yield* Effect.tryPromise(() =>
                    fs.writeFile(acknowledgementPath, 'committed\n', {
                      mode: 0o600
                    })
                  )
                  yield* Effect.tryPromise(() =>
                    fs.rm(requestPath, { force: true })
                  )
                  return
                }

                const transactionStillOwned = yield* Effect.tryPromise(() =>
                  fs
                    .readFile(startupDescriptorPath, 'utf8')
                    .then((source) =>
                      updateStartupTransactionSchema.safeParse(
                        JSON.parse(source)
                      )
                    )
                    .then(
                      (parsed) =>
                        parsed.success &&
                        parsed.data.operationId ===
                          externallyVerifiedStartup.operationId &&
                        parsed.data.ownerPid ===
                          externallyVerifiedStartup.ownerPid &&
                        processExists(parsed.data.ownerPid)
                    )
                ).pipe(Effect.catchAll(() => Effect.succeed(false)))
                if (!transactionStillOwned) {
                  yield* terminalHost.abortStartup()
                  yield* Effect.sync(shutdown)
                  return
                }

                yield* Effect.sleep(50)
              }
            }).pipe(Effect.orDie)
          ),
          resourceScope
        )
      )
    }

    await service.runEffect(
      Effect.flatMap(ApplicationDaemons, (daemons) =>
        daemons.fork(applicationUpdate.polling)
      )
    )

    console.log(`Treeport ${config.appVersion} listening on ${config.apiUrl}`)
    console.log(`database: ${config.databasePath}`)
    console.log(`git: ${prerequisites.gitVersion}`)
    console.log(`terminal host: ${terminalHost.record.pid}`)
  } catch (error) {
    await Effect.runPromise(Scope.close(resourceScope, Exit.fail(error)))
    throw error
  }
}

await main()
