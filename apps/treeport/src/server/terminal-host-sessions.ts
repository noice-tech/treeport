import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { SerializeAddon } from '@xterm/addon-serialize'
import xtermHeadless from '@xterm/headless'
import type { IDisposable, IPty } from 'node-pty'
import * as pty from 'node-pty'
import {
  parseTerminalProgress,
  type TerminalProgress,
  type TerminalSnapshotLink
} from '@treeport/shared'
import {
  TERMINAL_PROGRESS_STALE_MS,
  type HostedTerminal,
  type TerminalCreateInput,
  type TerminalLaunchSpec,
  type TerminalProcess,
  type TerminalSessionState,
  type TerminalTitleState
} from './core/terminal'
import { prepareShellIntegration } from './core/shell-integration'

const { Terminal } = xtermHeadless
const HOST_SCROLLBACK_LINES = 50_000
const HOST_PARSER_HIGH_WATERMARK = 1024 * 1024
const HOST_PARSER_LOW_WATERMARK = 256 * 1024
const PROCESS_TREE_KILL_GRACE_MS = 500
const execute = promisify(execFile)
type HeadlessTerminal = InstanceType<typeof Terminal>

interface HeadlessTerminalInternals {
  _core: {
    _oscLinkService: {
      getLinkData(id: number): { uri: string } | undefined
    }
  }
}

interface HeadlessCellInternals {
  extended?: { urlId?: number }
}

async function descendantPids(rootPid: number): Promise<number[]> {
  const rows = await execute('ps', ['-axo', 'pid=,ppid='])
    .then(({ stdout }) =>
      stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/u).map(Number))
        .filter(
          (row): row is [number, number] =>
            row.length === 2 && row.every(Number.isInteger)
        )
    )
    .catch(() => [])
  const children = new Map<number, number[]>()
  for (const [pid, parentPid] of rows) {
    children.set(parentPid, [...(children.get(parentPid) ?? []), pid])
  }

  const descendants: number[] = []
  const pending = [...(children.get(rootPid) ?? [])]
  while (pending.length) {
    const pid = pending.pop()!
    descendants.push(pid)
    pending.push(...(children.get(pid) ?? []))
  }
  return descendants
}

function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    // SAFETY: Node reports process signal errors with errno codes.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false
    }

    throw error
  }
}

async function terminatePtyProcessTree(child: IPty): Promise<void> {
  // Capture descendants before signaling the session leader. Detached
  // grandchildren can otherwise be reparented before the escalation pass.
  const descendants = await descendantPids(child.pid)
  const signalTree = (signal: NodeJS.Signals) => {
    const groupSignaled = signalPid(-child.pid, signal)
    for (const pid of [...descendants].reverse()) {
      signalPid(pid, signal)
    }
    if (!groupSignaled) {
      child.kill(signal)
    }
  }

  signalTree('SIGTERM')
  await new Promise((resolve) =>
    setTimeout(resolve, PROCESS_TREE_KILL_GRACE_MS)
  )
  signalTree('SIGKILL')
}

type ProcessTreeTerminator = (child: IPty) => Promise<void>

export interface TerminalHostRuntimeEvent {
  title?: string | undefined
  progress?: TerminalProgress | null | undefined
  bell?: { sequence: number; at: string } | undefined
  exitCode?: number | null | undefined
  titleState?: TerminalTitleState | undefined
}

export interface TerminalAttachmentBackend {
  attach(
    terminalId: string,
    listener: (data: string, sequence: number) => void
  ): Promise<{
    data: string
    links: TerminalSnapshotLink[]
    fence: number
    cols: number
    rows: number
    unsubscribe: () => void
  } | null>
  subscribeRuntime(
    terminalId: string,
    listener: (event: TerminalHostRuntimeEvent) => void
  ): (() => void) | Promise<() => void>
  terminalTitleState(terminalId: string): Promise<TerminalTitleState | null>
  runtimeState(terminalId: string):
    | {
        title: string | null
        status: HostedTerminal['status']
        progress: TerminalProgress | null
        bell: { sequence: number; at: string } | null
      }
    | null
    | Promise<{
        title: string | null
        status: HostedTerminal['status']
        progress: TerminalProgress | null
        bell: { sequence: number; at: string } | null
      } | null>
  write(
    terminalId: string,
    data: string | Buffer,
    authority: { attachmentId: string; generation: number }
  ): void
  prepareQueryAuthority(
    terminalId: string
  ): Promise<{ transitionId: string; fence: number }>
  activateQueryAuthority(
    terminalId: string,
    transitionId: string,
    attachmentId: string,
    generation: number
  ): Promise<void>
  useHostQueryAuthority(terminalId: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  dispose(): void
}

interface HostedTerminalSession extends HostedTerminal {
  cwd: string
  specPath: string
  title: string | null
  commandLine: string | null
  progress: TerminalProgress | null
  progressLease: NodeJS.Timeout | null
  bellSequence: number
  lastBellAt: string | null
  pty: IPty
  terminal: HeadlessTerminal
  serializer: SerializeAddon
  dataDisposable: IDisposable | null
  exitDisposable: IDisposable | null
  outputSequence: number
  parserQueue: Array<{
    data: string
    sequence: number
    bytes: number
  }>
  parserQueuedBytes: number
  parserWriting: boolean
  parserPaused: boolean
  parserWaiters: Set<() => void>
  boundaryPauseCount: number
  queryAuthorityAttachmentId: string | null
  queryAuthorityGeneration: number | null
  queryTransitionId: string | null
  outputListeners: Set<(data: string, sequence: number) => void>
  runtimeListeners: Set<(event: TerminalHostRuntimeEvent) => void>
}

type PtySpawner = typeof pty.spawn

/**
 * Detached owner of one PTY and one canonical emulator per terminal.
 *
 * The headless emulator answers terminal queries while no browser controller
 * owns that authority. Authority changes use a paused parser boundary so two
 * emulators never answer the same query.
 */
export class TerminalHostSessionManager {
  readonly shellIntegrationDir: string
  private readonly sessions = new Map<string, HostedTerminalSession>()
  private initialization: Promise<void> | null = null

  constructor(
    private readonly runtimeDir: string,
    private readonly launcherPath: string,
    private readonly spawnPty: PtySpawner = pty.spawn,
    private readonly terminateProcessTree: ProcessTreeTerminator = terminatePtyProcessTree,
    private readonly progressStaleMs = TERMINAL_PROGRESS_STALE_MS
  ) {
    this.shellIntegrationDir = path.join(
      runtimeDir,
      'terminal-shell-integration'
    )
  }

  initialize(): Promise<boolean> {
    this.initialization ??= Promise.all([
      fs.mkdir(path.join(this.runtimeDir, 'terminal-specs'), {
        recursive: true,
        mode: 0o700
      }),
      prepareShellIntegration(this.shellIntegrationDir)
    ]).then(() => undefined)
    return this.initialization.then(() => true)
  }

  async createTerminal(input: TerminalCreateInput): Promise<void> {
    await this.initialize()
    if (this.sessions.has(input.terminalId)) {
      throw new Error(`Terminal already exists: ${input.terminalId}`)
    }

    const spec: TerminalLaunchSpec = {
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
      'terminal-specs',
      `${input.terminalId}-${crypto.randomUUID()}.json`
    )
    await fs.writeFile(specPath, JSON.stringify(spec), { mode: 0o600 })
    const size = input.initialSize ?? { cols: 100, rows: 30 }
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
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
      scrollback: HOST_SCROLLBACK_LINES,
      allowProposedApi: true,
      disableStdin: false
    })
    const serializer = new SerializeAddon()
    // The serialize addon targets xterm's shared terminal API. Its declarations
    // name the browser Terminal class even though the headless implementation
    // provides the same addon boundary.
    // SAFETY: Both Terminal implementations satisfy the shared addon contract.
    terminal.loadAddon(serializer as never)
    const outputListeners = new Set<(data: string, sequence: number) => void>()
    const runtimeListeners = new Set<
      (event: TerminalHostRuntimeEvent) => void
    >()
    const session: HostedTerminalSession = {
      id: input.terminalId,
      worktreeId: input.worktreeId,
      name: input.name,
      argv: [...input.argv],
      shellCommand: input.shellCommand,
      interactiveShell: input.interactiveShell,
      closeOnSuccess: input.closeOnSuccess ?? false,
      status: 'running',
      exitCode: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      cwd: input.cwd,
      specPath,
      title: input.initialTitle ?? null,
      commandLine: input.initialTitle ?? null,
      progress: null,
      progressLease: null,
      bellSequence: 0,
      lastBellAt: null,
      pty: child,
      terminal,
      serializer,
      outputSequence: 0,
      parserQueue: [],
      parserQueuedBytes: 0,
      parserWriting: false,
      parserPaused: false,
      parserWaiters: new Set(),
      boundaryPauseCount: 0,
      queryAuthorityAttachmentId: null,
      queryAuthorityGeneration: null,
      queryTransitionId: null,
      outputListeners,
      runtimeListeners,
      dataDisposable: null,
      exitDisposable: null
    }
    terminal.onData((data) => {
      if (
        session.status === 'running' &&
        session.queryAuthorityAttachmentId === null
      ) {
        session.pty.write(data)
      }
    })
    terminal.onTitleChange((title) => {
      session.title = title
      for (const listener of runtimeListeners) {
        listener({
          title,
          titleState: {
            terminalTitle: title,
            currentCommand: session.pty.process || null,
            commandLine: session.commandLine
          }
        })
      }
    })
    terminal.onBell(() => {
      session.bellSequence += 1
      session.lastBellAt = new Date().toISOString()
      for (const listener of runtimeListeners) {
        listener({
          bell: { sequence: session.bellSequence, at: session.lastBellAt }
        })
      }
    })
    terminal.parser.registerOscHandler(777, (payload) => {
      if (!payload.startsWith('command;')) {
        return false
      }

      session.commandLine =
        payload
          .slice('command;'.length)
          .replace(/\p{Cc}/gu, '')
          .trim()
          .slice(0, 256) || null
      const titleState = {
        terminalTitle: session.title,
        currentCommand: session.pty.process || null,
        commandLine: session.commandLine
      }
      for (const listener of runtimeListeners) {
        listener({ titleState })
      }
      return true
    })
    terminal.parser.registerOscHandler(9, (payload) => {
      const progress = parseTerminalProgress(payload)
      if (progress === undefined) {
        return false
      }

      if (session.progressLease) {
        clearTimeout(session.progressLease)
        session.progressLease = null
      }

      session.progress = progress
      if (progress !== null) {
        session.progressLease = setTimeout(() => {
          session.progressLease = null
          if (this.sessions.get(session.id) !== session) {
            return
          }

          session.progress = null
          for (const listener of runtimeListeners) {
            listener({ progress: null })
          }
        }, this.progressStaleMs)
        session.progressLease.unref()
      }

      for (const listener of runtimeListeners) {
        listener({ progress })
      }
      return true
    })
    session.dataDisposable = child.onData((data) => {
      const bytes = Buffer.byteLength(data)
      session.parserQueue.push({
        data,
        sequence: ++session.outputSequence,
        bytes
      })
      session.parserQueuedBytes += bytes
      if (
        !session.parserPaused &&
        session.parserQueuedBytes >= HOST_PARSER_HIGH_WATERMARK
      ) {
        session.parserPaused = true
        session.pty.pause()
      }

      this.parseNext(session)
    })
    session.exitDisposable = child.onExit(({ exitCode }) => {
      if (session.progressLease) {
        clearTimeout(session.progressLease)
        session.progressLease = null
      }

      session.progress = null
      session.status = 'exited'
      for (const resolve of session.parserWaiters) {
        resolve()
      }
      session.parserWaiters.clear()
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
    status: HostedTerminal['status']
    progress: TerminalProgress | null
    bell: { sequence: number; at: string } | null
  } | null {
    const session = this.sessions.get(terminalId)
    return session
      ? {
          title: session.title,
          status: session.status,
          progress: session.progress,
          bell:
            session.lastBellAt === null
              ? null
              : { sequence: session.bellSequence, at: session.lastBellAt }
        }
      : null
  }

  async snapshot(terminalId: string): Promise<{
    data: string
    links: TerminalSnapshotLink[]
    fence: number
    cols: number
    rows: number
  } | null> {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return null
    }

    this.pauseBoundary(session)
    try {
      await this.drainParser(session)
      if (this.sessions.get(terminalId) !== session) {
        return null
      }

      // SerializeAddon preserves hyperlink styling but not the OSC 8 target.
      // Capture xterm's canonical hyperlink cells alongside the text snapshot
      // so the browser can restore the native link metadata after replay.
      const links: TerminalSnapshotLink[] = []
      // SAFETY: Treeport pins the headless xterm version and verifies this
      // internal hyperlink boundary with the snapshot behavior test.
      const terminalInternals = Object(
        session.terminal
      ) as HeadlessTerminalInternals
      for (const [bufferName, buffer] of [
        ['normal', session.terminal.buffer.normal],
        ['alternate', session.terminal.buffer.alternate]
      ] as const) {
        for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
          const line = buffer.getLine(lineIndex)
          if (!line) {
            continue
          }

          let activeLink: { id: number; startColumn: number } | null = null
          for (let column = 0; column <= line.length; column += 1) {
            const cell = column < line.length ? line.getCell(column) : undefined
            // SAFETY: The pinned xterm cell stores the OSC link ID in its
            // extended attributes; the snapshot behavior test covers it.
            const internalCell = cell
              ? (Object(cell) as HeadlessCellInternals)
              : undefined
            const linkId = internalCell?.extended?.urlId
            if (activeLink !== null && linkId === activeLink.id) {
              continue
            }

            if (activeLink) {
              const data = terminalInternals._core._oscLinkService.getLinkData(
                activeLink.id
              )
              if (
                data?.uri &&
                data.uri.length <= 4_096 &&
                links.length < 10_000
              ) {
                links.push({
                  buffer: bufferName,
                  uri: data.uri,
                  line: lineIndex,
                  startColumn: activeLink.startColumn,
                  endColumn: column
                })
              }
            }

            activeLink = linkId ? { id: linkId, startColumn: column } : null
          }
        }
      }

      // The PTY stays paused for this short serialization boundary. Output
      // after resume has a sequence greater than the returned fence. The
      // serialized state contains no original query sequence to replay.
      return {
        data: session.serializer.serialize({
          scrollback: HOST_SCROLLBACK_LINES
        }),
        links,
        fence: session.outputSequence,
        cols: session.terminal.cols,
        rows: session.terminal.rows
      }
    } finally {
      this.releaseBoundary(session)
    }
  }

  subscribeOutput(
    terminalId: string,
    listener: (data: string, sequence: number) => void
  ): () => void {
    const session = this.sessions.get(terminalId)
    if (!session) {
      throw new Error('Terminal is unavailable')
    }

    session.outputListeners.add(listener)
    return () => session.outputListeners.delete(listener)
  }

  subscribeRuntime(
    terminalId: string,
    listener: (event: TerminalHostRuntimeEvent) => void
  ): () => void {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return () => undefined
    }

    session.runtimeListeners.add(listener)
    return () => session.runtimeListeners.delete(listener)
  }

  write(
    terminalId: string,
    data: string | Buffer,
    authority: { attachmentId: string; generation: number }
  ): void {
    const session = this.sessions.get(terminalId)
    if (
      !session ||
      session.status !== 'running' ||
      session.queryAuthorityAttachmentId !== authority.attachmentId ||
      session.queryAuthorityGeneration !== authority.generation ||
      session.queryTransitionId !== null
    ) {
      return
    }

    session.pty.write(data)
  }

  async prepareQueryAuthority(
    terminalId: string
  ): Promise<{ transitionId: string; fence: number }> {
    const session = this.sessions.get(terminalId)
    if (!session || session.status !== 'running') {
      throw new Error('Terminal is unavailable')
    }

    if (session.queryTransitionId !== null) {
      throw new Error('A terminal query authority change is already pending')
    }

    this.pauseBoundary(session)
    await this.drainParser(session)
    if (this.sessions.get(terminalId) !== session) {
      throw new Error('Terminal is unavailable')
    }

    session.queryAuthorityAttachmentId = null
    session.queryAuthorityGeneration = null
    session.terminal.options.disableStdin = false
    session.queryTransitionId = crypto.randomUUID()
    return {
      transitionId: session.queryTransitionId,
      fence: session.outputSequence
    }
  }

  async activateQueryAuthority(
    terminalId: string,
    transitionId: string,
    attachmentId: string,
    generation: number
  ): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (
      !session ||
      session.status !== 'running' ||
      session.queryTransitionId !== transitionId
    ) {
      throw new Error('Terminal query authority transition is unavailable')
    }

    session.terminal.options.disableStdin = true
    session.queryAuthorityAttachmentId = attachmentId
    session.queryAuthorityGeneration = generation
    session.queryTransitionId = null
    this.releaseBoundary(session)
  }

  async useHostQueryAuthority(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (!session || session.status !== 'running') {
      return
    }

    if (session.queryTransitionId === null) {
      this.pauseBoundary(session)
      await this.drainParser(session)
      if (this.sessions.get(terminalId) !== session) {
        return
      }
    }

    session.terminal.options.disableStdin = false
    session.queryAuthorityAttachmentId = null
    session.queryAuthorityGeneration = null
    if (session.queryTransitionId !== null) {
      session.queryTransitionId = null
    }

    this.releaseBoundary(session)
  }

  async restoreHostQueryAuthority(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((terminalId) =>
        this.useHostQueryAuthority(terminalId)
      )
    )
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (!session || session.status !== 'running') {
      return
    }

    // Resize is a canonical grid boundary. Pause only for this short boundary,
    // never for browser backpressure, and drain all pre-resize parser writes.
    this.pauseBoundary(session)
    try {
      await this.drainParser(session)
      if (this.sessions.get(terminalId) !== session) {
        return
      }

      session.pty.resize(cols, rows)
      session.terminal.resize(cols, rows)
    } finally {
      this.releaseBoundary(session)
    }
  }

  async listTerminals(worktreeId: string): Promise<HostedTerminal[]> {
    return [...this.sessions.values()]
      .filter((session) => session.worktreeId === worktreeId)
      .map(
        ({
          pty: _pty,
          terminal: _terminal,
          serializer: _serializer,
          dataDisposable: _data,
          exitDisposable: _exit,
          outputSequence: _outputSequence,
          parserQueue: _parserQueue,
          parserQueuedBytes: _parserQueuedBytes,
          parserWriting: _parserWriting,
          parserPaused: _parserPaused,
          parserWaiters: _parserWaiters,
          boundaryPauseCount: _boundaryPauseCount,
          queryAuthorityAttachmentId: _queryAuthorityAttachmentId,
          queryAuthorityGeneration: _queryAuthorityGeneration,
          queryTransitionId: _queryTransitionId,
          outputListeners: _outputs,
          runtimeListeners: _runtime,
          cwd: _cwd,
          specPath: _specPath,
          title: _title,
          commandLine: _commandLine,
          progress: _progress,
          progressLease: _progressLease,
          bellSequence: _bellSequence,
          lastBellAt: _lastBellAt,
          ...terminal
        }) => ({ ...terminal })
      )
  }

  async terminalState(terminalId: string): Promise<TerminalSessionState> {
    const session = this.sessions.get(terminalId)
    return session
      ? { status: session.status, exitCode: session.exitCode }
      : { status: 'missing', exitCode: null }
  }

  async terminalSize(terminalId: string) {
    const session = this.sessions.get(terminalId)
    return session
      ? { cols: session.terminal.cols, rows: session.terminal.rows }
      : null
  }

  async captureTerminal(
    terminalId: string,
    lines: number
  ): Promise<string | null> {
    const session = this.sessions.get(terminalId)
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
    terminalId: string,
    name: string,
    updatedAt: string
  ): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (session) {
      session.name = name
      session.updatedAt = updatedAt
    }
  }

  async listProcesses(worktreeId: string): Promise<TerminalProcess[]> {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.worktreeId === worktreeId && session.status === 'running'
      )
      .map((session) => ({ pid: session.pty.pid, terminalId: session.id }))
  }

  async terminalTitleState(
    terminalId: string
  ): Promise<TerminalTitleState | null> {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return null
    }

    return {
      terminalTitle: session.title,
      currentCommand: session.pty.process || null,
      commandLine: session.commandLine
    }
  }

  async signalTerminal(
    terminalId: string,
    signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'
  ): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (session?.status === 'running') {
      session.pty.kill(signal)
    }
  }

  async killTerminal(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (session) {
      await this.destroy(session)
    }
  }

  async killWorktree(worktreeId: string): Promise<string[]> {
    const sessions = [...this.sessions.values()].filter(
      (session) => session.worktreeId === worktreeId
    )
    await Promise.all(sessions.map((session) => this.destroy(session)))
    return sessions.map((session) => session.id)
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) => this.destroy(session))
    )
  }

  dispose(): void {
    void this.shutdown()
  }

  private parseNext(session: HostedTerminalSession): void {
    if (session.parserWriting || this.sessions.get(session.id) !== session) {
      return
    }

    const next = session.parserQueue.shift()
    if (!next) {
      for (const resolve of session.parserWaiters) {
        resolve()
      }
      session.parserWaiters.clear()
      return
    }

    session.parserWriting = true
    session.terminal.write(next.data, () => {
      if (this.sessions.get(session.id) !== session) {
        return
      }

      session.parserWriting = false
      session.parserQueuedBytes = Math.max(
        0,
        session.parserQueuedBytes - next.bytes
      )
      // Fanout occurs only after the canonical model parses this chunk.
      for (const listener of [...session.outputListeners]) {
        listener(next.data, next.sequence)
      }
      if (
        session.parserPaused &&
        session.parserQueuedBytes <= HOST_PARSER_LOW_WATERMARK
      ) {
        session.parserPaused = false
        if (session.boundaryPauseCount === 0) {
          session.pty.resume()
        }
      }

      this.parseNext(session)
    })
  }

  private drainParser(session: HostedTerminalSession): Promise<void> {
    if (!session.parserWriting && session.parserQueue.length === 0) {
      return Promise.resolve()
    }

    return new Promise((resolve) => session.parserWaiters.add(resolve))
  }

  private pauseBoundary(session: HostedTerminalSession): void {
    session.boundaryPauseCount += 1
    if (session.boundaryPauseCount === 1) {
      session.pty.pause()
    }
  }

  private releaseBoundary(session: HostedTerminalSession): void {
    session.boundaryPauseCount = Math.max(0, session.boundaryPauseCount - 1)
    if (
      this.sessions.get(session.id) === session &&
      session.status === 'running' &&
      session.boundaryPauseCount === 0 &&
      !session.parserPaused
    ) {
      session.pty.resume()
    }
  }

  private async destroy(session: HostedTerminalSession): Promise<void> {
    if (this.sessions.get(session.id) !== session) {
      return
    }

    this.sessions.delete(session.id)
    session.dataDisposable?.dispose()
    session.exitDisposable?.dispose()
    if (session.progressLease) {
      clearTimeout(session.progressLease)
      session.progressLease = null
    }

    session.outputListeners.clear()
    session.runtimeListeners.clear()
    for (const resolve of session.parserWaiters) {
      resolve()
    }
    session.parserWaiters.clear()
    session.parserQueue = []
    session.serializer.dispose()
    session.terminal.dispose()
    await Promise.all([
      fs.rm(session.specPath, { force: true }),
      this.terminateProcessTree(session.pty)
    ])
  }
}
