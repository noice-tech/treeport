import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Socket } from 'node:net'
import type { TerminalSnapshotLink } from '@treeport/shared'
import type {
  HostedTerminal,
  TerminalProcess,
  TerminalSessionState,
  TerminalTitleState,
  TerminalTraceContext
} from './core/terminal'
import type { TerminalHostRuntimeEvent } from './terminal-host-sessions'
import {
  encodeTerminalHostFrame,
  TERMINAL_HOST_PROTOCOL_VERSION,
  TerminalHostFrameDecoder,
  terminalHostRecordSchema,
  type TerminalHostCreateInput,
  type TerminalHostEventFrame,
  type TerminalHostFrame,
  type TerminalHostRecord,
  type TerminalHostRequestFrame,
  type TerminalHostRequestInput,
  type TerminalHostResult,
  type TerminalHostResponseFrame,
  type TerminalHostResults
} from './terminal-host-protocol'

const TERMINAL_HOST_REQUEST_TIMEOUT_MS = 30_000
const TERMINAL_HOST_START_TIMEOUT_MS = 10_000

interface PendingRequest {
  resolve(value: TerminalHostResult): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

class TerminalHostRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hostProtocolVersion?: number,
    readonly liveSessionCount?: number
  ) {
    super(message)
    this.name = 'TerminalHostRequestError'
  }
}

export interface TerminalHostClientOptions {
  dataDir: string
  runtimeDir: string
  launcherPath: string
  hostEntryPath: string
  hostExecutable?: string
  hostArguments?: string[]
  environment?: NodeJS.ProcessEnv
  spawnHost?: typeof spawn
}

interface TerminalHostPaths {
  hostKey: string
  socketPath: string
  recordPath: string
  tokenPath: string
  hostRuntimeDir: string
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // SAFETY: Node process signal errors can include an errno code.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function terminalHostPaths(
  dataDir: string,
  runtimeDir: string
): TerminalHostPaths {
  const hostKey = crypto
    .createHash('sha256')
    .update(path.resolve(dataDir))
    .digest('hex')
    .slice(0, 20)
  const ipcDirectory = path.join(
    os.tmpdir(),
    `treeport-${process.getuid?.() ?? 'user'}`
  )
  return {
    hostKey,
    socketPath: path.join(ipcDirectory, `terminal-${hostKey}.sock`),
    recordPath: path.join(runtimeDir, `terminal-host-${hostKey}.json`),
    tokenPath: path.join(dataDir, 'terminal-host.token'),
    hostRuntimeDir: path.join(runtimeDir, `terminal-host-${hostKey}`)
  }
}

async function readOrCreateToken(tokenPath: string): Promise<string> {
  const created = crypto.randomBytes(32).toString('base64url')
  await fs
    .writeFile(tokenPath, `${created}\n`, {
      flag: 'wx',
      mode: 0o600
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error
      }
    })
  await fs.chmod(tokenPath, 0o600)
  return (await fs.readFile(tokenPath, 'utf8')).trim()
}

async function openSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const fail = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.off('error', fail)
      socket.on('error', () => undefined)
      socket.setNoDelay(true)
      resolve(socket)
    })
  })
}

export class TerminalHostClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly outputListeners = new Map<
    string,
    Set<(data: string, sequence: number) => void>
  >()
  private readonly runtimeListeners = new Map<
    string,
    Set<(event: TerminalHostRuntimeEvent) => void>
  >()
  private readonly decoder = new TerminalHostFrameDecoder()
  private closed = false
  private supportsTraceContext = false

  private constructor(
    private readonly socket: Socket,
    readonly record: TerminalHostRecord
  ) {
    socket.on('data', (chunk) => this.receive(chunk))
    socket.once('close', () => this.handleClose())
  }

  static async connect(
    socketPath: string,
    token: string,
    hostKey: string,
    expectedHostId?: string
  ): Promise<TerminalHostClient> {
    const socket = await openSocket(socketPath)
    const provisionalRecord: TerminalHostRecord = {
      protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
      hostId: '',
      hostKey,
      pid: 0,
      socketPath,
      startedAt: ''
    }
    const client = new TerminalHostClient(socket, provisionalRecord)
    let handshake: TerminalHostResults['handshake']
    try {
      handshake = await client.request('handshake', {
        token,
        hostKey,
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION
      })
    } catch (error) {
      client.dispose()
      throw error
    }

    if (expectedHostId && handshake.hostId !== expectedHostId) {
      client.dispose()
      throw new TerminalHostRequestError(
        'HOST_MISMATCH',
        'The terminal host identifier differs from its discovery record'
      )
    }

    client.supportsTraceContext = handshake.traceContext === true
    Object.assign(client.record, handshake)
    return client
  }

  initialize(): Promise<boolean> {
    return Promise.resolve(true)
  }

  createTerminal(
    input: TerminalHostCreateInput,
    trace?: TerminalTraceContext
  ): Promise<void> {
    return this.request('create', input, trace).then(() => undefined)
  }

  listTerminals(worktreeId: string): Promise<HostedTerminal[]> {
    return this.request('inventory', { worktreeId })
  }

  terminalState(terminalId: string): Promise<TerminalSessionState> {
    return this.request('state', { terminalId })
  }

  async attach(
    terminalId: string,
    listener: (data: string, sequence: number) => void,
    trace?: TerminalTraceContext
  ): Promise<{
    data: string
    links: TerminalSnapshotLink[]
    fence: number
    cols: number
    rows: number
    unsubscribe: () => void
  } | null> {
    const listeners =
      this.outputListeners.get(terminalId) ??
      new Set<(data: string, sequence: number) => void>()
    listeners.add(listener)
    this.outputListeners.set(terminalId, listeners)
    let snapshot: TerminalHostResults['attach']
    try {
      snapshot = await this.request('attach', { terminalId }, trace)
    } catch (error) {
      listeners.delete(listener)
      if (!listeners.size) {
        this.outputListeners.delete(terminalId)
      }

      throw error
    }

    if (snapshot === null) {
      listeners.delete(listener)
      if (!listeners.size) {
        this.outputListeners.delete(terminalId)
      }

      return null
    }

    let active = true
    const unsubscribe = () => {
      if (!active) {
        return
      }

      active = false
      listeners.delete(listener)
      if (!listeners.size) {
        this.outputListeners.delete(terminalId)
        void this.request('unsubscribeOutput', { terminalId }).catch(
          (error) => {
            console.error(
              `[Treeport] Failed to unsubscribe terminal output for ${terminalId}:`,
              error instanceof Error ? error.message : String(error)
            )
          }
        )
      }
    }
    return { ...snapshot, links: snapshot.links ?? [], unsubscribe }
  }

  async subscribeRuntime(
    terminalId: string,
    listener: (event: TerminalHostRuntimeEvent) => void
  ): Promise<() => void> {
    const listeners =
      this.runtimeListeners.get(terminalId) ??
      new Set<(event: TerminalHostRuntimeEvent) => void>()
    const first = listeners.size === 0
    listeners.add(listener)
    this.runtimeListeners.set(terminalId, listeners)
    if (first) {
      try {
        await this.request('subscribeRuntime', { terminalId })
      } catch (error) {
        listeners.delete(listener)
        if (!listeners.size) {
          this.runtimeListeners.delete(terminalId)
        }

        throw error
      }
    }

    let active = true
    return () => {
      if (!active) {
        return
      }

      active = false
      listeners.delete(listener)
      if (!listeners.size) {
        this.runtimeListeners.delete(terminalId)
        void this.request('unsubscribeRuntime', { terminalId }).catch(
          (error) => {
            console.error(
              `[Treeport] Failed to unsubscribe terminal runtime for ${terminalId}:`,
              error instanceof Error ? error.message : String(error)
            )
          }
        )
      }
    }
  }

  runtimeState(terminalId: string) {
    return this.request('runtimeState', { terminalId })
  }

  write(
    terminalId: string,
    data: string | Buffer,
    authority: { attachmentId: string; generation: number }
  ): Promise<void> {
    return this.request('write', {
      terminalId,
      data: Buffer.isBuffer(data) ? data.toString('base64') : data,
      encoding: Buffer.isBuffer(data) ? 'base64' : 'utf8',
      authority
    }).then(() => undefined)
  }

  prepareQueryAuthority(
    terminalId: string
  ): Promise<{ transitionId: string; fence: number }> {
    return this.request('prepareQueryAuthority', { terminalId })
  }

  activateQueryAuthority(
    terminalId: string,
    transitionId: string,
    attachmentId: string,
    generation: number
  ): Promise<void> {
    return this.request('activateQueryAuthority', {
      terminalId,
      transitionId,
      attachmentId,
      generation
    }).then(() => undefined)
  }

  useHostQueryAuthority(terminalId: string): Promise<void> {
    return this.request('hostQueryAuthority', { terminalId }).then(
      () => undefined
    )
  }

  resize(terminalId: string, cols: number, rows: number): Promise<void> {
    return this.request('resize', { terminalId, cols, rows }).then(
      () => undefined
    )
  }

  captureTerminal(terminalId: string, lines: number): Promise<string | null> {
    return this.request('capture', { terminalId, lines })
  }

  renameTerminal(
    terminalId: string,
    name: string,
    updatedAt: string
  ): Promise<void> {
    return this.request('rename', { terminalId, name, updatedAt }).then(
      () => undefined
    )
  }

  listProcesses(worktreeId: string): Promise<TerminalProcess[]> {
    return this.request('processes', { worktreeId })
  }

  terminalTitleState(terminalId: string): Promise<TerminalTitleState | null> {
    return this.request('titleState', { terminalId })
  }

  signalTerminal(
    terminalId: string,
    signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'
  ): Promise<void> {
    return this.request('signal', { terminalId, signal }).then(() => undefined)
  }

  killTerminal(
    terminalId: string,
    trace?: TerminalTraceContext
  ): Promise<void> {
    return this.request('kill', { terminalId }, trace).then(() => undefined)
  }

  killWorktree(worktreeId: string): Promise<string[]> {
    return this.request('killWorktree', { worktreeId })
  }

  shutdownIfEmpty(): Promise<void> {
    return this.request('shutdown', { ifEmpty: true }).then(() => undefined)
  }

  dispose(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    this.socket.destroy()
    this.handleClose()
  }

  private request<Method extends keyof TerminalHostResults>(
    method: Method,
    input: TerminalHostRequestInput,
    trace?: TerminalTraceContext
  ): Promise<TerminalHostResults[Method]> {
    if (this.closed) {
      return Promise.reject(new Error('Terminal host connection is closed'))
    }

    const id = crypto.randomUUID()
    const frame: TerminalHostRequestFrame = {
      protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
      type: 'request',
      id,
      method,
      input
    }
    if (trace && this.supportsTraceContext) {
      frame.trace = trace
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Terminal host request timed out: ${method}`))
      }, TERMINAL_HOST_REQUEST_TIMEOUT_MS)
      timeout.unref()
      this.pending.set(id, {
        resolve: (value) => {
          // SAFETY: The host response belongs to this request method and identifier.
          resolve(value as TerminalHostResults[Method])
        },
        reject,
        timeout
      })
      try {
        this.socket.write(encodeTerminalHostFrame(frame))
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private receive(chunk: Buffer): void {
    let frames: TerminalHostFrame[]
    try {
      frames = this.decoder.push(chunk)
    } catch {
      this.socket.destroy()
      return
    }

    for (const frame of frames) {
      const explicitProtocolFailure =
        frame.type === 'response' &&
        frame.error?.code === 'INCOMPATIBLE_PROTOCOL'
      if (
        frame.protocolVersion !== TERMINAL_HOST_PROTOCOL_VERSION &&
        !explicitProtocolFailure
      ) {
        if (frame.type === 'response') {
          const pending = this.pending.get(frame.id)
          if (pending) {
            this.pending.delete(frame.id)
            clearTimeout(pending.timeout)
            pending.reject(
              new TerminalHostRequestError(
                'INCOMPATIBLE_PROTOCOL',
                `Terminal host sent protocol ${frame.protocolVersion}; daemon expects ${TERMINAL_HOST_PROTOCOL_VERSION}`,
                frame.protocolVersion
              )
            )
          }
        }

        this.socket.destroy()
        return
      }

      if (frame.type === 'response') {
        this.receiveResponse(frame)
      } else if (frame.type === 'event') {
        this.receiveEvent(frame)
      } else {
        this.socket.destroy()
      }
    }
  }

  private receiveResponse(frame: TerminalHostResponseFrame): void {
    const pending = this.pending.get(frame.id)
    if (!pending) {
      return
    }

    this.pending.delete(frame.id)
    clearTimeout(pending.timeout)
    if (frame.error) {
      pending.reject(
        new TerminalHostRequestError(
          frame.error.code,
          frame.error.message,
          frame.error.hostProtocolVersion,
          frame.error.liveSessionCount
        )
      )
      return
    }

    if (frame.result === undefined) {
      pending.reject(new Error('Terminal host response omitted its result'))
      this.socket.destroy()
      return
    }

    pending.resolve(frame.result)
  }

  private receiveEvent(frame: TerminalHostEventFrame): void {
    if (frame.event === 'output') {
      for (const listener of this.outputListeners.get(frame.data.terminalId) ??
        []) {
        listener(frame.data.output, frame.data.sequence)
      }
      return
    }

    for (const listener of this.runtimeListeners.get(frame.data.terminalId) ??
      []) {
      listener(frame.data.value)
    }
  }

  private handleClose(): void {
    if (!this.closed) {
      this.closed = true
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Terminal host connection closed'))
    }
    this.pending.clear()
    this.outputListeners.clear()
    this.runtimeListeners.clear()
  }
}

async function readRecord(
  recordPath: string
): Promise<TerminalHostRecord | null> {
  return fs
    .readFile(recordPath, 'utf8')
    .then((value) => terminalHostRecordSchema.parse(JSON.parse(value)))
    .catch(() => null)
}

function isDefinitiveConnectionFailure(error: Error): boolean {
  return (
    error instanceof TerminalHostRequestError &&
    ['AUTH_FAILED', 'HOST_MISMATCH', 'INCOMPATIBLE_PROTOCOL'].includes(
      error.code
    )
  )
}

function isStaleSocketFailure(error: Error): boolean {
  // SAFETY: Node connection failures expose their stable errno through code.
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

export async function connectOrStartTerminalHost(
  options: TerminalHostClientOptions
): Promise<TerminalHostClient> {
  const paths = terminalHostPaths(options.dataDir, options.runtimeDir)
  await Promise.all([
    fs.mkdir(options.dataDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(options.runtimeDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(path.dirname(paths.socketPath), { recursive: true, mode: 0o700 }),
    fs.mkdir(paths.hostRuntimeDir, { recursive: true, mode: 0o700 })
  ])
  await fs.chmod(path.dirname(paths.socketPath), 0o700)
  const token = await readOrCreateToken(paths.tokenPath)
  const record = await readRecord(paths.recordPath)
  if (record) {
    try {
      return await TerminalHostClient.connect(
        record.socketPath,
        token,
        paths.hostKey,
        record.hostId
      )
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (isDefinitiveConnectionFailure(failure)) {
        throw failure
      }

      if (Number.isInteger(record.pid) && processExists(record.pid)) {
        throw new Error(
          `Terminal host PID ${record.pid} exists but its socket is unavailable. Treeport will not signal it.`
        )
      }

      if (
        record.hostKey === paths.hostKey &&
        record.socketPath === paths.socketPath &&
        isStaleSocketFailure(failure)
      ) {
        await Promise.all([
          fs.rm(paths.recordPath, { force: true }),
          fs.rm(paths.socketPath, { force: true })
        ])
      } else if (
        record.hostKey !== paths.hostKey ||
        record.socketPath !== paths.socketPath
      ) {
        throw new Error('The terminal host discovery record is invalid')
      } else {
        throw new Error(
          'The terminal host socket answered unexpectedly. Treeport will not replace it.'
        )
      }
    }
  } else {
    try {
      return await TerminalHostClient.connect(
        paths.socketPath,
        token,
        paths.hostKey
      )
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (isDefinitiveConnectionFailure(failure)) {
        throw failure
      }

      if (!isStaleSocketFailure(failure)) {
        throw new Error(
          'An unidentified terminal host socket answered unexpectedly. Treeport will not replace it.'
        )
      }

      await fs.rm(paths.socketPath, { force: true })
    }
  }

  const hostId = crypto.randomUUID()
  const spawnHost = options.spawnHost ?? spawn
  const child: ChildProcess = spawnHost(
    options.hostExecutable ?? process.execPath,
    [...(options.hostArguments ?? []), options.hostEntryPath],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...(options.environment ?? process.env),
        TREEPORT_TERMINAL_HOST_RUNTIME_DIR: paths.hostRuntimeDir,
        TREEPORT_TERMINAL_HOST_LAUNCHER: options.launcherPath,
        TREEPORT_TERMINAL_HOST_ID: hostId,
        TREEPORT_TERMINAL_HOST_KEY: paths.hostKey,
        TREEPORT_TERMINAL_HOST_TOKEN: token,
        TREEPORT_TERMINAL_HOST_SOCKET: paths.socketPath,
        TREEPORT_TERMINAL_HOST_RECORD: paths.recordPath
      }
    }
  )
  child.unref()
  let childExit: Error | null = null
  child.once('error', (error) => {
    childExit = error
  })
  child.once('exit', (code, signal) => {
    childExit = new Error(
      `Terminal host exited before startup (code ${code ?? 'null'}, signal ${
        signal ?? 'null'
      })`
    )
  })
  const deadline = Date.now() + TERMINAL_HOST_START_TIMEOUT_MS
  let lastError = new Error('The terminal host socket is unavailable')
  while (Date.now() < deadline) {
    if (childExit) {
      throw childExit
    }

    try {
      return await TerminalHostClient.connect(
        paths.socketPath,
        token,
        paths.hostKey,
        hostId
      )
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (isDefinitiveConnectionFailure(lastError)) {
        throw lastError
      }

      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  throw new Error(`Terminal host did not start: ${lastError.message}`)
}
