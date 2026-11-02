import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import * as Effect from 'effect/Effect'
import { checkHealth } from './backend-connection'
import type { ConnectionState, LocalServerState } from './desktop-contract'

// EXTERNAL: Vite's define replaces this with the clone the app was packaged from.
declare const __TREEPORT_SOURCE_ROOT__: string

const INSTALLATION_METHOD = 'desktop-app'
const AUTO_START_INTERVAL_MS = 60_000
const OUTPUT_LINES = 12

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

    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('TREEPORT_')
      )
    )

    // EXTERNAL: Apps opened from Finder get launchd's minimal PATH. An interactive login
    // shell loads the user's node and pnpm setup (Homebrew, nvm, fnm, and similar).
    const child = spawn(
      process.env.SHELL ||
        (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'),
      ['-ilc', 'exec node scripts/start.mjs'],
      {
        cwd: root,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: { ...env, TREEPORT_INSTALLATION_METHOD: INSTALLATION_METHOD }
      }
    )

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
