import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8733

interface RemotePreference {
  port: number
  target: string
}

interface Preferences {
  host?: string
  port?: number
  remote?: RemotePreference
}

export interface TailscaleRemoteStatus {
  configured: boolean
  active: boolean
  port: number | null
  url: string | null
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
  hostname?: string
  pid: number
  instanceId: string | null
  installationMethod: string
  daemonLifecycle: 'treeport' | 'external'
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

async function savePreferences(value: Preferences): Promise<void> {
  const paths = localPaths()
  await fs.mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
  const temporaryPath = `${paths.preferencesPath}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  })
  await fs.rename(temporaryPath, paths.preferencesPath)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function tailscale(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tailscale', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) =>
      reject(
        new Error(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'Tailscale is required for remote access. Install it from https://tailscale.com/download, run `tailscale up`, then retry.'
            : `Could not run Tailscale: ${error.message}`
        )
      )
    )
    child.once('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }

      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      reject(
        new Error(
          `Tailscale ${args[0]} failed${detail ? `: ${detail}` : ` (status ${code ?? 1})`}`
        )
      )
    })
  })
}

function tailscaleJson(
  value: string,
  command: string
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed)) {
    throw new Error(`Tailscale ${command} returned an invalid JSON response`)
  }

  return parsed
}

function remotePreference(value: Preferences): RemotePreference | null {
  if (value.remote === undefined) {
    return null
  }

  if (
    !Number.isInteger(value.remote.port) ||
    value.remote.port < 1 ||
    value.remote.port > 65_535 ||
    !value.remote.target
  ) {
    throw new Error('Treeport remote access preferences are invalid')
  }

  return value.remote
}

function localProxyTarget(apiUrl: string): string {
  if (!URL.canParse(apiUrl)) {
    throw new Error('Treeport remote access requires a loopback daemon URL')
  }

  const url = new URL(apiUrl)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error(
      'Treeport remote access requires a loopback daemon. Run `treeport up --host 127.0.0.1`, then try again.'
    )
  }

  return `http://${url.host}`
}

function portIsServed(config: Record<string, unknown>, port: number): boolean {
  const tcp = config.TCP
  if (isRecord(tcp) && Object.hasOwn(tcp, String(port))) {
    return true
  }

  const foreground = config.Foreground
  return (
    isRecord(foreground) &&
    Object.values(foreground).some(
      (value) => isRecord(value) && portIsServed(value, port)
    )
  )
}

function rootProxyForPort(
  config: Record<string, unknown>,
  port: number
): string | null {
  const web = config.Web
  if (!isRecord(web)) {
    return null
  }

  for (const [hostPort, server] of Object.entries(web)) {
    if (!hostPort.endsWith(`:${port}`) || !isRecord(server)) {
      continue
    }

    const handlers = server.Handlers
    if (!isRecord(handlers) || !isRecord(handlers['/'])) {
      continue
    }

    const proxy = handlers['/'].Proxy
    if (typeof proxy === 'string') {
      return proxy
    }
  }

  return null
}

function proxyMatches(
  actual: string | null,
  expected: string | undefined
): boolean {
  return (
    actual !== null &&
    expected !== undefined &&
    actual.replace(/\/$/, '') === expected.replace(/\/$/, '')
  )
}

async function tailscaleServeConfig(): Promise<Record<string, unknown>> {
  return tailscaleJson(
    await tailscale(['serve', 'status', '--json']),
    'serve status'
  )
}

async function tailscaleRemoteUrl(port: number): Promise<string> {
  const status = tailscaleJson(await tailscale(['status', '--json']), 'status')
  if (status.BackendState !== 'Running') {
    throw new Error(
      'Tailscale is not connected. Run `tailscale up` then try again.'
    )
  }

  const self = status.Self
  const dnsName = isRecord(self) ? self.DNSName : undefined
  if (typeof dnsName !== 'string' || !dnsName.trim()) {
    throw new Error(
      'Tailscale did not report a DNS name. Enable MagicDNS, then try again.'
    )
  }

  return `https://${dnsName.trim().replace(/\.$/, '')}${port === 443 ? '' : `:${port}`}`
}

export async function enableTailscaleRemote(options: {
  port?: number
}): Promise<{ alreadyEnabled: boolean; port: number; url: string }> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 1 ||
      options.port > 65_535)
  ) {
    throw new Error('--port must be an integer between 1 and 65535')
  }

  const saved = await preferences()
  const remote = remotePreference(saved)
  const port = options.port ?? remote?.port ?? DEFAULT_PORT
  if (remote && remote.port !== port) {
    throw new Error(
      `Treeport remote access is already configured on port ${remote.port}. Run \`treeport remote disable\` before choosing another port.`
    )
  }

  const current = await daemonStatus()
  const expectedTarget = localProxyTarget(
    current.state?.apiUrl ?? (await resolveLocalApiUrl())
  )
  const [url, config] = await Promise.all([
    tailscaleRemoteUrl(port),
    tailscaleServeConfig()
  ])
  const existingTarget = rootProxyForPort(config, port)
  if (
    (portIsServed(config, port) || existingTarget !== null) &&
    !proxyMatches(existingTarget, expectedTarget) &&
    !proxyMatches(existingTarget, remote?.target)
  ) {
    throw new Error(
      `Tailscale Serve already uses port ${port}. Choose another port with \`treeport remote enable --port <port>\`.`
    )
  }

  const daemon = await daemonUp({})
  const target = localProxyTarget(daemon.apiUrl)
  const alreadyEnabled = proxyMatches(existingTarget, target)
  if (!alreadyEnabled) {
    await tailscale(['serve', '--bg', `--https=${port}`, target])
  }

  await savePreferences({ ...saved, remote: { port, target } })
  return { alreadyEnabled, port, url }
}

export async function tailscaleRemoteStatus(): Promise<TailscaleRemoteStatus> {
  const saved = await preferences()
  const remote = remotePreference(saved)
  if (!remote) {
    return { configured: false, active: false, port: null, url: null }
  }

  const [url, config] = await Promise.all([
    tailscaleRemoteUrl(remote.port),
    tailscaleServeConfig()
  ])
  return {
    configured: true,
    active: proxyMatches(rootProxyForPort(config, remote.port), remote.target),
    port: remote.port,
    url
  }
}

export async function disableTailscaleRemote(): Promise<{
  wasEnabled: boolean
  changedTailscale: boolean
}> {
  const saved = await preferences()
  const remote = remotePreference(saved)
  if (!remote) {
    return { wasEnabled: false, changedTailscale: false }
  }

  const config = await tailscaleServeConfig()
  if (proxyMatches(rootProxyForPort(config, remote.port), remote.target)) {
    await tailscale(['serve', `--https=${remote.port}`, 'off'])
    delete saved.remote
    await savePreferences(saved)
    return { wasEnabled: true, changedTailscale: true }
  }

  delete saved.remote
  await savePreferences(saved)
  return { wasEnabled: false, changedTailscale: false }
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
  if (options.host !== undefined || options.port !== undefined) {
    await savePreferences(next)
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
