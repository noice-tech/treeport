import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse
} from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import packageJson from '../../../package.json' with { type: 'json' }
import {
  build,
  createServer,
  type InlineConfig,
  type ViteDevServer
} from 'vite'
import type { AppConfig } from './config'
import { DomainError } from './domain'

export interface ResolvedWebPanelSource {
  root: string
  entry: string
  packageRoot: string
  development: boolean
  packageLockPath?: string
  definitionId: string
  packageSource?: string
}

export type WebPanelAssetResolution =
  | { kind: 'redirect'; location: string; development: boolean }
  | { kind: 'asset'; path: string; immutable: boolean; development: false }
  | { kind: 'error'; html: string; development: boolean }

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

export class WebPanelViteRuntime {
  private readonly builds = new Map<string, Promise<string>>()
  private readonly developmentServers = new Map<
    string,
    { base: string; server: ViteDevServer }
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
    return {
      root: source.root,
      base,
      configFile: false,
      publicDir: false,
      appType: 'mpa',
      plugins: [
        react({
          babel: { babelrc: false, configFile: false }
        })
      ],
      css: { postcss: { plugins: [] } },
      resolve: {
        alias: { '@treeport/panel-sdk': PANEL_SDK_ENTRY },
        dedupe: ['react', 'react-dom']
      },
      server: {
        middlewareMode: true,
        headers: {
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'self'",
          'x-content-type-options': 'nosniff'
        },
        fs: {
          strict: true,
          allow: [source.packageRoot, PANEL_SDK_ROOT]
        },
        ...(options.server
          ? { hmr: { server: options.server, path: `${base}@vite-hmr` } }
          : {})
      },
      build: {
        sourcemap: true,
        rollupOptions: { input: path.join(source.root, source.entry) },
        ...(options.outDir ? { outDir: options.outDir, emptyOutDir: true } : {})
      }
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

  private async compiledDirectory(
    source: ResolvedWebPanelSource
  ): Promise<{ hash: string; directory: string }> {
    const hash = await this.hashSource(source)
    const parent = path.join(this.config.cacheDir, 'web-panels', COMPILER_ABI)
    const directory = path.join(parent, hash)
    const metadata = path.join(directory, BUILD_METADATA)
    if (
      await fs
        .readFile(metadata, 'utf8')
        .then((value) => JSON.parse(value) as { hash?: string })
        .then((value) => value.hash === hash)
        .catch(() => false)
    ) {
      return { hash, directory }
    }

    let pending = this.builds.get(hash)
    if (!pending) {
      pending = (async () => {
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
          await fs
            .rename(temporary, directory)
            .catch(async (error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error
              }
            })
          return directory
        } finally {
          await fs.rm(temporary, { recursive: true, force: true })
        }
      })()
      this.builds.set(hash, pending)
      void pending
        .finally(() => this.builds.delete(hash))
        .catch(() => undefined)
    }

    return { hash, directory: await pending }
  }

  private errorPage(source: ResolvedWebPanelSource, error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error)
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

  private async developmentServer(source: ResolvedWebPanelSource): Promise<{
    base: string
    server: ViteDevServer
  }> {
    const canonical = await fs.realpath(source.root)
    const key = crypto
      .createHash('sha256')
      .update(canonical)
      .digest('hex')
      .slice(0, 24)
    const existing = this.developmentServers.get(key)
    if (existing) {
      return existing
    }

    if (!this.httpServer) {
      throw new Error('Treeport development panel server is not attached')
    }

    const base = `/api/web-panel-dev/${key}/`
    const developmentSource = {
      ...source,
      root: canonical,
      packageRoot: await fs.realpath(source.packageRoot)
    }
    const server = await createServer(
      this.viteConfig(developmentSource, base, { server: this.httpServer })
    )
    const created = { base, server }
    this.developmentServers.set(key, created)
    return created
  }

  async resolve(
    source: ResolvedWebPanelSource,
    requestedPath: string,
    logicalBase: string
  ): Promise<WebPanelAssetResolution> {
    try {
      if (requestedPath && !requestedPath.startsWith(IMMUTABLE_PREFIX)) {
        const candidate = path.resolve(source.root, requestedPath)
        if (!isWithin(candidate, path.resolve(source.root))) {
          throw new DomainError('INVALID_ASSET_PATH', 'Invalid asset path', 400)
        }

        const real = await fs.realpath(candidate).catch(() => null)
        const panelRoot = await fs.realpath(source.root)
        if (real && !isWithin(real, panelRoot)) {
          throw new DomainError('INVALID_ASSET_PATH', 'Invalid asset path', 400)
        }
      }

      if (source.development) {
        const development = await this.developmentServer(source)
        const relative = requestedPath || source.entry

        return {
          kind: 'redirect',
          location: `${development.base}${relative}`,
          development: true
        }
      }

      const immutable = requestedPath.startsWith(IMMUTABLE_PREFIX)
      if (!immutable) {
        const compiled = await this.compiledDirectory(source)
        return {
          kind: 'redirect',
          location: `${logicalBase}${IMMUTABLE_PREFIX}${compiled.hash}/${requestedPath || source.entry}`,
          development: false
        }
      }

      const [marker, hash, ...segments] = requestedPath.split('/')
      if (
        marker !== '__treeport' ||
        !/^[a-f0-9]{64}$/u.test(hash ?? '') ||
        segments.length === 0
      ) {
        throw new DomainError('INVALID_ASSET_PATH', 'Invalid asset path', 400)
      }

      const directory = path.join(
        this.config.cacheDir,
        'web-panels',
        COMPILER_ABI,
        hash!
      )
      const canonicalDirectory = await fs.realpath(directory).catch(() => null)
      if (!canonicalDirectory) {
        throw new DomainError(
          'WEB_PANEL_ASSET_NOT_FOUND',
          'Web panel asset not found',
          404
        )
      }

      const candidate = path.resolve(directory, ...segments)
      if (!isWithin(candidate, directory)) {
        throw new DomainError('INVALID_ASSET_PATH', 'Invalid asset path', 400)
      }

      const real = await fs.realpath(candidate).catch(() => null)
      if (!real || !isWithin(real, canonicalDirectory)) {
        throw new DomainError(
          'WEB_PANEL_ASSET_NOT_FOUND',
          'Web panel asset not found',
          404
        )
      }

      return { kind: 'asset', path: real, immutable: true, development: false }
    } catch (error) {
      if (error instanceof DomainError) {
        throw error
      }

      console.error(`Failed to compile web panel ${source.definitionId}`, error)
      return {
        kind: 'error',
        html: this.errorPage(source, error),
        development: source.development
      }
    }
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

    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'self'"
    )
    development.server.middlewares(request, response, next)
  }

  async disposeDevelopmentServers(): Promise<void> {
    const servers = [...this.developmentServers.values()]
    this.developmentServers.clear()
    await Promise.all(
      servers.map(async ({ server }) => {
        await server.waitForRequestsIdle()
        await server.close()
      })
    )
  }

  async dispose(): Promise<void> {
    await this.disposeDevelopmentServers()
  }
}
