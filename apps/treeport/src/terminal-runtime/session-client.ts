import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  closeSession,
  inspectSession,
  withSessionRecovery
} from '@treeport/session-keeper'
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

interface PendingRequest {
  resolve: (status: SessionStatus | null) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  deadline: number
  remainingMs: number
  method: SessionRequest['method']
}

export class PersistentSession implements EnginePty {
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >()
  private readonly resizeListeners = new Set<
    (cols: number, rows: number) => void
  >()
  private readonly markerListeners = new Set<(data: string) => void>()
  private readonly pending = new Map<string, PendingRequest>()
  private socket: net.Socket | null = null
  private status: SessionStatus | null = null
  private termination: Promise<void> | null = null
  private processingAcknowledgement: Promise<void> | null = null
  private processingAcknowledgementSequence = 0
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
    void this.ready.catch(() => undefined)
  }

  get pid(): number {
    return this.status?.pid ?? 0
  }
  get process(): string {
    return this.status?.process ?? ''
  }
  get commandLine(): string[] {
    return this.status?.commandLine ?? []
  }
  get exitCode(): number | null {
    return this.status?.exitCode ?? null
  }
  get startupAborted(): boolean {
    return this.status?.startupAborted ?? false
  }

  static async create(options: {
    directory: string
    argv: string[]
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
    metadata: string
    executable: string
    terminalId?: string | undefined
    journalLimitBytes?: number | undefined
  }): Promise<PersistentSession> {
    const socketPath = sessionSocketPath(options.directory)

    // EXTERNAL: A custom TMPDIR can exceed the portable Unix socket pathname limit.
    if (Buffer.byteLength(socketPath) > 103) {
      throw new Error('Session socket path is too long; use a shorter TMPDIR')
    }

    await fs.mkdir(path.dirname(options.directory), {
      recursive: true,
      mode: 0o700
    })
    await fs.mkdir(options.directory, { mode: 0o700 })

    const ipcDirectory = path.join(
      os.tmpdir(),
      `treeport-${process.getuid?.() ?? 'user'}`
    )

    await fs.mkdir(ipcDirectory, { recursive: true, mode: 0o700 })

    const manifest: SessionManifest = {
      version: 1,
      ownership: 'lease-v1',
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

    const terminalId =
      options.terminalId === undefined
        ? null
        : /^term_[0-9a-f]{32}$/u.test(options.terminalId)
          ? options.terminalId
          : `term_${crypto.createHash('sha256').update(options.terminalId).digest('hex').slice(0, 32)}`

    // EXTERNAL: A detached process still inherits its parent's cgroup. Move the bootstrap
    // into a user scope before it forks the keeper, so stopping a supervisor's
    // control group cannot kill terminals. A scope stays alive while any of its
    // descendants remain, even after the short-lived bootstrap exits.
    const scopeEnvironment = {
      ...process.env,
      XDG_RUNTIME_DIR:
        process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`
    }

    const systemd =
      process.platform === 'linux'
        ? await Promise.all([
            promisify(execFile)(
              'systemctl',
              ['--user', 'show', '--property=Version', '--value'],
              { timeout: 2000, env: scopeEnvironment }
            ),
            promisify(execFile)('systemd-run', ['--help'], { timeout: 2000 })
          ]).then(
            ([, help]) => help.stdout,
            () => null
          )
        : null

    const executable = systemd === null ? options.executable : 'systemd-run'

    const args =
      systemd === null
        ? ['--detach', options.directory]
        : [
            '--user',
            '--scope',
            '--quiet',
            ...(systemd.includes('--expand-environment')
              ? ['--expand-environment=no']
              : []),
            '--',
            options.executable,
            '--detach',
            options.directory
          ]

    const child = spawn(executable, args, {
      argv0:
        terminalId === null
          ? 'treeport-session'
          : `treeport-session ${terminalId}`,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: systemd === null ? process.env : scopeEnvironment
    })

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
        const status = sessionStatusSchema.parse(JSON.parse(published))

        if (
          !status.startupAborted ||
          (await withSessionRecovery(options.directory, async () => true).catch(
            () => false
          ))
        ) {
          return PersistentSession.open(options.directory)
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 25))
    }

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

            if (pending.timer !== null) {
              clearTimeout(pending.timer)
            }

            this.resumeRequestTimeouts()

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
          this.fault ??
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
      // SAFETY: Node connection errors expose errno codes.
      if (
        !['ENOENT', 'ECONNREFUSED'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      ) {
        throw error
      }

      await withSessionRecovery(this.directory, async (status) => {
        this.status = sessionStatusSchema.parse(status)
        this.archived = true
        this.socket = null
        this.processedSequence = Number.MAX_SAFE_INTEGER

        for await (const record of SessionJournal.readRetained(
          this.directory
        )) {
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
      })
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
        return withSessionRecovery(this.directory, async () => this.status, {
          method: 'metadata',
          metadata: input.metadata
        }).then((status) => {
          this.manifest.metadata = input.metadata

          return status
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
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: null,
        deadline: 0,
        remainingMs:
          this.replaying || input.method === 'attach' ? 120000 : 10000,
        method: input.method
      }

      this.pending.set(id, pending)

      if (input.method === 'write') {
        this.pauseRequestTimeouts()
      }

      this.resumeRequestTimeouts()

      socket.write(`${JSON.stringify({ ...input, id })}\n`)
    })
  }

  private armRequestTimeout(id: string, pending: PendingRequest): void {
    pending.deadline = Date.now() + pending.remainingMs
    pending.timer = setTimeout(() => {
      this.pending.delete(id)
      pending.reject(new Error(`Session request timed out: ${pending.method}`))
      this.fail(new Error('Session request timed out; command remains alive'))
    }, pending.remainingMs)
  }

  private submit(input: RequestInput): void {
    void this.request(input).catch((error) => this.fail(error))
  }
  write(data: string | Buffer): void {
    void this.writeAndWait(data).catch((error) => this.fail(error))
  }
  async writeAndWait(data: string | Buffer): Promise<void> {
    await this.request({
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
    if (this.archivePaused) {
      return
    }

    this.archivePaused = true
    this.pauseRequestTimeouts()
    this.socket?.pause()
  }
  private pauseRequestTimeouts(): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== null) {
        clearTimeout(pending.timer)
        pending.timer = null
        pending.remainingMs = Math.max(0, pending.deadline - Date.now())
      }
    }
  }
  private resumeRequestTimeouts(): void {
    if (
      this.archivePaused ||
      [...this.pending.values()].some((pending) => pending.method === 'write')
    ) {
      return
    }

    for (const [id, pending] of this.pending) {
      if (pending.timer === null) {
        this.armRequestTimeout(id, pending)
      }
    }
  }
  resume(): void {
    if (this.archivePaused) {
      this.archivePaused = false
      this.resumeRequestTimeouts()
    }

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
    this.processingAcknowledgementSequence = Math.max(
      this.processingAcknowledgementSequence,
      sequence
    )

    if (this.processingAcknowledgement !== null) {
      return
    }

    this.processingAcknowledgement = (async () => {
      let acknowledged = -1

      while (acknowledged < this.processingAcknowledgementSequence) {
        acknowledged = this.processingAcknowledgementSequence
        await this.request({ method: 'processed', sequence: acknowledged })
      }

      this.processingAcknowledgement = null
    })().catch((error) => {
      this.processingAcknowledgement = null
      this.fail(error)
    })
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

  terminate(): Promise<void> {
    this.termination ??= this.terminateOwnedSession().finally(() => {
      this.termination = null
    })

    return this.termination
  }

  async inspect(): Promise<SessionStatus> {
    return sessionStatusSchema.parse(
      await inspectSession({
        directory: this.directory,
        socketPath: this.manifest.socketPath,
        token: this.manifest.token
      })
    )
  }

  private async terminateOwnedSession(): Promise<void> {
    await closeSession({
      directory: this.directory,
      socketPath: this.manifest.socketPath,
      token: this.manifest.token
    })
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
      if (pending.timer !== null) {
        clearTimeout(pending.timer)
      }

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
