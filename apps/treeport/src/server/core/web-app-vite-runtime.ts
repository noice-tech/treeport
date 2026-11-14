import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse
} from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { TLSSocket } from 'node:tls'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { createServer, type InlineConfig, type ViteDevServer } from 'vite'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { DomainError } from './domain.ts'
import {
  webAppBrowserOrigin,
  webAppContentSecurityPolicy
} from './web-app-csp.ts'

export interface ResolvedWebAppSource {
  root: string
  entry: string
  packageRoot: string
  definitionId: string
  packageSource?: string
  allowNetworkRequests: boolean
}

export type WebAppAssetResolution =
  | {
      kind: 'redirect'
      location: string
      allowNetworkRequests: boolean
    }
  | {
      kind: 'error'
      html: string
      allowNetworkRequests: boolean
    }

const APP_SDK_ENTRY = fileURLToPath(import.meta.resolve('@treeport/app-sdk'))
const APP_SDK_ROOT = path.resolve(APP_SDK_ENTRY, '../..')

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)

  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

interface DevelopmentServerEntry {
  readonly base: string
  readonly server: ViteDevServer
  readonly allowNetworkRequests: boolean
  readonly upgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) => void
}

export class WebAppViteRuntime {
  private readonly developmentServerCreations = new Map<
    string,
    Deferred.Deferred<DevelopmentServerEntry, WebAppRuntimeError>
  >()
  private readonly developmentServers = new Map<
    string,
    DevelopmentServerEntry
  >()
  private httpServer?: HttpServer

  attachHttpServer(server: HttpServer): void {
    this.httpServer = server
  }

  private viteConfig(
    source: ResolvedWebAppSource,
    base: string,
    options: { server?: HttpServer } = {}
  ): InlineConfig {
    const server: NonNullable<InlineConfig['server']> = {
      middlewareMode: true,
      allowedHosts: ['.ts.net'],
      headers: {
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff'
      },
      fs: {
        strict: true,
        allow: [source.packageRoot, APP_SDK_ROOT]
      }
    }

    if (options.server) {
      // EXTERNAL: Vite prepends base to the HMR path itself.
      server.hmr = { server: options.server, path: '/@vite-hmr' }
    }

    return {
      root: source.root,
      base,
      configFile: false,
      publicDir: false,
      appType: 'mpa',
      plugins: [
        react({
          babel: { babelrc: false, configFile: false }
        }),
        {
          name: 'treeport-app-dev-maps',
          apply: 'serve',
          enforce: 'post',
          // EXTERNAL: An empty map resets the transform map chain without changing code.
          transform(code) {
            return { code, map: { mappings: '' } }
          }
        }
      ],
      css: { postcss: { plugins: [] } },
      resolve: {
        alias: { '@treeport/app-sdk': APP_SDK_ENTRY },
        dedupe: ['react', 'react-dom']
      },
      server
    }
  }

  private runtimePromise<A>(
    operation: string,
    evaluate: () => Promise<A>
  ): Effect.Effect<A, WebAppRuntimeError> {
    return Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new WebAppRuntimeError(operation, cause)
    })
  }

  private errorPage(source: ResolvedWebAppSource, cause: unknown): string {
    const raw = cause instanceof Error ? cause.message : String(cause)

    const diagnostic = raw
      .replaceAll(source.packageRoot, '<package>')
      .replaceAll(source.root, '<app>')

    const stage = /resolve|not found|cannot find|failed to load|import/iu.test(
      raw
    )
      ? 'Dependency resolution'
      : 'Source transformation'

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App build failed</title><style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.5}pre{white-space:pre-wrap;background:#f4f4f5;padding:1rem;border-radius:.5rem}</style></head><body><h1>Web app could not be compiled</h1><p><strong>${escapeHtml(source.definitionId)}</strong>${source.packageSource ? ` from ${escapeHtml(source.packageSource)}` : ''}</p><p>Stage: ${stage}</p><pre>${escapeHtml(diagnostic)}</pre><p>For a local app package, install its <code>node_modules</code>. Put browser runtime imports in <code>dependencies</code>, not <code>devDependencies</code>.</p></body></html>`
  }

  private developmentServer(
    source: ResolvedWebAppSource
  ): Effect.Effect<DevelopmentServerEntry, WebAppRuntimeError> {
    return Effect.gen(this, function* () {
      const canonical = yield* this.runtimePromise('canonicalizeAppRoot', () =>
        fs.realpath(source.root)
      )

      const key = crypto
        .createHash('sha256')
        .update(canonical)
        .update(source.allowNetworkRequests ? ':network' : ':isolated')
        .digest('hex')
        .slice(0, 24)

      const existing = this.developmentServers.get(key)

      if (existing) {
        return existing
      }

      const pendingExisting = this.developmentServerCreations.get(key)

      if (pendingExisting) {
        return yield* Deferred.await(pendingExisting)
      }

      const candidate = yield* Deferred.make<
        DevelopmentServerEntry,
        WebAppRuntimeError
      >()

      const pending = yield* Effect.sync(() => {
        const winner = this.developmentServerCreations.get(key)

        if (winner) {
          return winner
        }

        this.developmentServerCreations.set(key, candidate)

        return candidate
      })

      if (pending !== candidate) {
        return yield* Deferred.await(pending)
      }

      const httpServer = this.httpServer

      const create = httpServer
        ? this.runtimePromise('createDevelopmentServer', async () => {
            const base = `/api/web-app-dev/${key}/`

            const developmentSource = {
              ...source,
              root: canonical,
              packageRoot: await fs.realpath(source.packageRoot)
            }

            const previousUpgradeListeners = new Set(
              httpServer.listeners('upgrade')
            )

            const server = await createServer(
              this.viteConfig(developmentSource, base, { server: httpServer })
            )

            const addedUpgradeListeners = httpServer
              .listeners('upgrade')
              .filter((listener) => !previousUpgradeListeners.has(listener))

            if (addedUpgradeListeners.length !== 1) {
              await server.close()
              throw new Error(
                'Web app Vite did not register one HMR upgrade handler'
              )
            }

            // SAFETY: Vite registered this listener on Node's upgrade event above.
            const upgrade = addedUpgradeListeners[0] as (
              request: IncomingMessage,
              socket: Duplex,
              head: Buffer
            ) => void

            httpServer.removeListener('upgrade', upgrade)

            return {
              base,
              server,
              allowNetworkRequests: source.allowNetworkRequests,
              upgrade
            }
          })
        : Effect.fail(
            new WebAppRuntimeError(
              'createDevelopmentServer',
              new Error('Treeport development app server is not attached')
            )
          )

      return yield* Effect.uninterruptible(
        Effect.gen(this, function* () {
          const exit = yield* Effect.exit(create)

          if (exit._tag === 'Success') {
            this.developmentServers.set(key, exit.value)
          }

          yield* Deferred.done(candidate, exit)
          this.developmentServerCreations.delete(key)

          return yield* Deferred.await(candidate)
        })
      )
    })
  }

  private resolveEffect(
    source: ResolvedWebAppSource,
    requestedPath: string
  ): Effect.Effect<
    WebAppAssetResolution,
    DomainError<unknown> | WebAppRuntimeError
  > {
    return Effect.gen(this, function* () {
      if (requestedPath) {
        const candidate = path.resolve(source.root, requestedPath)

        if (!isWithin(candidate, path.resolve(source.root))) {
          return yield* Effect.fail(
            new DomainError('INVALID_ASSET_PATH', 'Invalid asset path', 400)
          )
        }

        const real = yield* this.runtimePromise('canonicalizeAsset', () =>
          fs.realpath(candidate)
        ).pipe(Effect.orElseSucceed(() => null))

        const appRoot = yield* this.runtimePromise('canonicalizeAppRoot', () =>
          fs.realpath(source.root)
        )

        if (real && !isWithin(real, appRoot)) {
          return yield* Effect.fail(
            new DomainError('INVALID_ASSET_PATH', 'Invalid asset path', 400)
          )
        }
      }

      const development = yield* this.developmentServer(source)

      return {
        kind: 'redirect' as const,
        location: `${development.base}${requestedPath || source.entry}`,
        allowNetworkRequests: source.allowNetworkRequests
      }
    }).pipe(
      Effect.catchTag('WebAppRuntimeError', (error) =>
        Effect.succeed({
          kind: 'error' as const,
          html: this.errorPage(source, error.cause),
          allowNetworkRequests: source.allowNetworkRequests
        })
      )
    )
  }

  handleDevelopmentRequest(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void
  ): void {
    const pathname = new URL(request.url ?? '/', 'http://treeport.local')
      .pathname

    const match = /^\/api\/web-app-dev\/([a-f0-9]{24})\//u.exec(pathname)

    const development = match
      ? this.developmentServers.get(match[1]!)
      : undefined

    if (!development) {
      next()

      return
    }

    const referrer = request.headers.referer
    const forwardedHost = request.headers['x-forwarded-host']
    const host = request.headers.host
    const forwardedProtocol = request.headers['x-forwarded-proto']

    const browserOrigin = webAppBrowserOrigin({
      referrer: Array.isArray(referrer) ? null : referrer,
      forwardedHost: Array.isArray(forwardedHost) ? null : forwardedHost,
      host: Array.isArray(host) ? null : host,
      forwardedProtocol: Array.isArray(forwardedProtocol)
        ? null
        : forwardedProtocol,
      requestProtocol: request.socket instanceof TLSSocket ? 'https:' : 'http:'
    })

    response.setHeader('access-control-allow-origin', '*')
    // EXTERNAL: Let Vite select no-cache for source files and immutable caching for
    // versioned optimized dependencies; don't override both with no-store.
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader(
      'content-security-policy',
      webAppContentSecurityPolicy(
        'development',
        browserOrigin,
        development.allowNetworkRequests
      )
    )
    development.server.middlewares(request, response, next)
  }

  handleDevelopmentUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): boolean {
    const pathname = new URL(request.url ?? '/', 'http://treeport.local')
      .pathname

    const match = /^\/api\/web-app-dev\/([a-f0-9]{24})\/@vite-hmr$/u.exec(
      pathname
    )

    const development = match
      ? this.developmentServers.get(match[1]!)
      : undefined

    if (!development) {
      return false
    }

    development.upgrade(request, socket, head)

    return true
  }

  resolve(
    source: ResolvedWebAppSource,
    requestedPath: string
  ): Effect.Effect<
    WebAppAssetResolution,
    DomainError<unknown> | WebAppRuntimeError
  > {
    return this.resolveEffect(source, requestedPath).pipe(
      Effect.tap((result) =>
        result.kind === 'error'
          ? Effect.logError('Failed to compile web app').pipe(
              Effect.annotateLogs({ definitionId: source.definitionId })
            )
          : Effect.void
      ),
      Effect.withSpan('treeport.web_app.runtime.resolve')
    )
  }

  disposeDevelopmentServers(): Effect.Effect<void, WebAppRuntimeError> {
    return Effect.gen(this, function* () {
      const pending = [...this.developmentServerCreations.values()]
      yield* Effect.all(
        pending.map((creation) => Effect.exit(Deferred.await(creation))),
        { concurrency: 'unbounded' }
      )

      const servers = yield* Effect.sync(() => {
        const active = [...this.developmentServers.values()]
        this.developmentServers.clear()

        return active
      })

      yield* this.runtimePromise('disposeDevelopmentServers', () =>
        Promise.all(
          servers.map(async ({ server }) => {
            await server.waitForRequestsIdle()
            // EXTERNAL: Vite's dependency scan can create an optimizer after close() snapshots
            // the work to cancel. Let scans settle before closing their optimizers.
            await Promise.all(
              Object.values(server.environments).map(
                (environment) => environment.depsOptimizer?.scanProcessing
              )
            )
            await server.close()
          })
        ).then(() => undefined)
      )
    })
  }
}

export class WebAppRuntimeError extends Data.TaggedError('WebAppRuntimeError')<{
  readonly operation: string
  readonly cause: unknown
  readonly message: string
}> {
  constructor(operation: string, cause: unknown) {
    super({
      operation,
      cause,
      message: cause instanceof Error ? cause.message : String(cause)
    })
  }
}

export class WebAppRuntimePort extends Context.Tag('treeport/WebAppRuntime')<
  WebAppRuntimePort,
  WebAppViteRuntime
>() {}

export function WebAppRuntimeLayer(): Layer.Layer<WebAppRuntimePort> {
  return Layer.scoped(
    WebAppRuntimePort,
    Effect.acquireRelease(
      Effect.sync(() => new WebAppViteRuntime()),
      (runtime) => runtime.disposeDevelopmentServers().pipe(Effect.orDie)
    )
  )
}
