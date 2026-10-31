import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppService } from '#protocol/web-app'
import { DomainError } from './core/domain.ts'
import type { PackageServiceDeclaration } from './core/package-system.ts'

interface ServiceContext {
  packageRoot: string
  treePath: string
}

interface ServiceEntry {
  id: string
  declaration: PackageServiceDeclaration
  token: string
  status: AppService['status']
  error: string | null
  logs: string
  child: ChildProcess | null
  closed: Promise<void> | null
  starting: Promise<void> | null
  stopping: Promise<void> | null
  abort: AbortController
  socketPath: string | null
  socketDirectory: string | null
  connections: Set<Duplex>
  stopped: boolean
  startedAt: number
  restarts: number
  restartTimer: NodeJS.Timeout | null
}

export interface PackageServiceAccess {
  packageId: string
  projectIds: string[] | null
}

interface AppServicesOptions {
  apiUrl: string
  dataDir: string
  declarations: () => Promise<PackageServiceDeclaration[]>
  pruneDecorationSources: (sources: string[]) => Promise<void>
  log: (message: string) => void
}

const PREFIX = '/api/app-services/'
const LOG_LIMIT = 64 * 1024

const SYNC_INTERVAL_MS = 5_000
const MAX_RESTART_DELAY_MS = 60_000

export class AppServices {
  private readonly entries = new Map<string, ServiceEntry>()
  private readonly tokens = new Map<string, ServiceEntry>()
  private activeSources: string | null = null
  private timer: NodeJS.Timeout | null = null
  private syncing: Promise<void> | null = null
  private disposed = false

  private readonly options: AppServicesOptions

  constructor(options: AppServicesOptions) {
    this.options = options
  }

  start(): void {
    void this.sync()
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS)
    this.timer.unref()
  }

  access(token: string): PackageServiceAccess | null {
    const entry = this.tokens.get(token)

    return entry
      ? {
          packageId: entry.declaration.packageId,
          projectIds: entry.declaration.projectIds
        }
      : null
  }

  private sync(): Promise<void> {
    this.syncing ??= this.reconcile()
      .catch((error) => {
        this.options.log(
          `Package service sync failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        this.syncing = null
      })

    return this.syncing
  }

  private async reconcile(): Promise<void> {
    const declarations = await this.options.declarations()
    const next = new Map<string, PackageServiceDeclaration>()

    for (const declaration of declarations) {
      const root = await fs
        .realpath(declaration.root)
        .catch(() => declaration.root)

      next.set(
        crypto
          .createHash('sha256')
          .update(`${root}\0${declaration.name}`)
          .digest('hex')
          .slice(0, 24),
        declaration
      )
    }

    if (this.disposed) {
      return
    }

    for (const [id, entry] of this.entries) {
      const declaration = next.get(id)

      if (
        declaration &&
        JSON.stringify({ ...declaration, projectIds: null }) ===
          JSON.stringify({ ...entry.declaration, projectIds: null })
      ) {
        entry.declaration = declaration
        continue
      }

      this.entries.delete(id)
      this.tokens.delete(entry.token)
      await this.stopEntry(entry)
    }

    for (const [id, declaration] of next) {
      if (this.entries.has(id)) {
        continue
      }

      const entry: ServiceEntry = {
        id,
        declaration,
        token: crypto.randomBytes(32).toString('base64url'),
        status: 'stopped',
        error: null,
        logs: '',
        child: null,
        closed: null,
        starting: null,
        stopping: null,
        abort: new AbortController(),
        socketPath: null,
        socketDirectory: null,
        connections: new Set(),
        stopped: false,
        startedAt: 0,
        restarts: 0,
        restartTimer: null
      }

      this.entries.set(id, entry)
      this.tokens.set(entry.token, entry)

      if (declaration.start === 'always') {
        void this.run(entry).catch(() => undefined)
      }
    }

    const sources = [
      ...new Set(declarations.map((declaration) => declaration.packageId))
    ].sort()

    if (JSON.stringify(sources) !== this.activeSources) {
      await this.options.pruneDecorationSources(sources)
      this.activeSources = JSON.stringify(sources)
    }
  }

  private async resolve(
    context: ServiceContext,
    name: string
  ): Promise<ServiceEntry> {
    const find = () =>
      [...this.entries.values()].find(
        (entry) =>
          entry.declaration.root === context.packageRoot &&
          entry.declaration.name === name
      )

    const entry = find() ?? (await this.sync().then(find))

    if (this.disposed) {
      throw new DomainError('SERVICE_STOPPED', 'Treeport is shutting down', 503)
    }

    if (!entry) {
      throw new DomainError(
        'SERVICE_NOT_FOUND',
        `Service “${name}” is not declared by this package`,
        404
      )
    }

    return entry
  }

  private snapshot(entry: ServiceEntry, context: ServiceContext): AppService {
    const query = new URLSearchParams()

    for (const [key, value] of Object.entries(entry.declaration.query)) {
      query.set(key, value.replaceAll('${treePath}', context.treePath))
    }

    return {
      id: entry.id,
      name: entry.declaration.name,
      status: entry.status,
      pid:
        entry.child?.exitCode === null && entry.child.signalCode === null
          ? (entry.child.pid ?? null)
          : null,
      url:
        entry.status === 'ready' && entry.declaration.readinessPath
          ? `${PREFIX}${entry.id}/${query.size ? `?${query}` : ''}`
          : null,
      logs: entry.logs,
      error: entry.error
    }
  }

  async status(context: ServiceContext, name: string): Promise<AppService> {
    return this.snapshot(await this.resolve(context, name), context)
  }

  async ensure(context: ServiceContext, name: string): Promise<AppService> {
    const entry = await this.resolve(context, name)
    await entry.stopping

    if (this.disposed) {
      throw new DomainError('SERVICE_STOPPED', 'Treeport is shutting down', 503)
    }

    await this.run(entry)

    if (entry.status !== 'ready') {
      throw new DomainError(
        'SERVICE_STOPPED',
        entry.error ?? 'The service stopped while starting',
        503
      )
    }

    return this.snapshot(entry, context)
  }

  private run(entry: ServiceEntry): Promise<void> {
    if (!entry.starting && entry.status !== 'ready') {
      if (entry.restartTimer) {
        clearTimeout(entry.restartTimer)
        entry.restartTimer = null
      }

      entry.stopped = false
      entry.abort = new AbortController()
      entry.status = 'starting'
      entry.error = null
      entry.logs = ''
      entry.starting = this.launch(entry)
        .catch(async (error) => {
          entry.error = error instanceof Error ? error.message : String(error)
          entry.status = 'failed'
          await this.terminate(entry)
          this.restart(entry)
          throw new DomainError('SERVICE_START_FAILED', entry.error, 503)
        })
        .finally(() => {
          entry.starting = null
        })
    }

    return entry.starting ?? Promise.resolve()
  }

  private restart(entry: ServiceEntry): void {
    if (
      entry.declaration.start !== 'always' ||
      entry.stopped ||
      entry.restartTimer ||
      this.disposed ||
      this.entries.get(entry.id) !== entry
    ) {
      return
    }

    entry.restarts =
      Date.now() - entry.startedAt > MAX_RESTART_DELAY_MS
        ? 0
        : entry.restarts + 1
    const wait = Math.min(MAX_RESTART_DELAY_MS, 1_000 * 2 ** entry.restarts)
    this.options.log(
      `Service ${entry.declaration.packageId} ${entry.declaration.name}: ${entry.error}; restarting in ${wait / 1_000}s\n${entry.logs.slice(-2_048)}`
    )
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null
      void (async () => {
        await entry.stopping

        if (!entry.stopped && !this.disposed) {
          await this.run(entry)
        }
      })().catch(() => undefined)
    }, wait)
    entry.restartTimer.unref()
  }

  private async launch(entry: ServiceEntry): Promise<void> {
    if (process.platform === 'win32') {
      throw new Error('App services currently require macOS or Linux')
    }

    await this.terminate(entry)
    const { declaration } = entry
    const dataDir = path.join(this.options.dataDir, 'app-services', entry.id)
    await fs.mkdir(dataDir, { recursive: true })

    if (declaration.readinessPath) {
      entry.socketDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'treeport-service-')
      )
      entry.socketPath = path.join(entry.socketDirectory, 'http.sock')
    }

    const substitute = (value: string) =>
      (entry.socketPath
        ? value.replaceAll('${socket}', entry.socketPath)
        : value
      )
        .replaceAll('${dataDir}', dataDir)
        .replaceAll('${packageRoot}', declaration.root)

    entry.abort.signal.throwIfAborted()
    const env = { ...process.env }

    for (const key of Object.keys(env)) {
      if (
        key.startsWith('VSCODE_') ||
        key.startsWith('CODE_SERVER_') ||
        key.startsWith('TREEPORT_')
      ) {
        delete env[key]
      }
    }

    env.TREEPORT_API_URL = this.options.apiUrl
    env.TREEPORT_PACKAGE_TOKEN = entry.token

    const child = spawn(
      substitute(declaration.executable),
      declaration.args.map(substitute),
      {
        cwd: declaration.root,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    entry.child = child
    entry.startedAt = Date.now()
    entry.closed = new Promise((resolve) => {
      child.once('close', () => resolve())
    })
    child.once('exit', (code, signal) => {
      const crashed = entry.child === child && entry.status === 'ready'

      if (
        entry.child === child &&
        (entry.status === 'ready' || entry.status === 'starting')
      ) {
        entry.status = 'failed'
        entry.error ??= `Service exited (${signal ?? code ?? 'unknown status'})`
      }

      if (crashed) {
        // EXTERNAL: Use exit, not close: orphaned descendants can hold the stdout pipes
        // open. Reap the group immediately before its ID can be reused.
        entry.stopping = this.terminate(entry)
          .catch((error) => {
            entry.error = `Service cleanup failed: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            entry.stopping = null
          })
        this.restart(entry)
      }
    })
    child.once('error', (error) => {
      entry.error = `Could not start ${declaration.executable}: ${error.message}. Install the executable and make it available on Treeport's PATH.`
      entry.status = 'failed'
    })

    const append = (chunk: Buffer) => {
      entry.logs = (entry.logs + chunk.toString('utf8')).slice(-LOG_LIMIT)
    }

    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const readinessPath = declaration.readinessPath

    if (!readinessPath) {
      await new Promise((resolve) => {
        child.once('spawn', resolve)
        child.once('error', resolve)
      })

      if (entry.error) {
        throw new Error(entry.error)
      }

      entry.status = 'ready'

      return
    }

    const deadline = Date.now() + 30_000

    while (Date.now() < deadline) {
      entry.abort.signal.throwIfAborted()

      if (entry.error) {
        throw new Error(entry.error)
      }

      const ready = await new Promise<boolean>((resolve) => {
        const request = httpRequest(
          {
            socketPath: entry.socketPath!,
            path: readinessPath,
            timeout: 1_000
          },
          (response) => {
            response.resume()
            resolve(response.statusCode === 200)
          }
        )

        request.on('error', () => resolve(false))
        request.on('timeout', () => request.destroy())
        request.end()
      })

      if (ready) {
        entry.abort.signal.throwIfAborted()

        if (entry.error) {
          throw new Error(entry.error)
        }

        entry.status = 'ready'

        return
      }

      await delay(100, undefined, { signal: entry.abort.signal })
    }

    throw new Error(
      `Service “${declaration.name}” did not become ready within 30 seconds.\n${entry.logs.slice(-4_096)}`
    )
  }

  private async terminate(entry: ServiceEntry): Promise<void> {
    for (const connection of entry.connections) {
      connection.destroy()
    }

    entry.connections.clear()
    const pid = entry.child?.pid

    if (pid) {
      const signal = (value: NodeJS.Signals) => {
        try {
          process.kill(-pid, value)
        } catch (error) {
          // SAFETY: Node's process.kill failures expose an errno code.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error
          }
        }
      }

      signal('SIGTERM')
      await Promise.race([entry.closed, delay(1_000)])
      signal('SIGKILL')
    }

    // EXTERNAL: Failed spawns have no PID but still emit close.
    await entry.closed

    entry.child = null
    entry.closed = null
    entry.socketPath = null

    if (entry.socketDirectory) {
      await fs.rm(entry.socketDirectory, { recursive: true, force: true })
      entry.socketDirectory = null
    }
  }

  private stopEntry(entry: ServiceEntry): Promise<void> {
    entry.stopped = true

    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer)
      entry.restartTimer = null
    }

    if (!entry.stopping) {
      entry.status = 'stopped'
      entry.abort.abort()
      entry.stopping = (async () => {
        await entry.starting?.catch(() => undefined)
        await this.terminate(entry)
        entry.status = 'stopped'
        entry.error = null
      })().finally(() => {
        entry.stopping = null
      })
    }

    return entry.stopping
  }

  async stop(context: ServiceContext, name: string): Promise<AppService> {
    const entry = await this.resolve(context, name)
    await this.stopEntry(entry)

    return this.snapshot(entry, context)
  }

  // EXTERNAL: Forward the raw WebSocket stream: VS Code's reconnect protocol is not a
  // message-level WebSocket bridge.
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse | null,
    socket: Duplex | null = null,
    head: Buffer = Buffer.alloc(0)
  ): boolean {
    const match = /^\/api\/app-services\/([a-f0-9]{24})(\/.*)?$/u.exec(
      request.url ?? ''
    )

    if (!match) {
      return false
    }

    const entry = this.entries.get(match[1]!)

    if (!entry || entry.status !== 'ready' || !entry.socketPath) {
      if (response) {
        response.writeHead(503, {
          'content-type': 'text/plain',
          'cache-control': 'no-store'
        })
        response.end('Service is not running. Reload the app to start it.')
      } else {
        socket?.end(
          'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'
        )
      }

      return true
    }

    const base = `${PREFIX}${entry.id}`

    if (!match[2]) {
      response?.writeHead(307, { location: `${base}/` }).end()
      socket?.destroy()

      return true
    }

    const headers = { ...request.headers }
    // EXTERNAL: Retain Host and Origin for code-server's own origin checks, including
    // remote HTTPS viewers.
    delete headers.authorization
    delete headers.cookie

    for (const key of Object.keys(headers)) {
      if (key.startsWith('tailscale-')) {
        delete headers[key]
      }
    }

    const upstream = httpRequest({
      socketPath: entry.socketPath,
      path: match[2],
      method: request.method,
      headers
    })

    upstream.on('error', () => {
      if (response && !response.headersSent) {
        response.writeHead(502, {
          'content-type': 'text/plain',
          'cache-control': 'no-store'
        })
        response.end(
          'The app service could not be reached. Reload the app to retry.'
        )
      } else {
        response?.destroy()
      }

      socket?.destroy()
    })
    upstream.on('response', (incoming) => {
      if (!response) {
        incoming.resume()
        socket?.destroy()

        return
      }

      const outgoing = { ...incoming.headers }

      if (
        outgoing.location?.startsWith('/') &&
        !outgoing.location.startsWith('//')
      ) {
        outgoing.location = base + outgoing.location
      }

      response.writeHead(incoming.statusCode ?? 502, outgoing)
      incoming.on('error', () => response.destroy())
      incoming.pipe(response)
    })

    if (socket) {
      entry.connections.add(socket)
      socket.once('close', () => {
        entry.connections.delete(socket)
        upstream.destroy()
      })
      socket.on('error', () => upstream.destroy())
      upstream.on('upgrade', (incoming, remote, upstreamHead) => {
        if (socket.destroyed) {
          remote.destroy()

          return
        }

        entry.connections.add(remote)
        remote.once('close', () => {
          entry.connections.delete(remote)
          socket.destroy()
        })
        remote.on('error', () => socket.destroy())
        socket.once('close', () => remote.destroy())
        socket.write(
          `HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n${incoming.rawHeaders.reduce((lines, value, index) => lines + (index % 2 === 0 ? `${value}: ` : `${value}\r\n`), '')}\r\n`
        )

        if (upstreamHead.length) {
          socket.write(upstreamHead)
        }

        if (head.length) {
          remote.write(head)
        }

        remote.pipe(socket)
        socket.pipe(remote)
      })
      upstream.end()
    } else {
      response?.once('close', () => upstream.destroy())
      request.once('aborted', () => upstream.destroy())
      request.pipe(upstream)
    }

    return true
  }

  async dispose(): Promise<void> {
    this.disposed = true

    if (this.timer) {
      clearInterval(this.timer)
    }

    await this.syncing
    await Promise.all(
      [...this.entries.values()].map((entry) => this.stopEntry(entry))
    )
  }
}
