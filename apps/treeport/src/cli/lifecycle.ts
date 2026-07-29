import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8733

interface Preferences {
  host?: string
  port?: number
}

export interface DaemonRecord {
  pid: number
  instanceId: string
  version: string
  apiUrl: string
  dataDir: string
  startedAt: string
  installationMethod: string
}

export interface HealthRecord {
  ok: true
  version: string
  protocolVersion: number
  pid: number
  instanceId: string | null
  installationMethod: string
  url: string
}

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
}

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

function localPaths(env: NodeJS.ProcessEnv = process.env): {
  dataDir: string
  runtimeDir: string
  preferencesPath: string
  statePath: string
  lockPath: string
  logPath: string
} {
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

async function readJson<T>(filePath: string): Promise<T | null> {
  return fs
    .readFile(filePath, 'utf8')
    .then((value) => JSON.parse(value) as T)
    .catch(() => null)
}

async function preferences(): Promise<Preferences> {
  return (await readJson<Preferences>(localPaths().preferencesPath)) ?? {}
}

export async function resolveLocalApiUrl(): Promise<string> {
  const explicit = process.env.TREEPORT_API_URL?.trim()
  if (explicit) {
    return explicit.replace(/\/$/, '')
  }

  const saved = await preferences()
  const host =
    process.env.TREEPORT_HOST?.trim() ||
    process.env.HOST?.trim() ||
    saved.host ||
    DEFAULT_HOST
  const port = Number.parseInt(
    process.env.TREEPORT_PORT?.trim() ||
      process.env.PORT?.trim() ||
      String(saved.port ?? DEFAULT_PORT),
    10
  )
  return listenerUrl(host, port)
}

export async function resolvePackagePath(
  ...segments: string[]
): Promise<string> {
  const candidates = [
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
  const manifest = await readJson<{ version?: string }>(
    await resolvePackagePath('package.json')
  )
  return manifest?.version ?? 'development'
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function health(
  apiUrl: string,
  timeoutMs = 1_500
): Promise<HealthRecord | null> {
  const signal = AbortSignal.timeout(timeoutMs)
  return fetch(`${apiUrl}/api/health`, { signal })
    .then(async (response) => {
      if (!response.ok) {
        return null
      }

      const value = (await response.json()) as Partial<HealthRecord>
      return value.ok && typeof value.pid === 'number'
        ? (value as HealthRecord)
        : null
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
  const value = await readJson<Partial<DaemonRecord>>(localPaths().statePath)
  return value &&
    typeof value.pid === 'number' &&
    typeof value.instanceId === 'string' &&
    typeof value.apiUrl === 'string' &&
    typeof value.dataDir === 'string'
    ? (value as DaemonRecord)
    : null
}

async function removeStaleState(state: DaemonRecord): Promise<void> {
  const paths = localPaths()
  for (const filePath of [paths.statePath, paths.lockPath]) {
    const value = await readJson<Partial<DaemonRecord>>(filePath)
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

  const observed = await health(state.apiUrl)
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

async function executableCheck(
  executable: string,
  args: string[]
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      output += chunk
    })
    child.once('error', (error) =>
      resolve({ ok: false, detail: error.message })
    )
    child.once('close', (code) =>
      resolve({
        ok: code === 0,
        detail: output.trim() || `exited with status ${code ?? 1}`
      })
    )
  })
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const paths = localPaths()
  const gitPath = process.env.TREEPORT_GIT_PATH?.trim() || 'git'
  const tmuxPath = process.env.TREEPORT_TMUX_PATH?.trim() || 'tmux'
  const [git, tmux] = await Promise.all([
    executableCheck(gitPath, ['--version']),
    executableCheck(tmuxPath, ['-V'])
  ])
  const tmuxMatch = /tmux\s+(\d+)\.(\d+)/i.exec(tmux.detail)
  const tmuxSupported = Boolean(
    tmux.ok &&
    tmuxMatch &&
    (Number(tmuxMatch[1]) > 3 ||
      (Number(tmuxMatch[1]) === 3 && Number(tmuxMatch[2]) >= 2))
  )

  const checkDirectory = (directoryPath: string) =>
    fs
      .mkdir(directoryPath, { recursive: true, mode: 0o700 })
      .then(() => ({ ok: true, detail: directoryPath }))
      .catch((error: unknown) => ({
        ok: false,
        detail: `${directoryPath}: ${error instanceof Error ? error.message : String(error)}`
      }))
  const [dataDirectory, runtimeDirectory] = await Promise.all([
    checkDirectory(paths.dataDir),
    checkDirectory(paths.runtimeDir)
  ])

  return [
    { name: 'Node', ok: true, detail: process.version },
    { name: 'Git', ...git },
    {
      name: 'tmux',
      ok: tmuxSupported,
      detail: tmuxSupported
        ? tmux.detail
        : `${tmux.detail}. Treeport requires tmux 3.2 or newer.`
    },
    { name: 'Data directory', ...dataDirectory },
    { name: 'Runtime directory', ...runtimeDirectory }
  ]
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

  const observed = await health(state.apiUrl)
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
    host: options.host?.trim() || saved.host || DEFAULT_HOST,
    port: options.port ?? saved.port ?? DEFAULT_PORT
  }
  if (options.host !== undefined || options.port !== undefined) {
    await fs.mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
    const temporaryPath = `${paths.preferencesPath}.${process.pid}.tmp`
    await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600
    })
    await fs.rename(temporaryPath, paths.preferencesPath)
  }

  const host =
    options.host?.trim() || process.env.TREEPORT_HOST?.trim() || next.host!
  const port = Number.parseInt(
    options.port === undefined
      ? process.env.TREEPORT_PORT?.trim() || String(next.port)
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

  const failedChecks = (await runDoctor()).filter((check) => !check.ok)
  if (failedChecks.length) {
    throw new Error(
      failedChecks.map((check) => `${check.name}: ${check.detail}`).join('\n')
    )
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
  const logSize = await fs
    .stat(paths.logPath)
    .then((value) => value.size)
    .catch(() => 0)
  if (logSize > 5 * 1024 * 1024) {
    await fs.rm(`${paths.logPath}.1`, { force: true })
    await fs.rename(paths.logPath, `${paths.logPath}.1`)
  }

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
    TREEPORT_WEB_DIST: webDist
  }

  if (options.foreground) {
    console.log(`Treeport will listen on ${apiUrl}`)
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

  const log = fsSync.openSync(paths.logPath, 'a', 0o600)
  const child = spawn(process.execPath, [serverEntry], {
    env: childEnvironment,
    detached: true,
    stdio: ['ignore', log, log]
  })
  child.unref()
  fsSync.closeSync(log)

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const observed = await health(apiUrl, 500)
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

    if (child.pid && !processExists(child.pid)) {
      break
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const recentLog = await fs
    .readFile(paths.logPath, 'utf8')
    .then((value) => value.split('\n').slice(-20).join('\n').trim())
    .catch(() => '')
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

export async function readDaemonLogs(lines = 100): Promise<string> {
  const value = await fs
    .readFile(localPaths().logPath, 'utf8')
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return ''
      }

      throw error
    })
  return value
    .split('\n')
    .slice(-lines - 1)
    .join('\n')
}
