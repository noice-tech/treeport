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
import packageJson from '../../../package.json' with { type: 'json' }
import {
  build,
  createServer,
  type InlineConfig,
  type ViteDevServer
} from 'vite'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { AppConfig } from './config'
import { DomainError } from './domain'
import {
  webPanelBrowserOrigin,
  webPanelContentSecurityPolicy
} from './web-panel-csp'

export interface ResolvedWebPanelSource {
  root: string
  entry: string
  packageRoot: string
  development: boolean
  packageLockPath?: string
  definitionId: string
  packageSource?: string
  allowNetworkRequests: boolean
}

export type WebPanelAssetResolution =
  | {
      kind: 'redirect'
      location: string
      development: boolean
      allowNetworkRequests: boolean
    }
  | {
      kind: 'asset'
      path: string
      immutable: boolean
      development: false
      allowNetworkRequests: boolean
    }
  | {
      kind: 'error'
      html: string
      development: boolean
      allowNetworkRequests: boolean
    }

const COMPILER_ABI = 'runtime-abi-1'
const VITE_VERSION = packageJson.dependencies.vite
const REACT_PLUGIN_VERSION = packageJson.dependencies['@vitejs/plugin-react']
const PANEL_SDK_ENTRY = fileURLToPath(
  import.meta.resolve('@treeport/panel-sdk')
)
const PANEL_SDK_ROOT = path.resolve(PANEL_SDK_ENTRY, '../..')
const BUILD_METADATA = 'treeport-build.json'
const IMMUTABLE_PREFIX = '__treeport/'

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

export class WebPanelViteRuntime {
  private readonly builds = new Map<
    string,
    Deferred.Deferred<string, WebPanelRuntimeError>
  >()
  private readonly developmentServerCreations = new Map<
    string,
    Deferred.Deferred<DevelopmentServerEntry, WebPanelRuntimeError>
  >()
  private readonly developmentServers = new Map<
    string,
    DevelopmentServerEntry
  >()
  private httpServer?: HttpServer

  constructor(private readonly config: AppConfig) {}

  attachHttpServer(server: HttpServer): void {
    this.httpServer = server
  }

  private viteConfig(
    source: ResolvedWebPanelSource,
    base: string,
    options: { outDir?: string; server?: HttpServer } = {}
  ): InlineConfig {
    const server: NonNullable<InlineConfig['server']> = {
      middlewareMode: true,
      headers: {
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff'
      },
      fs: {
        strict: true,
        allow: [source.packageRoot, PANEL_SDK_ROOT]
      }
    }
    if (options.server) {
      server.hmr = { server: options.server, path: `${base}@vite-hmr` }
    }

    const viteBuild: NonNullable<InlineConfig['build']> = {
      sourcemap: true,
      rollupOptions: { input: path.join(source.root, source.entry) }
    }
    if (options.outDir) {
      viteBuild.outDir = options.outDir
      viteBuild.emptyOutDir = true
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
          name: 'treeport-panel-dev-maps',
          apply: 'serve',
          enforce: 'post',
          // Inline maps dwarf executable dependency code on every panel mount.
          // An empty map resets the transform map chain without changing code.
          // Production build maps are unaffected.
          transform(code) {
            return { code, map: { mappings: '' } }
          }
        }
      ],
      css: { postcss: { plugins: [] } },
      resolve: {
        alias: { '@treeport/panel-sdk': PANEL_SDK_ENTRY },
        dedupe: ['react', 'react-dom']
      },
      server,
      build: viteBuild
    }
  }

  private async hashSource(source: ResolvedWebPanelSource): Promise<string> {
    const hash = crypto.createHash('sha256')
    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue
        }

        const candidate = path.join(directory, entry.name)
        const relative = path
          .relative(source.root, candidate)
          .split(path.sep)
          .join('/')
        if (entry.isSymbolicLink()) {
          const real = await fs.realpath(candidate)
          if (!isWithin(real, await fs.realpath(source.root))) {
            throw new DomainError(
              'INVALID_ASSET_PATH',
              'Web panel source contains a symlink outside its root',
              400
            )
          }
        }

        const stat = await fs.stat(candidate)
        if (stat.isDirectory()) {
          await visit(candidate)
        } else if (stat.isFile()) {
          hash
            .update(relative)
            .update('\0')
            .update(await fs.readFile(candidate))
            .update('\0')
        }
      }
    }

    await visit(source.root)
    for (const file of [
      path.join(source.packageRoot, 'package.json'),
      source.packageLockPath
    ]) {
      if (!file) {
        continue
      }

      const content = await fs.readFile(file).catch(() => null)
      if (content) {
        hash.update(path.basename(file)).update('\0').update(content)
      }
    }
    hash
      .update('@treeport/panel-sdk\0')
      .update(await fs.readFile(PANEL_SDK_ENTRY))
      .update('\0')
    hash.update(
      JSON.stringify({
        appVersion: this.config.appVersion ?? 'development',
        compilerAbi: COMPILER_ABI,
        vite: VITE_VERSION,
        reactPlugin: REACT_PLUGIN_VERSION,
        profile: {
          appType: 'mpa',
          base: './',
          babelConfig: false,
          panelSdkProvided: true,
          postcssPlugins: [],
          publicDir: false,
          reactDedupe: true,
          sourcemap: true
        }
      })
    )
    return hash.digest('hex')
  }

  private runtimePromise<A>(
    operation: string,
    evaluate: () => Promise<A>
  ): Effect.Effect<A, WebPanelRuntimeError> {
    return Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new WebPanelRuntimeError(operation, cause)
    })
  }

  private compiledDirectory(
    source: ResolvedWebPanelSource
  ): Effect.Effect<{ hash: string; directory: string }, WebPanelRuntimeError> {
    return Effect.gen(this, function* () {
      const hash = yield* this.runtimePromise('hashSource', () =>
        this.hashSource(source)
      )
      const parent = path.join(this.config.cacheDir, 'web-panels', COMPILER_ABI)
      const directory = path.join(parent, hash)
      const metadata = path.join(directory, BUILD_METADATA)
      const cached = yield* this.runtimePromise(
        'readBuildMetadata',
        async () => {
          const value = await fs.readFile(metadata, 'utf8')
          // SAFETY: This module writes the cache metadata with a hash field.
          return (JSON.parse(value) as { hash?: string }).hash === hash
        }
      ).pipe(Effect.orElseSucceed(() => false))
      if (cached) {
        return { hash, directory }
      }

      const existing = this.builds.get(hash)
      if (existing) {
        return { hash, directory: yield* Deferred.await(existing) }
      }

      const candidate = yield* Deferred.make<string, WebPanelRuntimeError>()
      const pending = yield* Effect.sync(() => {
        const winner = this.builds.get(hash)
        if (winner) {
          return winner
        }

        this.builds.set(hash, candidate)
        return candidate
      })
      if (pending !== candidate) {
        return { hash, directory: yield* Deferred.await(pending) }
      }

      const buildEffect = this.runtimePromise('build', async () => {
        await fs.mkdir(parent, { recursive: true, mode: 0o700 })
        const temporary = path.join(
          parent,
          `.${hash}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
        )
        await fs.rm(temporary, { recursive: true, force: true })
        try {
          const buildSource = {
            ...source,
            root: await fs.realpath(source.root),
            packageRoot: await fs.realpath(source.packageRoot)
          }
          await build(this.viteConfig(buildSource, './', { outDir: temporary }))
          await fs.writeFile(
            path.join(temporary, BUILD_METADATA),
            `${JSON.stringify({ hash, compilerAbi: COMPILER_ABI })}\n`
          )
          await fs.rename(temporary, directory).catch(async (error) => {
            // SAFETY: The surrounding boundary contract establishes this asserted value.
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
              throw error
            }
          })
          return directory
        } finally {
          await fs.rm(temporary, { recursive: true, force: true })
        }
      })
      yield* Effect.uninterruptible(
        Effect.exit(buildEffect).pipe(
          Effect.flatMap((exit) => Deferred.done(candidate, exit)),
          Effect.ensuring(
            Effect.sync(() => {
              if (this.builds.get(hash) === candidate) {
                this.builds.delete(hash)
              }
            })
          )
        )
      )
      return { hash, directory: yield* Deferred.await(candidate) }
    })
  }

  private errorPage(source: ResolvedWebPanelSource, cause: unknown): string {
    const raw = cause instanceof Error ? cause.message : String(cause)
    const diagnostic = raw
      .replaceAll(source.packageRoot, '<package>')
      .replaceAll(source.root, '<panel>')
    const stage = /resolve|not found|cannot find|failed to load|import/iu.test(
      raw
    )
      ? 'Dependency resolution'
      : 'Source transformation'

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Panel build failed</title><style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.5}pre{white-space:pre-wrap;background:#f4f4f5;padding:1rem;border-radius:.5rem}</style></head><body><h1>Web panel could not be compiled</h1><p><strong>${escapeHtml(source.definitionId)}</strong>${source.packageSource ? ` from ${escapeHtml(source.packageSource)}` : ''}</p><p>Stage: ${stage}</p><pre>${escapeHtml(diagnostic)}</pre><p>For a local panel package, install its <code>node_modules</code>. Put browser runtime imports in <code>dependencies</code>, not <code>devDependencies</code>.</p></body></html>`
  }

  private developmentServer(
    source: ResolvedWebPanelSource
  ): Effect.Effect<DevelopmentServerEntry, WebPanelRuntimeError> {
    return Effect.gen(this, function* () {
      const canonical = yield* this.runtimePromise(
        'canonicalizePanelRoot',
        () => fs.realpath(source.root)
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
        WebPanelRuntimeError
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
            const base = `/api/web-panel-dev/${key}/`
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
                'Web panel Vite did not register one HMR upgrade handler'
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
            new WebPanelRuntimeError(
              'createDevelopmentServer',
              new Error('Treeport development panel server is not attached')
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
    source: ResolvedWebPanelSource,
    requestedPath: string,
    logicalBase: string
  ): Effect.Effect<
    WebPanelAssetResolution,
    DomainError<unknown> | WebPanelRuntimeError
  > {
    return Effect.gen(this, function* () {
      if (requestedPath && !requestedPath.startsWith(IMMUTABLE_PREFIX)) {
        const candidate = path.resolve(source.root, requestedPath)
        if (!isWithin(candidate, path.resolve(source.root))) {
          return yield* Effect.fail(
            new DomainError('INVALID_ASSET_PATH', 'Invalid asset path', 400)
          )
        }

        const real = yield* this.runtimePromise('canonicalizeAsset', () =>
          fs.realpath(candidate)
        ).pipe(Effect.orElseSucceed(() => null))
        const panelRoot = yield* this.runtimePromise(
          'canonicalizePanelRoot',
          () => fs.realpath(source.root)
        )
        if (real && !isWithin(real, panelRoot)) {
          return yield* Effect.fail(
            new DomainError('INVALID_ASSET_PATH', 'Invalid asset path', 400)
          )
        }
      }

      if (source.development) {
        const development = yield* this.developmentServer(source)
        return {
          kind: 'redirect' as const,
          location: `${development.base}${requestedPath || source.entry}`,
          development: true as const,
          allowNetworkRequests: source.allowNetworkRequests
        }
      }

      if (!requestedPath.startsWith(IMMUTABLE_PREFIX)) {
        const compiled = yield* this.compiledDirectory(source)
        return {
          kind: 'redirect' as const,
          location: `${logicalBase}${IMMUTABLE_PREFIX}${compiled.hash}/${requestedPath || source.entry}`,
          development: false as const,
          allowNetworkRequests: source.allowNetworkRequests
        }
      }

      const [marker, hash, ...segments] = requestedPath.split('/')
      if (
        marker !== '__treeport' ||
        !/^[a-f0-9]{64}$/u.test(hash ?? '') ||
        segments.length === 0
      ) {
        return yield* Effect.fail(
          new DomainError('INVALID_ASSET_PATH', 'Invalid asset path', 400)
        )
      }

      const directory = path.join(
        this.config.cacheDir,
        'web-panels',
        COMPILER_ABI,
        hash!
      )
      const canonicalDirectory = yield* this.runtimePromise(
        'canonicalizeBuildDirectory',
        () => fs.realpath(directory)
      ).pipe(Effect.orElseSucceed(() => null))
      if (!canonicalDirectory) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_ASSET_NOT_FOUND',
            'Web panel asset not found',
            404
          )
        )
      }

      const candidate = path.resolve(directory, ...segments)
      if (!isWithin(candidate, directory)) {
        return yield* Effect.fail(
          new DomainError('INVALID_ASSET_PATH', 'Invalid asset path', 400)
        )
      }

      const real = yield* this.runtimePromise('canonicalizeAsset', () =>
        fs.realpath(candidate)
      ).pipe(Effect.orElseSucceed(() => null))
      if (!real || !isWithin(real, canonicalDirectory)) {
        return yield* Effect.fail(
          new DomainError(
            'WEB_PANEL_ASSET_NOT_FOUND',
            'Web panel asset not found',
            404
          )
        )
      }

      return {
        kind: 'asset' as const,
        path: real,
        immutable: true as const,
        development: false as const,
        allowNetworkRequests: source.allowNetworkRequests
      }
    }).pipe(
      Effect.catchTag('WebPanelRuntimeError', (error) =>
        Effect.succeed({
          kind: 'error' as const,
          html: this.errorPage(source, error.cause),
          development: source.development,
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
    const match = /^\/api\/web-panel-dev\/([a-f0-9]{24})\//u.exec(pathname)
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
    const browserOrigin = webPanelBrowserOrigin({
      referrer: Array.isArray(referrer) ? null : referrer,
      forwardedHost: Array.isArray(forwardedHost) ? null : forwardedHost,
      host: Array.isArray(host) ? null : host,
      forwardedProtocol: Array.isArray(forwardedProtocol)
        ? null
        : forwardedProtocol,
      requestProtocol: request.socket instanceof TLSSocket ? 'https:' : 'http:'
    })

    response.setHeader('access-control-allow-origin', '*')
    // Let Vite select no-cache for source files and immutable caching for
    // versioned optimized dependencies; don't override both with no-store.
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader(
      'content-security-policy',
      webPanelContentSecurityPolicy(
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
    const match = /^\/api\/web-panel-dev\/([a-f0-9]{24})\/@vite-hmr$/u.exec(
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
    source: ResolvedWebPanelSource,
    requestedPath: string,
    logicalBase: string
  ): Effect.Effect<
    WebPanelAssetResolution,
    DomainError<unknown> | WebPanelRuntimeError
  > {
    return this.resolveEffect(source, requestedPath, logicalBase).pipe(
      Effect.tap((result) =>
        result.kind === 'error'
          ? Effect.logError('Failed to compile web panel').pipe(
              Effect.annotateLogs({ definitionId: source.definitionId })
            )
          : Effect.void
      ),
      Effect.withSpan('treeport.web_panel.runtime.resolve')
    )
  }

  disposeDevelopmentServers(): Effect.Effect<void, WebPanelRuntimeError> {
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
            // Vite's dependency scan can create an optimizer after close() snapshots
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

  dispose(): Effect.Effect<void, WebPanelRuntimeError> {
    return Effect.all(
      [...this.builds.values()].map((pending) =>
        Effect.exit(Deferred.await(pending))
      ),
      { concurrency: 'unbounded', discard: true }
    ).pipe(Effect.zipRight(this.disposeDevelopmentServers()))
  }
}

export class WebPanelRuntimeError extends Data.TaggedError(
  'WebPanelRuntimeError'
)<{
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

export class WebPanelRuntimePort extends Context.Tag(
  'treeport/WebPanelRuntime'
)<WebPanelRuntimePort, WebPanelViteRuntime>() {}

export function WebPanelRuntimeLayer(
  config: AppConfig
): Layer.Layer<WebPanelRuntimePort> {
  return Layer.scoped(
    WebPanelRuntimePort,
    Effect.acquireRelease(
      Effect.sync(() => new WebPanelViteRuntime(config)),
      (runtime) => runtime.dispose().pipe(Effect.orDie)
    )
  )
}
