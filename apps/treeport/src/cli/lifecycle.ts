import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeUnknownOrNull,
  healthResponseSchema,
  type HealthResponse
} from '@treeport/shared'
import { z } from 'zod'
import { assertLoopbackHost } from '../server/core/loopback.js'
import { appendDaemonLog, tailDaemonLog } from '../server/daemon-log.js'
import { humanOutput, type HumanOutput } from './output.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8733

interface Preferences {
  host?: string | undefined
  port?: number | undefined
}

export interface DaemonRecord {
  pid: number
  instanceId: string
  version: string
  apiUrl: string
  dataDir: string
  startedAt: string
  installationMethod: string
  daemonLifecycle: 'treeport' | 'external'
}

export type HealthRecord = HealthResponse

function listenerUrl(host: string, port: number): string {
  const urlHost =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host

  return `http://${urlHost}:${port}`
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2))
    : value
}

export interface LocalPaths {
  dataDir: string
  runtimeDir: string
  preferencesPath: string
  statePath: string
  lockPath: string
  logPath: string
}

export function localPaths(env: NodeJS.ProcessEnv = process.env): LocalPaths {
  const defaultDataDir = env.XDG_DATA_HOME
    ? path.join(expandHome(env.XDG_DATA_HOME), 'treeport')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'treeport')
      : path.join(os.homedir(), '.local', 'share', 'treeport')

  const dataDir = path.resolve(
    expandHome(env.TREEPORT_DATA_DIR?.trim() || defaultDataDir)
  )

  const runtimeDir = path.resolve(
    expandHome(
      env.TREEPORT_RUNTIME_DIR?.trim() ||
        (env.XDG_RUNTIME_DIR
          ? path.join(env.XDG_RUNTIME_DIR, 'treeport')
          : path.join(os.tmpdir(), `treeport-${process.getuid?.() ?? 'user'}`))
    )
  )

  return {
    dataDir,
    runtimeDir,
    preferencesPath: path.join(dataDir, 'config.json'),
    statePath: path.join(runtimeDir, 'daemon.json'),
    lockPath: path.join(dataDir, 'daemon.lock'),
    logPath: path.join(dataDir, 'logs', 'daemon.log')
  }
}

async function readJson<Output>(
  filePath: string,
  schema: z.ZodType<Output>
): Promise<Output | null> {
  return fs
    .readFile(filePath, 'utf8')
    .then((value) => schema.parse(JSON.parse(value)))
    .catch(() => null)
}

const preferencesSchema: z.ZodType<Preferences> = z.looseObject({
  host: z.string().optional(),
  port: z.number().optional()
})

const daemonRecordSchema = z.strictObject({
  pid: z.number(),
  instanceId: z.string(),
  version: z.string(),
  apiUrl: z.string(),
  dataDir: z.string(),
  startedAt: z.string(),
  installationMethod: z.string(),
  daemonLifecycle: z.enum(['treeport', 'external'])
})

async function preferences(
  env: NodeJS.ProcessEnv = process.env
): Promise<Preferences> {
  return (
    (await readJson(localPaths(env).preferencesPath, preferencesSchema)) ?? {}
  )
}

async function savePreferences(value: Preferences): Promise<void> {
  const paths = localPaths()
  await fs.mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
  const temporaryPath = `${paths.preferencesPath}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  })
  await fs.rename(temporaryPath, paths.preferencesPath)
}

export async function resolveLocalApiUrl(
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const explicit = env.TREEPORT_API_URL?.trim()
  const managedApiUrl = env.TREEPORT_MANAGED_API_URL?.trim()
  const daemonRecordPath = env.TREEPORT_DAEMON_RECORD?.trim()

  if (explicit && explicit !== managedApiUrl) {
    return explicit.replace(/\/$/, '')
  }

  if (managedApiUrl && daemonRecordPath) {
    const record = await readJson(
      path.resolve(expandHome(daemonRecordPath)),
      daemonRecordSchema
    )

    if (record) {
      return record.apiUrl.replace(/\/$/, '')
    }
  }

  if (explicit) {
    return explicit.replace(/\/$/, '')
  }

  const saved = await preferences(env)

  const host =
    env.TREEPORT_HOST?.trim() || env.HOST?.trim() || saved.host || DEFAULT_HOST

  const port = Number.parseInt(
    env.TREEPORT_PORT?.trim() ||
      env.PORT?.trim() ||
      String(saved.port ?? DEFAULT_PORT),
    10
  )

  return listenerUrl(host, port)
}

export async function resolvePackagePath(
  ...segments: string[]
): Promise<string> {
  const candidates = [
    fileURLToPath(new URL('../', import.meta.url)),
    fileURLToPath(new URL('../../../', import.meta.url)),
    fileURLToPath(new URL('../../', import.meta.url))
  ]

  for (const candidate of candidates) {
    const manifest = await fs
      .access(path.join(candidate, 'package.json'))
      .then(() => true)
      .catch(() => false)

    if (manifest) {
      return path.join(candidate, ...segments)
    }
  }

  throw new Error('Could not locate the Treeport package directory')
}

export async function treeportVersion(): Promise<string> {
  const manifest = await readJson(
    await resolvePackagePath('package.json'),
    z.looseObject({ version: z.string().optional() })
  )

  return manifest?.version ?? 'development'
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    // SAFETY: process.kill failures use Node's ErrnoException shape.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function daemonHealth(
  apiUrl: string,
  timeoutMs = 1_500
): Promise<HealthRecord | null> {
  const signal = AbortSignal.timeout(timeoutMs)

  return fetch(`${apiUrl}/api/health`, { signal })
    .then(async (response) => {
      if (!response.ok) {
        return null
      }

      return decodeUnknownOrNull(healthResponseSchema, await response.json())
    })
    .catch(() => null)
}

function matchesOwnership(
  state: DaemonRecord,
  observed: HealthRecord
): boolean {
  return (
    observed.pid === state.pid &&
    observed.instanceId === state.instanceId &&
    path.resolve(state.dataDir) === localPaths().dataDir
  )
}

async function readState(): Promise<DaemonRecord | null> {
  const paths = localPaths()

  const starting = await fs
    .readFile(paths.lockPath, 'utf8')
    .then((value) => daemonRecordSchema.parse(JSON.parse(value)))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null
      }

      throw new Error(
        `Cannot verify daemon ownership at ${paths.lockPath}. Inspect the daemon log before starting or stopping Treeport.`,
        { cause: error }
      )
    })

  return starting ?? readJson(paths.statePath, daemonRecordSchema)
}

async function removeStaleState(state: DaemonRecord): Promise<void> {
  const paths = localPaths()

  for (const filePath of [paths.statePath, paths.lockPath]) {
    const value = await readJson(
      filePath,
      z.looseObject({ instanceId: z.string() })
    )

    if (value?.instanceId === state.instanceId) {
      await fs.rm(filePath, { force: true })
    }
  }
}

async function stopOwned(state: DaemonRecord): Promise<void> {
  if (!processExists(state.pid)) {
    await removeStaleState(state)

    return
  }

  const observed = await daemonHealth(state.apiUrl)

  if (!observed || !matchesOwnership(state, observed)) {
    throw new Error(
      `Refusing to stop PID ${state.pid}: Treeport could not verify ownership. Check ${localPaths().statePath}.`
    )
  }

  process.kill(state.pid, 'SIGTERM')
  const deadline = Date.now() + 7_000

  while (Date.now() < deadline) {
    if (!processExists(state.pid)) {
      await removeStaleState(state)

      return
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(
    `Treeport did not stop within 7 seconds. See ${localPaths().logPath}.`
  )
}

export async function daemonStatus(): Promise<{
  running: boolean
  state: DaemonRecord | null
  health: HealthRecord | null
  verified: boolean
}> {
  const state = await readState()

  if (!state) {
    return { running: false, state: null, health: null, verified: false }
  }

  if (!processExists(state.pid)) {
    await removeStaleState(state)

    return { running: false, state: null, health: null, verified: false }
  }

  const observed = await daemonHealth(state.apiUrl)

  return {
    running: Boolean(observed),
    state,
    health: observed,
    verified: Boolean(observed && matchesOwnership(state, observed))
  }
}

export async function daemonUp(options: {
  host?: string
  port?: number
  foreground?: boolean
  output?: HumanOutput
}): Promise<{ alreadyRunning: boolean; apiUrl: string; pid: number }> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 1 ||
      options.port > 65_535)
  ) {
    throw new Error('--port must be an integer between 1 and 65535')
  }

  const paths = localPaths()
  const saved = await preferences()

  const next: Preferences = {
    ...saved,
    host: options.host?.trim() || saved.host || DEFAULT_HOST,
    port: options.port ?? saved.port ?? DEFAULT_PORT
  }

  const host =
    options.host?.trim() ||
    process.env.TREEPORT_HOST?.trim() ||
    process.env.HOST?.trim() ||
    next.host!

  assertLoopbackHost(host)

  if (options.host !== undefined || options.port !== undefined) {
    await savePreferences(next)
  }

  const port = Number.parseInt(
    options.port === undefined
      ? process.env.TREEPORT_PORT?.trim() ||
          process.env.PORT?.trim() ||
          String(next.port)
      : String(options.port),
    10
  )

  const apiUrl =
    options.host !== undefined || options.port !== undefined
      ? listenerUrl(host, port)
      : process.env.TREEPORT_API_URL?.trim() || listenerUrl(host, port)

  const currentVersion = await treeportVersion()
  const existing = await daemonStatus()

  if (existing.state) {
    if (!existing.running || !existing.verified) {
      throw new Error(
        `Treeport PID ${existing.state.pid} is running but ownership or health could not be verified. See ${paths.logPath}.`
      )
    }

    if (
      existing.health?.version === currentVersion &&
      existing.state.apiUrl === apiUrl
    ) {
      return {
        alreadyRunning: true,
        apiUrl: existing.state.apiUrl,
        pid: existing.state.pid
      }
    }

    await stopOwned(existing.state)
  }

  const serverEntry = await resolvePackagePath(
    'dist',
    'node',
    'server',
    'index.js'
  )

  const webDist = await resolvePackagePath('dist', 'web')
  await fs.access(serverEntry)
  await fs.mkdir(path.dirname(paths.logPath), {
    recursive: true,
    mode: 0o700
  })
  const instanceId = crypto.randomUUID()

  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    TREEPORT_HOST: host,
    TREEPORT_PORT: String(port),
    TREEPORT_API_URL: apiUrl,
    TREEPORT_DATA_DIR: paths.dataDir,
    TREEPORT_RUNTIME_DIR: paths.runtimeDir,
    TREEPORT_APP_VERSION: currentVersion,
    TREEPORT_INSTANCE_ID: instanceId,
    TREEPORT_INSTALLATION_METHOD:
      process.env.TREEPORT_INSTALLATION_METHOD?.trim() || 'npm',
    TREEPORT_DAEMON_LIFECYCLE: 'treeport',
    TREEPORT_WEB_DIST: webDist
  }

  if (options.foreground) {
    const output =
      options.output ?? humanOutput(process.env, Boolean(process.stdout.isTTY))

    console.log(
      output.blocks(
        output.summary('Treeport is starting', 'warning'),
        output.rows([['URL', apiUrl]])
      )
    )

    const child = spawn(process.execPath, [serverEntry], {
      env: childEnvironment,
      stdio: 'inherit'
    })

    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (value) => resolve(value ?? 1))
    })

    if (code !== 0) {
      throw new Error(`Treeport exited with status ${code}`)
    }

    return { alreadyRunning: false, apiUrl, pid: child.pid ?? 0 }
  }

  const launcherLogPath = path.join(
    paths.dataDir,
    'logs',
    'daemon-launcher.log'
  )

  appendDaemonLog(
    launcherLogPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'launcher_starting', instanceId, version: currentVersion, lifecycle: 'treeport' })}\n`
  )
  const log = fsSync.openSync(launcherLogPath, 'a', 0o600)

  const child = spawn(process.execPath, [serverEntry], {
    env: { ...childEnvironment, TREEPORT_DAEMON_LOG_ONLY: '1' },
    detached: true,
    stdio: ['ignore', 'ignore', log]
  })

  let launchError: Error | null = null
  child.once('error', (error) => {
    launchError = error
    appendDaemonLog(
      launcherLogPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'launcher_error', instanceId, error: error.stack ?? error.message })}\n`
    )
  })
  child.once('exit', (code, signal) => {
    appendDaemonLog(
      launcherLogPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'launcher_child_exit', instanceId, pid: child.pid ?? null, code, signal })}\n`
    )
  })
  child.unref()
  fsSync.closeSync(log)

  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    const observed = await daemonHealth(apiUrl, 500)

    if (
      observed &&
      observed.pid === child.pid &&
      observed.instanceId === instanceId &&
      observed.version === currentVersion
    ) {
      return {
        alreadyRunning: false,
        apiUrl,
        pid: child.pid ?? observed.pid
      }
    }

    if (launchError || (child.pid && !processExists(child.pid))) {
      break
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const recentLog = await readDaemonLogs(20).catch(() => '')
  throw new Error(
    `Treeport did not become ready at ${apiUrl}. See ${paths.logPath}.${recentLog ? `\n\n${recentLog}` : ''}`
  )
}

export async function daemonDown(): Promise<{ wasRunning: boolean }> {
  const state = await readState()

  if (!state) {
    return { wasRunning: false }
  }

  await stopOwned(state)

  return { wasRunning: true }
}

export async function resolveDaemonLogPaths(
  targetApiUrl?: string
): Promise<LocalPaths> {
  const inheritedRecordPath = process.env.TREEPORT_DAEMON_RECORD?.trim()

  const inherited = inheritedRecordPath
    ? await readJson(
        path.resolve(expandHome(inheritedRecordPath)),
        daemonRecordSchema
      )
    : null

  if (
    inheritedRecordPath &&
    !inherited &&
    !process.env.TREEPORT_DATA_DIR?.trim() &&
    path.resolve(expandHome(inheritedRecordPath)) !== localPaths().statePath
  ) {
    throw new Error(
      `Daemon record ${inheritedRecordPath} is unavailable. Select its TREEPORT_DATA_DIR to read offline logs; refusing to show another instance's logs.`
    )
  }

  const paths = localPaths(
    !process.env.TREEPORT_DATA_DIR?.trim() && inherited
      ? {
          ...process.env,
          TREEPORT_DATA_DIR: inherited.dataDir,
          TREEPORT_RUNTIME_DIR: path.dirname(inheritedRecordPath!)
        }
      : process.env
  )

  if (targetApiUrl) {
    const record =
      (await readJson(paths.lockPath, daemonRecordSchema)) ??
      (await readJson(paths.statePath, daemonRecordSchema))

    const localApiUrl =
      record?.apiUrl ??
      (await resolveLocalApiUrl({
        ...process.env,
        TREEPORT_API_URL: undefined,
        TREEPORT_MANAGED_API_URL: undefined,
        TREEPORT_DAEMON_RECORD: undefined,
        TREEPORT_DATA_DIR: paths.dataDir
      }))

    if (targetApiUrl.replace(/\/$/, '') !== localApiUrl.replace(/\/$/, '')) {
      throw new Error(
        `Cannot read local logs for ${targetApiUrl}. Run treeport logs on that host. For offline local logs, clear TREEPORT_API_URL and select TREEPORT_DATA_DIR.`
      )
    }
  }

  return paths
}

export async function readDaemonLogs(
  lines = 100,
  targetApiUrl?: string
): Promise<string> {
  const paths = await resolveDaemonLogPaths(targetApiUrl)

  const sources = [
    paths.logPath,
    path.join(paths.dataDir, 'logs', 'daemon-launcher.log')
  ]

  const sections: string[] = []

  for (const logPath of sources) {
    const value = await tailDaemonLog(logPath, lines)

    if (value) {
      sections.push(`=== ${logPath} (including retained history) ===\n${value}`)
    }
  }

  return sections.length
    ? `${sections.join('\n')}\nAn absent exit event does not prove a crash; termination may be unknown. For service-manager evidence, run treeport logs --service; also check OS logs.\n`
    : `No daemon logs found at ${paths.logPath}. For service-manager diagnostics, run treeport logs --service.\n`
}
