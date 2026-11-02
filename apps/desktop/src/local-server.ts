import {
  execFile,
  spawn,
  type ChildProcess,
  type StdioOptions
} from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify, stripVTControlCharacters } from 'node:util'
import * as Effect from 'effect/Effect'
import { checkHealth } from './backend-connection'
import type { ConnectionState, LocalServerState } from './desktop-contract'

// EXTERNAL: Vite's define replaces this with the clone the app was packaged from.
declare const __TREEPORT_SOURCE_ROOT__: string

const INSTALLATION_METHOD = 'desktop-app'
const AUTO_START_INTERVAL_MS = 60_000
const OUTPUT_LINES = 12
const execute = promisify(execFile)

function spawnInClone(
  root: string,
  script: string,
  options: {
    origin: string
    detached: boolean
    stdio: StdioOptions
    env: NodeJS.ProcessEnv
  }
): ChildProcess {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('TREEPORT_'))
  )

  const port = new URL(options.origin).port

  // EXTERNAL: Apps opened from Finder get launchd's minimal PATH. An interactive login
  // shell loads the user's node and pnpm setup (Homebrew, nvm, fnm, and similar).
  return spawn(
    process.env.SHELL ||
      (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'),
    ['-ilc', `exec node ${script}`],
    {
      cwd: root,
      detached: options.detached,
      stdio: options.stdio,
      env: { ...env, TREEPORT_PORT: port, ...options.env }
    }
  )
}

export class LocalServer {
  state: LocalServerState
  private child: ChildProcess | null = null
  private ownedPid: number | null = null
  private seenServer = false
  private lastAutoStart = 0
  private connection: ConnectionState['status'] | null = null

  constructor(
    origin: string,
    readonly logPath: string,
    private readonly choicePath: string,
    private readonly changed: () => void
  ) {
    this.state = {
      status: 'idle',
      chosen: existsSync(choicePath),
      origin,
      sourceRoot: __TREEPORT_SOURCE_ROOT__,
      startedAt: null,
      output: [],
      error: null,
      canStop: false
    }
  }

  observe(connection: ConnectionState['status']): void {
    if (connection === this.connection) {
      return
    }

    this.connection = connection

    if (connection === 'ready') {
      void this.inspect()
    } else if (connection === 'unavailable') {
      this.update({ canStop: false })
      this.autoStart()
    }
  }

  async start(): Promise<void> {
    const { status, sourceRoot: root } = this.state

    if (status === 'starting') {
      return
    }

    if (!this.state.chosen) {
      await fs.writeFile(this.choicePath, `${new Date().toISOString()}\n`)
    }

    this.update({
      chosen: true,
      status: 'starting',
      startedAt: Date.now(),
      output: [],
      error: null
    })

    const hasSource = await fs
      .access(path.join(root, 'scripts', 'start.mjs'))
      .then(
        () => true,
        () => false
      )

    if (!hasSource) {
      this.update({
        status: 'failed',
        error: `Treeport’s source isn’t at ${root} anymore. Rebuild the app from your clone with pnpm app:install.`
      })

      return
    }

    const log = await fs.open(this.logPath, 'w')

    const child = spawnInClone(root, 'scripts/start.mjs', {
      origin: this.state.origin,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { TREEPORT_INSTALLATION_METHOD: INSTALLATION_METHOD }
    })

    await log.close()
    child.unref()
    this.child = child
    child.once('error', (error) => {
      if (this.child === child) {
        this.child = null
        this.update({ status: 'failed', error: error.message })
      }
    })
    child.once('exit', (code, signal) => void this.exited(child, code, signal))

    while (this.child === child && this.state.status === 'starting') {
      await new Promise((resolve) => setTimeout(resolve, 1000))

      if (this.child !== child || this.state.status !== 'starting') {
        return
      }

      const health = await Effect.runPromise(checkHealth(this.state.origin))

      if (health) {
        this.adopt(health)
        this.update({ status: 'idle', output: [] })

        return
      }

      this.update({ output: await this.readOutput() })
    }
  }

  async stop(): Promise<void> {
    const health = await Effect.runPromise(checkHealth(this.state.origin))

    if (
      health?.pid &&
      health.installationMethod === INSTALLATION_METHOD &&
      health.pid === this.ownedPid
    ) {
      this.update({ status: 'stopped', canStop: false })
      process.kill(health.pid, 'SIGTERM')
    }
  }

  async runUpdate(): Promise<{ ok: boolean; output: string }> {
    const ownedPid = this.ownedPid

    const child = spawnInClone(this.state.sourceRoot, 'scripts/update.mjs', {
      origin: this.state.origin,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {}
    })

    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))

    const code = await new Promise<number>((resolve) => {
      child.once('error', (error) => {
        output += error.message
        resolve(1)
      })
      child.once('exit', (exitCode) => resolve(exitCode ?? 1))
    })

    // EXTERNAL: update.mjs stops the server this app started and leaves the restart to
    // the app. The loaded page keeps the connection ready, so auto-start never fires.
    if (code === 0 && ownedPid !== null) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const health = await Effect.runPromise(checkHealth(this.state.origin))

        if (health?.pid !== ownedPid) {
          break
        }

        await new Promise((resolve) => setTimeout(resolve, 250))
      }

      await this.start()
    }

    return { ok: code === 0, output: stripVTControlCharacters(output).trim() }
  }

  async describeClone(): Promise<string> {
    const git = (args: string[]) =>
      execute('git', ['-C', this.state.sourceRoot, ...args]).then(
        ({ stdout }) => stdout.trim(),
        () => null
      )

    const [commit, changes] = await Promise.all([
      git(['log', '-1', '--format=%h %s']),
      git(['status', '--porcelain'])
    ])

    return [
      `Clone: ${this.state.sourceRoot}`,
      commit === null ? null : `Commit: ${commit}`,
      changes === null
        ? null
        : `Local changes: ${changes === '' ? 'none' : 'yes'}`
    ]
      .filter((line) => line !== null)
      .join('\n')
  }

  private autoStart(): void {
    if (!this.state.chosen || this.state.status !== 'idle') {
      return
    }

    if (this.seenServer && this.ownedPid === null) {
      return
    }

    if (Date.now() - this.lastAutoStart < AUTO_START_INTERVAL_MS) {
      void this.readOutput().then((output) =>
        this.update({
          status: 'failed',
          output,
          error: 'Treeport stopped again less than a minute after starting.'
        })
      )

      return
    }

    this.lastAutoStart = Date.now()
    void this.start()
  }

  private async inspect(): Promise<void> {
    const health = await Effect.runPromise(checkHealth(this.state.origin))

    if (health && this.connection === 'ready') {
      this.adopt(health)
    }
  }

  private adopt(health: {
    pid: number | null
    installationMethod: string | null
  }): void {
    this.seenServer = true
    this.ownedPid =
      health.installationMethod === INSTALLATION_METHOD ? health.pid : null
    this.update({ chosen: true, canStop: this.ownedPid !== null })
  }

  private async exited(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    if (this.child !== child) {
      return
    }

    this.child = null

    if (this.state.status !== 'starting') {
      return
    }

    const health = await Effect.runPromise(checkHealth(this.state.origin))

    if (health) {
      this.adopt(health)
      this.update({ status: 'idle', output: [] })

      return
    }

    this.update({
      status: 'failed',
      output: await this.readOutput(),
      error:
        code === 127
          ? 'Treeport couldn’t find node or pnpm in your login shell.'
          : `Treeport exited before it was ready (${signal ?? `code ${code}`}).`
    })
  }

  private async readOutput(): Promise<string[]> {
    const text = await fs.readFile(this.logPath, 'utf8').catch(() => '')

    return stripVTControlCharacters(text)
      .split(/\r?\n|\r/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-OUTPUT_LINES)
  }

  private update(state: Partial<LocalServerState>): void {
    this.state = { ...this.state, ...state }
    this.changed()
  }
}
