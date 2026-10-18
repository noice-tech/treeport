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
import type { AppService } from '@treeport/shared'
import { z } from 'zod'
import { DomainError } from './core/domain'

// Services are trusted native applications. The declaration, not an iframe's
// request, supplies the executable. Workspace selection never changes the
// process's working directory: all trees share the package's service instance.
const declarationSchema = z.strictObject({
  scope: z.literal('instance'),
  executable: z.string().min(1),
  args: z.array(z.string()),
  readinessPath: z.string().regex(/^\/(?!\/)/u),
  query: z.record(z.string(), z.string()).default({})
})
const manifestSchema = z.looseObject({
  treeport: z.looseObject({
    services: z.record(z.string(), declarationSchema)
  })
})

interface ServiceContext {
  packageRoot: string
  treePath: string
}

interface ServiceEntry {
  id: string
  name: string
  packageRoot: string
  declaration: z.infer<typeof declarationSchema>
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
}

const PREFIX = '/api/app-services/'
const LOG_LIMIT = 64 * 1024

export class AppServices {
  private readonly entries = new Map<string, ServiceEntry>()
  private disposed = false

  constructor(private readonly dataDir: string) {}

  private async resolve(
    context: ServiceContext,
    name: string
  ): Promise<ServiceEntry> {
    if (this.disposed) {
      throw new DomainError('SERVICE_STOPPED', 'Treeport is shutting down', 503)
    }

    const packageRoot = await fs.realpath(context.packageRoot)
    const id = crypto
      .createHash('sha256')
      .update(`${packageRoot}\0${name}`)
      .digest('hex')
      .slice(0, 24)
    const existing = this.entries.get(id)
    if (existing) {
      return existing
    }

    const manifest = await fs
      .readFile(path.join(packageRoot, 'package.json'), 'utf8')
      .then((content) => manifestSchema.parse(JSON.parse(content)))
      .catch(() => {
        throw new DomainError(
          'SERVICE_MANIFEST_INVALID',
          'This package must declare treeport.services in package.json',
          400
        )
      })
    const declaration = Object.hasOwn(manifest.treeport.services, name)
      ? manifest.treeport.services[name]
      : undefined
    if (!declaration) {
      throw new DomainError(
        'SERVICE_NOT_FOUND',
        `Service “${name}” is not declared by this package`,
        404
      )
    }

    // Another app may have resolved the same package while reading its manifest.
    const current = this.entries.get(id)
    if (current) {
      return current
    }

    if (this.disposed) {
      throw new DomainError('SERVICE_STOPPED', 'Treeport is shutting down', 503)
    }

    const entry: ServiceEntry = {
      id,
      name,
      packageRoot,
      declaration,
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
      connections: new Set()
    }
    this.entries.set(id, entry)
    return entry
  }

  private snapshot(entry: ServiceEntry, context: ServiceContext): AppService {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(entry.declaration.query)) {
      query.set(key, value.replaceAll('${treePath}', context.treePath))
    }
    return {
      id: entry.id,
      name: entry.name,
      status: entry.status,
      pid:
        entry.child?.exitCode === null && entry.child.signalCode === null
          ? (entry.child.pid ?? null)
          : null,
      url:
        entry.status === 'ready'
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

    if (!entry.starting && entry.status !== 'ready') {
      entry.abort = new AbortController()
      entry.status = 'starting'
      entry.error = null
      entry.logs = ''
      entry.starting = this.start(entry)
        .catch(async (error) => {
          entry.error = error instanceof Error ? error.message : String(error)
          entry.status = 'failed'
          await this.terminate(entry)
          throw new DomainError('SERVICE_START_FAILED', entry.error, 503)
        })
        .finally(() => {
          entry.starting = null
        })
    }

    await entry.starting
    if (entry.status !== 'ready') {
      throw new DomainError(
        'SERVICE_STOPPED',
        entry.error ?? 'The service stopped while starting',
        503
      )
    }

    return this.snapshot(entry, context)
  }

  private async start(entry: ServiceEntry): Promise<void> {
    if (process.platform === 'win32') {
      throw new Error('App services currently require macOS or Linux')
    }

    // Reap a crashed generation before reusing its entry or socket.
    await this.terminate(entry)
    const dataDir = path.join(this.dataDir, 'app-services', entry.id)
    await fs.mkdir(dataDir, { recursive: true })
    // Keep Unix socket paths short even when the worktree/data directory is long.
    entry.socketDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-service-')
    )
    entry.socketPath = path.join(entry.socketDirectory, 'http.sock')
    const substitute = (value: string) =>
      value
        .replaceAll('${socket}', entry.socketPath!)
        .replaceAll('${dataDir}', dataDir)
        .replaceAll('${packageRoot}', entry.packageRoot)
    entry.abort.signal.throwIfAborted()
    const env = { ...process.env }
    // An editor's terminal environment must not redirect this launch into an
    // unrelated running editor, or identify its child terminals as our Pi tab.
    for (const key of Object.keys(env)) {
      if (
        key.startsWith('VSCODE_') ||
        key.startsWith('CODE_SERVER_') ||
        key.startsWith('TREEPORT_')
      ) {
        delete env[key]
      }
    }
    const child = spawn(
      substitute(entry.declaration.executable),
      entry.declaration.args.map(substitute),
      {
        cwd: entry.packageRoot,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    entry.child = child
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
        // Use exit, not close: orphaned descendants can hold the stdout pipes
        // open. Reap the group immediately before its ID can be reused.
        entry.stopping = this.terminate(entry)
          .catch((error) => {
            entry.error = `Service cleanup failed: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            entry.stopping = null
          })
      }
    })
    child.once('error', (error) => {
      entry.error = `Could not start ${entry.declaration.executable}: ${error.message}. Install the executable and make it available on Treeport's PATH.`
      entry.status = 'failed'
    })
    const append = (chunk: Buffer) => {
      entry.logs = (entry.logs + chunk.toString('utf8')).slice(-LOG_LIMIT)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
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
            path: entry.declaration.readinessPath,
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
      `Service “${entry.name}” did not become ready within 30 seconds.\n${entry.logs.slice(-4_096)}`
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
          // The group can already be gone after a failed spawn or normal exit.
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

    // Failed spawns have no PID but still emit close. Do not let that old
    // generation's callbacks race the next launch.
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

  // Called only after the daemon's normal HTTP/WebSocket ingress authorization.
  // Forward the raw WebSocket stream: VS Code's reconnect protocol is not a
  // message-level WebSocket bridge. Only registered service IDs are routable.
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
    // The upstream does not need Treeport/Tailscale credentials. Retain Host and
    // Origin for code-server's own origin checks, including remote HTTPS viewers.
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
    await Promise.all(
      [...this.entries.values()].map((entry) => this.stopEntry(entry))
    )
  }
}
