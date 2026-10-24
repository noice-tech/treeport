import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { PackageWorkerDeclaration } from './core/package-system'

// Package state is reconciled lazily from settings fingerprints, so polling
// picks up installs, removals, and settings edits without change events.
const SYNC_INTERVAL_MS = 5_000
const MAX_RESTART_DELAY_MS = 60_000
const LOG_LIMIT_BYTES = 1024 * 1024

interface WorkerEntry {
  declaration: PackageWorkerDeclaration
  token: string
  child: ChildProcess | null
  closed: Promise<void> | null
  startedAt: number
  restarts: number
  restartTimer: NodeJS.Timeout | null
  stopped: boolean
}

export interface PackageWorkerAccess {
  packageId: string
  /** Null when the package is configured globally. */
  projectIds: string[] | null
}

interface PackageWorkerOptions {
  apiUrl: string
  dataDir: string
  declarations: () => Promise<PackageWorkerDeclaration[]>
  pruneBadgeSources: (sources: string[]) => Promise<void>
  log: (message: string) => void
}

/**
 * Runs package workers: trusted background processes that start with Treeport,
 * restart with backoff, and call the local API with a per-worker token.
 */
export class PackageWorkers {
  private readonly entries = new Map<string, WorkerEntry>()
  private readonly tokens = new Map<string, WorkerEntry>()
  private activeSources: string | null = null
  private timer: NodeJS.Timeout | null = null
  private syncing: Promise<void> | null = null
  private disposed = false

  constructor(private readonly options: PackageWorkerOptions) {}

  start(): void {
    void this.sync()
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS)
    this.timer.unref()
  }

  /** Resolve a worker's API token to the package it acts for. */
  access(token: string): PackageWorkerAccess | null {
    const entry = this.tokens.get(token)
    return entry && !entry.stopped
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
          `Package worker sync failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        this.syncing = null
      })
    return this.syncing
  }

  private async reconcile(): Promise<void> {
    const declarations = await this.options.declarations()
    if (this.disposed) {
      return
    }

    const next = new Map(
      declarations.map((declaration) => [declaration.id, declaration])
    )
    for (const [id, entry] of this.entries) {
      const declaration = next.get(id)
      if (
        declaration &&
        declaration.root === entry.declaration.root &&
        declaration.executable === entry.declaration.executable &&
        JSON.stringify(declaration.args) ===
          JSON.stringify(entry.declaration.args)
      ) {
        // Project scope can change without restarting the process.
        entry.declaration = declaration
        continue
      }

      this.entries.delete(id)
      await this.stop(entry)
    }

    for (const declaration of declarations) {
      if (this.entries.has(declaration.id)) {
        continue
      }

      const entry: WorkerEntry = {
        declaration,
        token: crypto.randomBytes(32).toString('base64url'),
        child: null,
        closed: null,
        startedAt: 0,
        restarts: 0,
        restartTimer: null,
        stopped: false
      }
      this.entries.set(declaration.id, entry)
      this.tokens.set(entry.token, entry)
      this.launch(entry)
    }

    const sources = [
      ...new Set(declarations.map((declaration) => declaration.packageId))
    ].sort()
    if (JSON.stringify(sources) !== this.activeSources) {
      await this.options.pruneBadgeSources(sources)
      this.activeSources = JSON.stringify(sources)
    }
  }

  private launch(entry: WorkerEntry): void {
    entry.restartTimer = null
    if (entry.stopped || this.disposed) {
      return
    }

    const { declaration } = entry
    const dataDir = path.join(
      this.options.dataDir,
      'package-workers',
      crypto
        .createHash('sha256')
        .update(declaration.id)
        .digest('hex')
        .slice(0, 24)
    )
    fs.mkdirSync(dataDir, { recursive: true })
    // Each run replaces the previous log, and output past the limit is dropped.
    const log = fs.createWriteStream(path.join(dataDir, 'worker.log'))
    let logged = 0
    const append = (chunk: Buffer | string) => {
      const remaining = LOG_LIMIT_BYTES - logged
      if (remaining > 0) {
        const bytes = Buffer.from(chunk).subarray(0, remaining)
        logged += bytes.length
        log.write(bytes)
      }
    }
    const substitute = (value: string) =>
      value
        .replaceAll('${packageRoot}', declaration.root)
        .replaceAll('${dataDir}', dataDir)
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith('TREEPORT_')) {
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
      child.once('close', () => {
        log.end()
        resolve()
      })
    })
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    let ended = false
    const restart = (reason: string) => {
      if (ended || entry.child !== child || entry.stopped || this.disposed) {
        return
      }

      ended = true
      entry.child = null
      // A worker that stayed up past the longest delay starts a fresh backoff.
      entry.restarts =
        Date.now() - entry.startedAt > MAX_RESTART_DELAY_MS
          ? 0
          : entry.restarts + 1
      const wait = Math.min(MAX_RESTART_DELAY_MS, 1_000 * 2 ** entry.restarts)
      append(`\n[treeport] worker ${reason}; restarting in ${wait / 1_000}s\n`)
      this.options.log(
        `Package worker ${declaration.id} ${reason}; restarting in ${wait / 1_000}s`
      )
      entry.restartTimer = setTimeout(() => this.launch(entry), wait)
    }
    child.once('error', (error) =>
      restart(`could not start ${declaration.executable}: ${error.message}`)
    )
    child.once('exit', (code, signal) =>
      restart(`exited (${signal ?? code ?? 'unknown status'})`)
    )
  }

  private async stop(entry: WorkerEntry): Promise<void> {
    entry.stopped = true
    this.tokens.delete(entry.token)
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer)
      entry.restartTimer = null
    }

    const pid = entry.child?.pid
    entry.child = null
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
      await Promise.race([entry.closed, delay(2_000)])
      signal('SIGKILL')
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) {
      clearInterval(this.timer)
    }

    await this.syncing
    await Promise.all(
      [...this.entries.values()].map((entry) => this.stop(entry))
    )
    this.entries.clear()
  }
}
