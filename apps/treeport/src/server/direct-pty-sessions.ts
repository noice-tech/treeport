import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SerializeAddon } from '@xterm/addon-serialize'
import xtermHeadless from '@xterm/headless'
import type { IDisposable, IPty } from 'node-pty'
import * as pty from 'node-pty'
import { parseTerminalProgress, type TerminalProgress } from '@treeport/shared'
import type {
  LaunchSpec,
  TmuxPaneProcess,
  TmuxSessionState,
  TmuxSessionTitleState,
  TmuxTerminalSession
} from './core/tmux'
import { prepareShellIntegration } from './core/shell-integration'

const { Terminal } = xtermHeadless
const DIRECT_SCROLLBACK_LINES = 50_000
type HeadlessTerminal = InstanceType<typeof Terminal>

export interface DirectPtyRuntimeEvent {
  title?: string | undefined
  progress?: TerminalProgress | null | undefined
  bell?: true | undefined
  exitCode?: number | null | undefined
}

export interface DirectTerminalSessionBackend {
  sessionSize(
    socketName: string,
    sessionName: string
  ): Promise<{ cols: number; rows: number } | null>
  snapshot(terminalId: string): Promise<{ data: string; fence: number } | null>
  subscribeOutput(
    terminalId: string,
    listener: (data: string, sequence: number) => void
  ): (() => void) | Promise<() => void>
  subscribeRuntime(
    terminalId: string,
    listener: (event: DirectPtyRuntimeEvent) => void
  ): (() => void) | Promise<() => void>
  runtimeState(terminalId: string):
    | {
        title: string | null
        status: TmuxTerminalSession['status']
      }
    | null
    | Promise<{
        title: string | null
        status: TmuxTerminalSession['status']
      } | null>
  write(terminalId: string, data: string | Buffer): void
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  dispose(): void
}

interface DirectPtySession extends TmuxTerminalSession {
  socketName: string
  cwd: string
  specPath: string
  title: string | null
  pty: IPty
  terminal: HeadlessTerminal
  serializer: SerializeAddon
  dataDisposable: IDisposable | null
  exitDisposable: IDisposable | null
  outputSequence: number
  outputListeners: Set<(data: string, sequence: number) => void>
  runtimeListeners: Set<(event: DirectPtyRuntimeEvent) => void>
}

type PtySpawner = typeof pty.spawn

/**
 * Experimental daemon-lifetime PTY owner. There is one PTY and one headless
 * emulator per child, regardless of how many browser viewers are attached.
 *
 * The headless emulator deliberately has stdin disabled. Browser output replay
 * therefore cannot produce query responses, and only the current browser
 * controller is allowed to send xterm-generated responses to the child.
 */
export class DirectPtySessionManager {
  readonly kind = 'direct-pty' as const
  readonly shellIntegrationDir: string
  private readonly sessions = new Map<string, DirectPtySession>()
  private initialization: Promise<void> | null = null

  constructor(
    private readonly runtimeDir: string,
    private readonly launcherPath: string,
    private readonly spawnPty: PtySpawner = pty.spawn
  ) {
    this.shellIntegrationDir = path.join(
      runtimeDir,
      'direct-pty-shell-integration'
    )
  }

  initialize(): Promise<boolean> {
    this.initialization ??= Promise.all([
      fs.mkdir(path.join(this.runtimeDir, 'direct-pty-specs'), {
        recursive: true,
        mode: 0o700
      }),
      prepareShellIntegration(this.shellIntegrationDir)
    ]).then(() => undefined)
    return this.initialization.then(() => true)
  }

  async configureServer(): Promise<void> {
    await this.initialize()
  }

  async createSession(input: {
    socketName: string
    sessionName: string
    terminalId: string
    worktreeId: string
    name: string
    createdAt: string
    cwd: string
    argv: string[]
    initialTitle?: string | undefined
    shellCommand: string | null
    interactiveShell: boolean
    fallbackArgv?: string[] | undefined
    closeOnSuccess?: boolean | undefined
    initialSize?: { cols: number; rows: number } | undefined
    env: Record<string, string>
    setupTasks?: LaunchSpec['setupTasks'] | undefined
    setupError?: string | undefined
  }): Promise<void> {
    await this.initialize()
    if (this.sessions.has(input.terminalId)) {
      throw new Error(`Direct PTY session already exists: ${input.terminalId}`)
    }

    const spec: LaunchSpec = {
      argv: [...input.argv],
      cwd: input.cwd,
      env: { ...input.env },
      shellIntegrationDir: this.shellIntegrationDir
    }
    if (input.initialTitle) {
      spec.initialTitle = input.initialTitle
    }

    if (input.fallbackArgv) {
      spec.fallbackArgv = [...input.fallbackArgv]
    }

    if (input.setupTasks) {
      spec.setupTasks = input.setupTasks
    }

    if (input.setupError) {
      spec.setupError = input.setupError
    }

    const specPath = path.join(
      this.runtimeDir,
      'direct-pty-specs',
      `${input.terminalId}-${crypto.randomUUID()}.json`
    )
    await fs.writeFile(specPath, JSON.stringify(spec), { mode: 0o600 })
    const size = input.initialSize ?? { cols: 100, rows: 30 }
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    delete environment.TMUX
    delete environment.TMUX_PANE
    environment.TERM = 'xterm-256color'

    let child: IPty
    try {
      child = this.spawnPty(process.execPath, [this.launcherPath, specPath], {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: input.cwd,
        env: environment
      })
    } catch (error) {
      await fs.rm(specPath, { force: true })
      throw error
    }

    const terminal = new Terminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: DIRECT_SCROLLBACK_LINES,
      allowProposedApi: true,
      disableStdin: true
    })
    const serializer = new SerializeAddon()
    // The serialize addon targets xterm's shared terminal API. Its declarations
    // name the browser Terminal class even though the headless implementation
    // provides the same addon boundary.
    // SAFETY: Both Terminal implementations satisfy the shared addon contract.
    terminal.loadAddon(serializer as never)
    const outputListeners = new Set<(data: string, sequence: number) => void>()
    const runtimeListeners = new Set<(event: DirectPtyRuntimeEvent) => void>()
    const session: DirectPtySession = {
      id: input.terminalId,
      worktreeId: input.worktreeId,
      name: input.name,
      sessionName: input.sessionName,
      argv: [...input.argv],
      shellCommand: input.shellCommand,
      interactiveShell: input.interactiveShell,
      closeOnSuccess: input.closeOnSuccess ?? false,
      status: 'running',
      exitCode: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      socketName: input.socketName,
      cwd: input.cwd,
      specPath,
      title: input.initialTitle ?? null,
      pty: child,
      terminal,
      serializer,
      outputSequence: 0,
      outputListeners,
      runtimeListeners,
      dataDisposable: null,
      exitDisposable: null
    }
    terminal.onTitleChange((title) => {
      session.title = title
      for (const listener of runtimeListeners) {
        listener({ title })
      }
    })
    terminal.onBell(() => {
      for (const listener of runtimeListeners) {
        listener({ bell: true })
      }
    })
    terminal.parser.registerOscHandler(9, (payload) => {
      const progress = parseTerminalProgress(payload)
      if (progress === undefined) {
        return false
      }

      for (const listener of runtimeListeners) {
        listener({ progress })
      }
      return true
    })
    session.dataDisposable = child.onData((data) => {
      const sequence = ++session.outputSequence
      terminal.write(data, () => {
        // Fanout occurs only after the canonical model parses this chunk.
        for (const listener of [...outputListeners]) {
          listener(data, sequence)
        }
      })
    })
    session.exitDisposable = child.onExit(({ exitCode }) => {
      session.status = 'exited'
      session.exitCode = exitCode
      session.updatedAt = new Date().toISOString()
      for (const listener of [...runtimeListeners]) {
        listener({ exitCode })
      }
      void fs.rm(specPath, { force: true })
    })
    this.sessions.set(input.terminalId, session)
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  size(terminalId: string): { cols: number; rows: number } | null {
    const session = this.sessions.get(terminalId)
    return session
      ? { cols: session.terminal.cols, rows: session.terminal.rows }
      : null
  }

  runtimeState(terminalId: string): {
    title: string | null
    status: TmuxTerminalSession['status']
  } | null {
    const session = this.sessions.get(terminalId)
    return session ? { title: session.title, status: session.status } : null
  }

  async snapshot(terminalId: string): Promise<{
    data: string
    fence: number
  } | null> {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return null
    }

    const fence = session.outputSequence
    // xterm write callbacks are FIFO. Serialize inside the callback so output
    // queued after this fence cannot enter both the snapshot and live stream.
    // Serialized state contains no original query sequence to replay.
    return new Promise<{ data: string; fence: number }>((resolve) =>
      session.terminal.write('', () =>
        resolve({
          data: session.serializer.serialize({
            scrollback: DIRECT_SCROLLBACK_LINES
          }),
          fence
        })
      )
    )
  }

  subscribeOutput(
    terminalId: string,
    listener: (data: string, sequence: number) => void
  ): () => void {
    const session = this.sessions.get(terminalId)
    if (!session) {
      throw new Error('Direct PTY session is unavailable')
    }

    session.outputListeners.add(listener)
    return () => session.outputListeners.delete(listener)
  }

  subscribeRuntime(
    terminalId: string,
    listener: (event: DirectPtyRuntimeEvent) => void
  ): () => void {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return () => undefined
    }

    session.runtimeListeners.add(listener)
    return () => session.runtimeListeners.delete(listener)
  }

  write(terminalId: string, data: string | Buffer): void {
    const session = this.sessions.get(terminalId)
    if (!session || session.status !== 'running') {
      return
    }

    session.pty.write(data)
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (!session || session.status !== 'running') {
      return
    }

    // Resize is a canonical grid boundary. Pause only for this short boundary,
    // never for browser backpressure, and drain all pre-resize parser writes.
    session.pty.pause()
    await new Promise<void>((resolve) => session.terminal.write('', resolve))
    if (this.sessions.get(terminalId) !== session) {
      return
    }

    try {
      session.pty.resize(cols, rows)
      session.terminal.resize(cols, rows)
    } finally {
      session.pty.resume()
    }
  }

  async listSessions(socketName: string): Promise<TmuxTerminalSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.socketName === socketName)
      .map(
        ({
          pty: _pty,
          terminal: _terminal,
          serializer: _serializer,
          dataDisposable: _data,
          exitDisposable: _exit,
          outputSequence: _outputSequence,
          outputListeners: _outputs,
          runtimeListeners: _runtime,
          socketName: _socket,
          cwd: _cwd,
          specPath: _specPath,
          title: _title,
          ...session
        }) => ({ ...session })
      )
  }

  async sessionState(
    _socketName: string,
    sessionName: string
  ): Promise<TmuxSessionState> {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.sessionName === sessionName
    )
    return session
      ? { status: session.status, exitCode: session.exitCode }
      : { status: 'missing', exitCode: null }
  }

  async sessionSize(_socketName: string, sessionName: string) {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.sessionName === sessionName
    )
    return session
      ? { cols: session.terminal.cols, rows: session.terminal.rows }
      : null
  }

  async capturePane(
    _socketName: string,
    sessionName: string,
    lines: number
  ): Promise<string | null> {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.sessionName === sessionName
    )
    if (!session) {
      return null
    }

    await new Promise<void>((resolve) => session.terminal.write('', resolve))
    const buffer = session.terminal.buffer.active
    const content: string[] = []
    for (let index = 0; index < buffer.length; index += 1) {
      content.push(buffer.getLine(index)?.translateToString(true) ?? '')
    }
    while (content.length && !content.at(-1)?.trim()) {
      content.pop()
    }
    return content.slice(-lines).join('\n')
  }

  async renameTerminal(
    _socketName: string,
    sessionName: string,
    name: string,
    updatedAt: string
  ): Promise<void> {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.sessionName === sessionName
    )
    if (session) {
      session.name = name
      session.updatedAt = updatedAt
    }
  }

  async listPaneProcesses(
    socketName: string,
    worktreeId: string
  ): Promise<TmuxPaneProcess[]> {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.socketName === socketName &&
          session.worktreeId === worktreeId &&
          session.status === 'running'
      )
      .map((session) => ({ pid: session.pty.pid, terminalId: session.id }))
  }

  async sessionTitleState(
    _socketName: string,
    sessionName: string
  ): Promise<TmuxSessionTitleState | null> {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.sessionName === sessionName
    )
    if (!session) {
      return null
    }

    return {
      paneTitle: session.title,
      currentCommand: session.pty.process || null
    }
  }

  async setSessionShellTitle(): Promise<void> {}

  async killSession(
    _socketName: string,
    sessionName: string,
    _terminalId?: string,
    _options?: { preserveServer?: boolean }
  ): Promise<void> {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.sessionName === sessionName
    )
    if (session) {
      this.destroy(session)
    }
  }

  async killServer(socketName: string): Promise<string[]> {
    const sessions = [...this.sessions.values()].filter(
      (session) => session.socketName === socketName
    )
    for (const session of sessions) {
      this.destroy(session)
    }
    return sessions.map((session) => session.id)
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) {
      this.destroy(session)
    }
  }

  private destroy(session: DirectPtySession): void {
    this.sessions.delete(session.id)
    session.dataDisposable?.dispose()
    session.exitDisposable?.dispose()
    session.outputListeners.clear()
    session.runtimeListeners.clear()
    session.serializer.dispose()
    session.terminal.dispose()
    void fs.rm(session.specPath, { force: true })
    try {
      session.pty.kill()
    } catch {
      // The child may already have exited.
    }
  }
}
