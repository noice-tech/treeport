import fs from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { NodeHttpServer } from '@effect/platform-node'
import { getSessionKeeperPayload } from '@treeport/session-keeper'
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
import type { installDaemonDiagnostics } from './daemon-diagnostics'
import {
  authenticatedViewers,
  authorizeRequest,
  rejectHttpRequest
} from './request-security'
import { WorkspacePresenceManager } from './workspace-presence'
import { createSocketServer } from './socket-server'
import { createBrowserDevtoolsBridge } from './browser-devtools'
import { makeRpcHttpApp } from './rpc-server'
import { acquireTerminalMetadataManager } from './terminal-metadata'
import { connectOrStartTerminalHost } from './terminal-host-client'
import { observeDaemonEventLoop } from './network-telemetry'
import { WebPushManager } from './web-push'
import { AppServices } from './app-services'
import { PackageSystemPort } from './core/services/infrastructure/ports'

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

export async function main(
  diagnostics: ReturnType<typeof installDaemonDiagnostics>,
  entrypoint: URL
): Promise<void> {
  const config = loadConfig()
  const journalLimitBytes =
    process.env.TREEPORT_TERMINAL_JOURNAL_LIMIT_BYTES === undefined
      ? undefined
      : Number(process.env.TREEPORT_TERMINAL_JOURNAL_LIMIT_BYTES)
  if (
    journalLimitBytes !== undefined &&
    (!Number.isSafeInteger(journalLimitBytes) || journalLimitBytes <= 0)
  ) {
    throw new Error(
      'TREEPORT_TERMINAL_JOURNAL_LIMIT_BYTES must be a positive safe integer'
    )
  }

  process.title = config.webDevelopment
    ? 'treeport-server-dev'
    : 'treeport-server'
  const resourceScope = await Effect.runPromise(Scope.make())
  await Effect.runPromise(
    Scope.extend(
      Effect.acquireRelease(Effect.sync(observeDaemonEventLoop), (stop) =>
        Effect.sync(stop)
      ),
      resourceScope
    )
  )

  try {
    const ownership = await Effect.runPromise(
      Scope.extend(acquireDaemonOwnership(config), resourceScope)
    )
    const runner = new SpawnCommandRunner()
    const prerequisites = await Effect.runPromise(
      checkRuntimePrerequisites(config, runner)
    )
    const launcherPath = fileURLToPath(
      new URL('./core/launcher.js', entrypoint)
    )
    const terminalHost = await Effect.runPromise(
      Scope.extend(
        connectOrStartTerminalHost({
          dataDir: config.dataDir,
          runtimeDir: config.runtimeDir,
          launcherPath,
          engineWorkerPath: fileURLToPath(
            new URL('./terminal-engine-worker.js', entrypoint)
          ),
          sessionExecutable: getSessionKeeperPayload(),
          journalLimitBytes,
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
          Effect.sync(
            () =>
              new BrowserSessionManager(service, {
                ...config,
                browserRelayEntry: fileURLToPath(
                  new URL('./browser-relay.js', entrypoint)
                )
              })
          ),
          (sessions) =>
            Effect.tryPromise(() => sessions.dispose()).pipe(Effect.orDie)
        ),
        resourceScope
      )
    )

    const appServices = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.sync(
            () =>
              new AppServices({
                apiUrl: config.apiUrl,
                dataDir: config.dataDir,
                declarations: () =>
                  service.runEffect(
                    Effect.flatMap(PackageSystemPort, (packages) =>
                      packages.services()
                    )
                  ),
                pruneDecorationSources: (sources) =>
                  service.runEffect(
                    service.projects.pruneDecorationSources(sources)
                  ),
                log: (message) => console.warn(message)
              })
          ),
          (manager) =>
            Effect.tryPromise(() => manager.dispose()).pipe(Effect.orDie)
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
    const push = await Effect.runPromise(
      Scope.extend(
        Effect.acquireRelease(
          Effect.tryPromise(() => WebPushManager.open(config.dataDir)).pipe(
            Effect.orDie
          ),
          (manager) =>
            Effect.tryPromise(() => manager.dispose()).pipe(Effect.orDie)
        ),
        resourceScope
      )
    )
    const pendingAttention = new Set<string>()
    const unsubscribePush = terminalMetadata.subscribeLiveAttention(
      (metadata) => {
        const terminalId = metadata.terminalId
        if (
          !push.hasSubscriptions ||
          pendingAttention.has(terminalId) ||
          pendingAttention.size >= 256
        ) {
          return
        }

        pendingAttention.add(terminalId)
        service.forkApplicationEffect(
          Effect.gen(function* () {
            // Let focused clients acknowledge attention before sending. Coalesce
            // bursts, but never hide a received push in the worker (iOS revokes it).
            yield* Effect.sleep('750 millis')
            const current = terminalMetadata.get(terminalId)
            const { attention } = current
            if (!attention?.unread || !push.hasSubscriptions) {
              return
            }

            const status =
              attention.reason === 'bell'
                ? 'Terminal needs attention'
                : (current.activity.message ??
                  {
                    done: 'Finished',
                    blocked: 'Needs your input',
                    error: 'Failed'
                  }[attention.reason])

            const terminal = yield* service.terminals.getTerminal(terminalId)
            const worktree = yield* service.projects.getWorktree(
              terminal.worktreeId
            )
            yield* Effect.tryPromise(() =>
              push.notify(
                {
                  title: current.title ?? terminal.name,
                  // Name the worktree: status text comes from the program.
                  body: `${status} · ${worktree.name}`,
                  url: `/projects/${encodeURIComponent(worktree.projectId)}/worktrees/${encodeURIComponent(worktree.id)}/terminals/${encodeURIComponent(terminalId)}`,
                  tag: `treeport-attention:${terminalId}`
                },
                presence.snapshot()
              )
            )
          }).pipe(
            Effect.catchAll(() =>
              Effect.logWarning('Terminal Web Push notification failed')
            ),
            Effect.ensuring(
              Effect.sync(() => {
                pendingAttention.delete(terminalId)
              })
            )
          )
        )
      }
    )
    await Effect.runPromise(
      Scope.extend(
        Effect.addFinalizer(() => Effect.sync(unsubscribePush)),
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
      appServices,
      presence,
      push,
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
                authenticatedViewers.set(request, {
                  account: security.principal,
                  deviceId: security.deviceId
                })
              }

              if (appServices.handleRequest(request, response)) {
                return
              }

              service.handleWebAppDevelopmentRequest(request, response, () => {
                if (vite && !request.url?.startsWith('/api')) {
                  vite.middlewares(request, response, () => {
                    effectListener(request, response)
                  })
                  return
                }

                effectListener(request, response)
              })
            })
          ),
          (httpServer) =>
            // Upgraded service connections must close before server.close waits.
            Effect.tryPromise(() => appServices.dispose()).pipe(
              Effect.orDie,
              Effect.andThen(
                Effect.async<void>((resume) => {
                  if (!httpServer.listening) {
                    resume(Effect.void)
                    return
                  }

                  httpServer.close(() => resume(Effect.void))
                })
              )
            )
        ),
        resourceScope
      )
    )
    let socketServer: ReturnType<typeof createSocketServer> | null = null
    const devtoolsBridge = createBrowserDevtoolsBridge((appId) =>
      service.runEffect(browserSessions.devtoolsEndpoint(appId))
    )
    server.on('upgrade', (request, socket, head) => {
      if (devtoolsBridge.handleUpgrade(request, socket, head)) {
        return
      }

      const security = authorizeRequest(request, { socketUpgrade: true })
      if (security.allowed) {
        if (appServices.handleRequest(request, null, socket, head)) {
          return
        }

        if (socketServer?.handleUpgrade(request, socket, head)) {
          return
        }

        if (service.handleWebAppDevelopmentUpgrade(request, socket, head)) {
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
                  path.dirname(fileURLToPath(entrypoint)),
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
    function shutdown(signal: string): void {
      if (shuttingDown) {
        return
      }

      shuttingDown = true
      diagnostics.shutdown(signal)
      devtoolsBridge.close()
      // Stop accepting requests before slower subsystem finalizers run so a
      // completed development command cannot leave its port behind.
      server.close()
      void Effect.runPromise(Scope.close(resourceScope, Exit.void)).then(
        () => {
          diagnostics.event('shutdown_completed')
          process.exit(0)
        },
        (error) => {
          diagnostics.failed(
            inspect(error, { depth: 8, colors: false }),
            'shutdown'
          )
          process.exit(1)
        }
      )
      setTimeout(() => {
        diagnostics.event('shutdown_timeout', { timeoutMs: 5_000 })
        server.closeAllConnections()
        process.exit(1)
      }, 5_000).unref()
    }

    // Keep handlers installed while shutting down: supervisors and terminal
    // teardown often deliver the same signal twice, and the default action
    // would kill the daemon before the terminal engine releases its socket.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, () => shutdown(signal))
    }

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

    // Ordinary starts activate after all daemon subsystems and the listener
    // are ready. An updater-owned start waits until its separate health
    // verification commits the transaction below.
    if (!externallyVerifiedStartup) {
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
                  yield* Effect.sync(() =>
                    shutdown('startup_transaction_aborted')
                  )
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

    appServices.start()
    diagnostics.event('ready', { apiUrl: config.apiUrl })
    console.log(`Treeport ${config.appVersion} listening on ${config.apiUrl}`)
    console.log(`database: ${config.databasePath}`)
    console.log(`git: ${prerequisites.gitVersion}`)
    console.log(`terminal engine: ${terminalHost.record.pid}`)
  } catch (error) {
    diagnostics.failed(inspect(error, { depth: 8, colors: false }), 'startup')
    await Effect.runPromise(Scope.close(resourceScope, Exit.fail(error))).catch(
      (cleanupError) => {
        diagnostics.event('startup_cleanup_failed', {
          error: inspect(cleanupError, { depth: 8, colors: false })
        })
      }
    )
    throw error
  }
}
