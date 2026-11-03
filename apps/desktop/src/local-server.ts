import {
  execFile,
  spawn,
  type ChildProcess,
  type StdioOptions
} from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify, stripVTControlCharacters } from 'node:util'
import * as Effect from 'effect/Effect'
import { checkHealth } from './backend-connection'
import type {
  ConnectionState,
  LocalServerState,
  LocalServerUpdate,
  LocalServerUpdateStep
} from './desktop-contract'

// EXTERNAL: Vite's define replaces this with the clone the app was packaged from.
declare const __TREEPORT_SOURCE_ROOT__: string

const INSTALLATION_METHOD = 'desktop-app'
const AUTO_START_INTERVAL_MS = 60_000
const OUTPUT_LINES = 12
const UPDATED_VISIBLE_MS = 8_000
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

interface UpdateResult {
  outcome: 'updated' | 'up-to-date' | 'diverged' | 'failed'
  head: string | null
  local: number
  remote: number
}

export class LocalServer {
  state: LocalServerState
  private child: ChildProcess | null = null
  private ownedPid: number | null = null
  private seenServer = false
  private lastAutoStart = 0
  private connection: ConnectionState['status'] | null = null

  readonly updateLogPath: string

  constructor(
    origin: string,
    readonly logPath: string,
    private readonly choicePath: string,
    private readonly changed: () => void
  ) {
    this.updateLogPath = path.join(path.dirname(logPath), 'update-output.log')
    this.state = {
      status: 'idle',
      chosen: existsSync(choicePath),
      origin,
      sourceRoot: __TREEPORT_SOURCE_ROOT__,
      startedAt: null,
      output: [],
      error: null,
      canStop: false,
      update: null
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

  async runUpdate(): Promise<UpdateResult> {
    const ownedPid = this.ownedPid

    const result: UpdateResult = {
      outcome: 'updated',
      head: null,
      local: 0,
      remote: 0
    }

    let update: LocalServerUpdate = {
      status: 'running',
      startedAt: Date.now(),
      steps: [],
      commits: null,
      error: null,
      output: []
    }

    const setUpdate = (next: Partial<LocalServerUpdate>) => {
      update = { ...update, ...next }
      this.update({ update })
    }

    const setStep = (label: string, step: Partial<LocalServerUpdateStep>) =>
      setUpdate({
        steps: update.steps.map((item) =>
          item.label === label ? { ...item, ...step } : item
        )
      })

    setUpdate({})

    const log = createWriteStream(this.updateLogPath)

    const child = spawnInClone(this.state.sourceRoot, 'scripts/update.mjs', {
      origin: this.state.origin,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { TREEPORT_PROGRESS: '1' }
    })

    let pending = ''
    let errors = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      const lines = (pending + chunk.toString()).split('\n')
      pending = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('::treeport ')) {
          log.write(`${line}\n`)
          continue
        }

        const event = JSON.parse(line.slice('::treeport '.length))

        if (event.type === 'plan') {
          setUpdate({
            steps: event.steps.map((label: string) => ({
              label,
              status: 'pending',
              seconds: null
            }))
          })
        } else if (event.type === 'step') {
          setStep(event.label, { status: 'running' })
        } else if (event.type === 'done' || event.type === 'failed') {
          setStep(event.label, {
            status: event.type,
            seconds: event.seconds
          })
        } else if (event.type === 'updated') {
          result.head = event.head
          setUpdate({ commits: event.commits })
        } else if (event.type === 'up-to-date') {
          result.outcome = 'up-to-date'
          result.head = event.head
        } else if (event.type === 'diverged') {
          result.outcome = 'diverged'
          result.local = event.local
          result.remote = event.remote
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString()
      log.write(chunk)
    })

    const code = await new Promise<number>((resolve) => {
      child.once('error', (error) => {
        errors += error.message
        resolve(1)
      })
      child.once('exit', (exitCode) => resolve(exitCode ?? 1))
    })

    log.end(pending)

    if (code !== 0 && result.outcome !== 'diverged') {
      const failed = update.steps.find((step) => step.status === 'failed')
      result.outcome = 'failed'
      setUpdate({
        status: 'failed',
        error: failed
          ? `${failed.label} failed. Your running Treeport wasn’t changed.`
          : code === 127
            ? 'Treeport couldn’t find node or pnpm in your login shell.'
            : 'The update stopped. Your running Treeport wasn’t changed.',
        output: stripVTControlCharacters(errors)
          .split(/\r?\n/)
          .map((line) => line.trimEnd())
          // EXTERNAL: The interactive login shell warns about job control without a TTY.
          .filter(
            (line) =>
              line !== '' &&
              !line.startsWith('Update stopped.') &&
              !/^\w+: (no job control|cannot set terminal process group)/.test(
                line
              )
          )
          .slice(-4)
      })
    }

    // EXTERNAL: update.mjs stops the server this app started and leaves the restart to
    // the app. The loaded page keeps the connection ready, so auto-start never fires.
    if (code === 0 && result.outcome === 'updated' && ownedPid !== null) {
      setStep('Restarting', { status: 'running' })
      const startedAt = Date.now()

      for (let attempt = 0; attempt < 40; attempt++) {
        const health = await Effect.runPromise(checkHealth(this.state.origin))

        if (health?.pid !== ownedPid) {
          break
        }

        await new Promise((resolve) => setTimeout(resolve, 250))
      }

      await this.start()

      const started = this.state.status === 'idle'
      setStep('Restarting', {
        status: started ? 'done' : 'failed',
        seconds: Math.round((Date.now() - startedAt) / 1000)
      })

      if (!started) {
        result.outcome = 'failed'
        setUpdate({
          status: 'failed',
          error: 'Treeport updated but didn’t start again.',
          output: this.state.output.slice(-4)
        })
      }
    }

    if (result.outcome === 'updated') {
      setUpdate({
        status: 'updated',
        steps: update.steps.filter((step) => step.status !== 'pending')
      })
      const finished = update
      setTimeout(() => {
        if (this.state.update === finished) {
          this.update({ update: null })
        }
      }, UPDATED_VISIBLE_MS)
    } else if (result.outcome !== 'failed') {
      this.update({ update: null })
    }

    return result
  }

  dismissUpdate(): void {
    if (this.state.update?.status !== 'running') {
      this.update({ update: null })
    }
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
