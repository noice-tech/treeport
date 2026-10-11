import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { IDisposable, IPty } from 'node-pty'
import { SessionJournal } from './session-journal'
import {
  SESSION_DEFAULT_JOURNAL_LIMIT,
  SESSION_MAX_FRAME_BYTES,
  sessionFrameSchema,
  sessionManifestSchema,
  sessionStatusSchema,
  type SessionManifest,
  type SessionRecord,
  type SessionRequest,
  type SessionStatus
} from './session-protocol'

type EnginePty = Pick<
  IPty,
  | 'pid'
  | 'process'
  | 'write'
  | 'resize'
  | 'pause'
  | 'resume'
  | 'kill'
  | 'onData'
  | 'onExit'
>
type RequestInput = SessionRequest extends infer Request
  ? Request extends SessionRequest
    ? Omit<Request, 'id'>
    : never
  : never

function sessionSocketPath(directory: string): string {
  const key = crypto
    .createHash('sha256')
    .update(path.resolve(directory))
    .digest('hex')
    .slice(0, 24)
  return path.join(
    os.tmpdir(),
    `treeport-${process.getuid?.() ?? 'user'}`,
    `session-${key}.sock`
  )
}

/** A detachable engine-side handle. dispose() NEVER terminates the PTY. */
export class PersistentSession implements EnginePty {
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >()
  private readonly resizeListeners = new Set<
    (cols: number, rows: number) => void
  >()
  private readonly markerListeners = new Set<(data: string) => void>()
  private readonly pending = new Map<
    string,
    {
      resolve: (status: SessionStatus | null) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private socket: net.Socket | null = null
  private status: SessionStatus | null = null
  private closed = false
  private archivePaused = false
  private archiveResume: (() => void) | null = null
  archived = false
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  sequence = 0
  recordTime = 0
  replaying = true
  processedSequence = 0
  readonly ready: Promise<void>
  fault: Error | null = null

  private constructor(
    readonly directory: string,
    readonly manifest: SessionManifest,
    private readonly journalLimitBytes: number | undefined
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // A failure may arrive before the engine starts awaiting replay.
    void this.ready.catch(() => undefined)
  }

  get pid(): number {
    return this.status?.pid ?? 0
  }
  get process(): string {
    return this.status?.process ?? ''
  }
  get exitCode(): number | null {
    return this.status?.exitCode ?? null
  }

  static async create(options: {
    directory: string
    entryPath: string
    argv: string[]
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
    metadata: string
    executable?: string | undefined
    arguments?: string[] | undefined
    journalLimitBytes?: number | undefined
  }): Promise<PersistentSession> {
    const socketPath = sessionSocketPath(options.directory)
    // Fail before allocating a command or leaving discovery artifacts when a
    // custom TMPDIR exceeds the portable Unix socket pathname limit.
    if (Buffer.byteLength(socketPath) > 103) {
      throw new Error('Session socket path is too long; use a shorter TMPDIR')
    }

    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 })
    const ipcDirectory = path.join(
      os.tmpdir(),
      `treeport-${process.getuid?.() ?? 'user'}`
    )
    await fs.mkdir(ipcDirectory, { recursive: true, mode: 0o700 })
    const manifest: SessionManifest = {
      version: 1,
      token: crypto.randomBytes(32).toString('hex'),
      socketPath,
      argv: options.argv,
      cwd: options.cwd,
      env: options.env,
      cols: options.cols,
      rows: options.rows,
      metadata: options.metadata,
      journalLimitBytes:
        options.journalLimitBytes ?? SESSION_DEFAULT_JOURNAL_LIMIT
    }
    await fs.writeFile(
      path.join(options.directory, 'manifest.json'),
      JSON.stringify(manifest),
      { flag: 'wx', mode: 0o600 }
    )
    const log = await fs.open(
      path.join(options.directory, 'owner.log'),
      'a',
      0o600
    )
    const child = spawn(
      options.executable ?? process.execPath,
      [
        ...(options.arguments ?? []),
        options.entryPath,
        '--detach',
        options.directory
      ],
      {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: process.env
      }
    )
    child.unref()
    let launchError: Error | null = null
    const bootstrapped = new Promise<void>((resolve) => {
      child.once('error', (error) => {
        launchError = error
        resolve()
      })
      child.once('exit', (code, signal) => {
        if (code !== 0 || signal !== null) {
          launchError = new Error(
            `Session bootstrap exited during startup (${code ?? signal})`
          )
        }

        resolve()
      })
    })
    await log.close()
    // The keeper must already be outside the daemon's descendant tree before
    // create returns, not merely scheduled to become orphaned later.
    const deadline = Date.now() + 10000
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Session bootstrap timed out: ${options.directory}`)
          ),
        10000
      )
      void bootstrapped.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    while (Date.now() < deadline) {
      if (launchError) {
        throw launchError
      }

      const published = await fs
        .readFile(path.join(options.directory, 'status.json'), 'utf8')
        .catch((error) => {
          // SAFETY: Node filesystem failures expose errno codes.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }

          return null
        })
      if (published !== null) {
        sessionStatusSchema.parse(JSON.parse(published))
        return PersistentSession.open(options.directory)
      }

      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    // Do not kill a possibly live owner on a timeout. Discovery can reconnect it.
    throw new Error(`Session owner startup timed out: ${options.directory}`)
  }

  static async open(
    directory: string,
    journalLimitBytes?: number
  ): Promise<PersistentSession> {
    const manifest = sessionManifestSchema.parse(
      JSON.parse(
        await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')
      )
    )
    if (manifest.socketPath !== sessionSocketPath(directory)) {
      throw new Error('Session manifest does not identify its socket')
    }

    return new PersistentSession(directory, manifest, journalLimitBytes)
  }

  async connect(): Promise<void> {
    if (this.socket) {
      throw new Error('Session is already connected')
    }

    const socket = net.createConnection(this.manifest.socketPath)
    this.socket = socket
    socket.setEncoding('utf8')
    let connected = false
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > SESSION_MAX_FRAME_BYTES) {
        this.fail(new Error('Session frame exceeds size limit'))
        return
      }

      let boundary: number
      try {
        while ((boundary = buffer.indexOf('\n')) !== -1) {
          const frame = sessionFrameSchema.parse(
            JSON.parse(buffer.slice(0, boundary))
          )
          buffer = buffer.slice(boundary + 1)
          if (frame.type === 'response') {
            const pending = this.pending.get(frame.id)
            if (!pending) {
              throw new Error('Unexpected session response')
            }

            this.pending.delete(frame.id)
            clearTimeout(pending.timer)
            if (frame.error) {
              pending.reject(new Error(frame.error))
            } else {
              if (frame.status) {
                this.status = frame.status
                if (this.replaying && this.sequence === 0) {
                  this.processedSequence = frame.status.processedSequence
                }
              }

              pending.resolve(frame.status)
            }
          } else if (frame.type === 'ready') {
            if (frame.sequence !== this.sequence) {
              throw new Error('Session replay fence mismatch')
            }

            this.replaying = false
            this.readyResolve?.()
          } else if (frame.type === 'fault') {
            // A storage fault pauses the owner, not its command. Keep this
            // connection available for explicit close and display the fault.
            this.fault = new Error(frame.message)
            console.error(`Persistent terminal session: ${frame.message}`)
          } else {
            this.acceptRecord(frame)
          }
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', (error) => {
      if (connected) {
        this.fail(error)
      }
    })
    socket.on('close', () => {
      if (connected && !this.closed) {
        this.fail(
          new Error(
            'Persistent session disconnected; command has not been terminated'
          )
        )
      }
    })
    connected = await new Promise<boolean>((resolve, reject) => {
      socket.once('connect', () => resolve(true))
      socket.once('error', reject)
    }).catch(async (error) => {
      // Refused sockets can be stale. An inaccessible LIVE keeper is not an
      // exited session: never replace it, signal it, or reinterpret its files.
      // SAFETY: Node connection errors expose errno codes.
      if (
        !['ENOENT', 'ECONNREFUSED'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      ) {
        throw error
      }

      const status = sessionStatusSchema.parse(
        JSON.parse(
          await fs.readFile(path.join(this.directory, 'status.json'), 'utf8')
        )
      )
      try {
        process.kill(status.ownerPid, 0)
        throw error
      } catch (cause) {
        // SAFETY: Node signaling errors expose errno codes.
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw cause
        }
      }
      this.status = status
      this.archived = true
      this.socket = null
      // All archived queries are historical; there is no writable PTY.
      this.processedSequence = Number.MAX_SAFE_INTEGER
      for await (const record of SessionJournal.readRetained(this.directory)) {
        while (this.archivePaused && !this.closed) {
          await new Promise<void>((resolve) => {
            this.archiveResume = resolve
          })
        }
        if (this.closed) {
          throw new Error('Archived session replay detached')
        }

        this.acceptRecord(record)
      }
      this.replaying = false
      this.readyResolve?.()
      return false
    })
    if (!connected) {
      return
    }

    await this.request({
      method: 'attach',
      token: this.manifest.token,
      journalLimitBytes: this.journalLimitBytes
    })
  }

  private acceptRecord(record: SessionRecord): void {
    if (record.sequence !== this.sequence + 1) {
      throw new Error('Session output has a sequence gap')
    }

    this.sequence = record.sequence
    this.recordTime = record.at
    if (record.type === 'output') {
      for (const listener of this.dataListeners) {
        listener(record.data)
      }
    } else if (record.type === 'resize') {
      for (const listener of this.resizeListeners) {
        listener(record.cols, record.rows)
      }
    } else if (record.type === 'marker') {
      for (const listener of this.markerListeners) {
        listener(record.data)
      }
    } else {
      if (this.status) {
        this.status.exitCode = record.exitCode
      }

      for (const listener of this.exitListeners) {
        listener({ exitCode: record.exitCode })
      }
    }
  }

  onData(listener: (data: string) => void): IDisposable {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void
  ): IDisposable {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }
  onResize(listener: (cols: number, rows: number) => void): IDisposable {
    this.resizeListeners.add(listener)
    return { dispose: () => this.resizeListeners.delete(listener) }
  }

  onMarker(listener: (data: string) => void): IDisposable {
    this.markerListeners.add(listener)
    return { dispose: () => this.markerListeners.delete(listener) }
  }

  async pauseOwner(paused: boolean): Promise<void> {
    await this.request({ method: 'pause', paused })
  }
  async recordMarker(data: string): Promise<void> {
    await this.request({ method: 'marker', data })
  }

  private request(input: RequestInput): Promise<SessionStatus | null> {
    if (this.archived) {
      if (input.method === 'metadata') {
        const manifest = { ...this.manifest, metadata: input.metadata }
        const temporary = path.join(
          this.directory,
          'manifest-' + crypto.randomUUID() + '.tmp'
        )
        return fs
          .writeFile(temporary, JSON.stringify(manifest), {
            mode: 0o600,
            flag: 'wx'
          })
          .then(() =>
            fs.rename(temporary, path.join(this.directory, 'manifest.json'))
          )
          .then(() => {
            this.manifest.metadata = input.metadata
            return this.status
          })
      }

      if (input.method === 'resize') {
        for (const listener of this.resizeListeners) {
          listener(input.cols, input.rows)
        }
      } else if (!['processed', 'status', 'pause'].includes(input.method)) {
        return Promise.reject(
          new Error('Session keeper exited; this terminal has no writable PTY')
        )
      }

      return Promise.resolve(this.status)
    }

    const socket = this.socket
    if (!socket || socket.destroyed) {
      return Promise.reject(this.fault ?? new Error('Session is not connected'))
    }

    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(new Error(`Session request timed out: ${input.method}`))
          // A timed-out input must not be retried automatically (it may have run).
          this.fail(
            new Error('Session request timed out; command remains alive')
          )
        },
        this.replaying || input.method === 'attach' ? 120000 : 10000
      )
      this.pending.set(id, { resolve, reject, timer })
      socket.write(`${JSON.stringify({ ...input, id })}\n`)
    })
  }

  private submit(input: RequestInput): void {
    void this.request(input).catch((error) => this.fail(error))
  }
  write(data: string | Buffer): void {
    this.submit({
      method: 'write',
      data: Buffer.isBuffer(data) ? data.toString('base64') : data,
      encoding: Buffer.isBuffer(data) ? 'base64' : 'utf8'
    })
  }
  resize(cols: number, rows: number): void {
    this.submit({ method: 'resize', cols, rows })
  }
  async resizeAndWait(cols: number, rows: number): Promise<void> {
    await this.request({ method: 'resize', cols, rows })
  }
  pause(): void {
    this.archivePaused = true
    this.socket?.pause()
  }
  resume(): void {
    this.archivePaused = false
    this.archiveResume?.()
    this.archiveResume = null
    this.socket?.resume()
  }
  kill(signal: string = 'SIGHUP'): void {
    if (!['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'].includes(signal)) {
      throw new Error('Unsupported terminal signal')
    }

    // SAFETY: The signal was checked against the protocol's allowlist above.
    this.submit({
      method: 'signal',
      signal: signal as 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'
    })
  }
  markProcessed(sequence: number): void {
    this.submit({ method: 'processed', sequence })
  }
  async flushRequests(sequence: number): Promise<void> {
    await this.request({ method: 'processed', sequence })
  }
  async activate(): Promise<void> {
    await this.request({ method: 'pause', paused: false })
  }
  async refreshStatus(): Promise<void> {
    await this.request({ method: 'status' })
  }
  async setMetadata(metadata: string): Promise<void> {
    await this.request({ method: 'metadata', metadata })
  }
  private control(method: 'inspect' | 'terminate'): Promise<SessionStatus> {
    // No attachment or replay: explicit close works even after the engine's
    // channel failed, or while its parser has backpressured incoming records.
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.manifest.socketPath)
      const id = crypto.randomUUID()
      let buffer = ''
      let done = false
      const finish = (status: SessionStatus | null, error: Error | null) => {
        if (done) {
          return
        }

        done = true
        socket.destroy()
        if (error) {
          reject(error)
        } else if (status) {
          resolve(status)
        }
      }
      socket.setEncoding('utf8')
      socket.setTimeout(10000, () =>
        finish(null, new Error('Independent session control timed out'))
      )
      socket.on('error', (error) => finish(null, error))
      socket.on('close', () =>
        finish(null, new Error('Independent session control disconnected'))
      )
      socket.on('connect', () =>
        socket.write(
          JSON.stringify({ id, method, token: this.manifest.token }) + '\n'
        )
      )
      socket.on('data', (data) => {
        buffer += data
        if (Buffer.byteLength(buffer) > SESSION_MAX_FRAME_BYTES) {
          finish(null, new Error('Session control frame exceeds its limit'))
          return
        }

        const boundary = buffer.indexOf('\n')
        if (boundary === -1) {
          return
        }

        try {
          const frame = sessionFrameSchema.parse(
            JSON.parse(buffer.slice(0, boundary))
          )
          if (
            frame.type !== 'response' ||
            frame.id !== id ||
            !frame.status ||
            frame.error
          ) {
            finish(
              null,
              new Error(
                frame.type === 'response'
                  ? (frame.error ?? 'Invalid session control response')
                  : 'Invalid session control response'
              )
            )
            return
          }

          finish(frame.status, null)
        } catch (error) {
          finish(
            null,
            error instanceof Error ? error : new Error(String(error))
          )
        }
      })
    })
  }

  async terminate(): Promise<void> {
    const current = await this.control('inspect').catch(async (error) => {
      // SAFETY: Node connection errors expose errno codes. Never unlink an
      // unidentified live owner; a dead cached owner permits explicit cleanup.
      if (
        !['ENOENT', 'ECONNREFUSED'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        ) ||
        !this.status
      ) {
        throw error
      }

      let alive = true
      try {
        process.kill(this.status.ownerPid, 0)
      } catch (cause) {
        // SAFETY: Node signaling errors expose errno codes.
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw cause
        }

        alive = false
      }
      if (alive) {
        throw error
      }

      const source = await fs
        .readFile(path.join(this.directory, 'manifest.json'), 'utf8')
        .catch((cause) => {
          // SAFETY: Node filesystem errors expose errno codes.
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw cause
          }

          return null
        })
      if (source !== null) {
        const manifest = sessionManifestSchema.parse(JSON.parse(source))
        const status = sessionStatusSchema.parse(
          JSON.parse(
            await fs.readFile(path.join(this.directory, 'status.json'), 'utf8')
          )
        )
        if (
          manifest.token !== this.manifest.token ||
          manifest.socketPath !== sessionSocketPath(this.directory) ||
          status.ownerPid !== this.status.ownerPid ||
          status.pid !== this.status.pid
        ) {
          throw error
        }

        await fs.rm(this.directory, { recursive: true, force: true })
        await fs.rm(this.manifest.socketPath, { force: true })
      }

      return null
    })
    if (current) {
      if (
        this.status &&
        (current.ownerPid !== this.status.ownerPid ||
          current.pid !== this.status.pid)
      ) {
        throw new Error('Session control does not identify the retained owner')
      }

      await this.control('terminate')
    }

    this.dispose()
  }
  dispose(): void {
    this.closed = true
    this.resume()
    this.socket?.destroy()
    this.rejectPending(new Error('Session engine detached'))
    this.readyReject?.(new Error('Session engine detached during replay'))
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
  private fail(error: Error): void {
    this.fault = error
    this.readyReject?.(error)
    this.rejectPending(error)
    this.socket?.destroy()
  }
}
