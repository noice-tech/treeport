import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLoopbackHost } from './loopback.ts'

export interface AppConfig {
  host: string
  port: number
  databasePath: string
  dataDir: string
  cacheDir: string
  runtimeDir: string
  shell: string
  gitPath: string
  apiUrl: string
  remoteUrl: string | null
  appVersion?: string
  instanceId?: string
  installationMethod?: string
  webDist?: string
  webDevelopment: boolean
  defaultPackages?: string[]
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2))
    : value
}

export function resolveDataDir(
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string {
  if (env.TREEPORT_DATA_DIR?.trim()) {
    return path.resolve(expandHome(env.TREEPORT_DATA_DIR.trim()))
  }

  if (env.XDG_DATA_HOME) {
    return path.join(expandHome(env.XDG_DATA_HOME), 'treeport')
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'treeport')
  }

  return path.join(os.homedir(), '.local', 'share', 'treeport')
}

function defaultCacheDir(
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string {
  if (env.XDG_CACHE_HOME) {
    return path.join(expandHome(env.XDG_CACHE_HOME), 'treeport')
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'treeport')
  }

  return path.join(os.homedir(), '.cache', 'treeport')
}

function defaultRuntimeDir(env: NodeJS.ProcessEnv): string {
  if (env.XDG_RUNTIME_DIR) {
    return path.join(expandHome(env.XDG_RUNTIME_DIR), 'treeport')
  }

  return path.join(os.tmpdir(), `treeport-${process.getuid?.() ?? 'user'}`)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.TREEPORT_HOST?.trim() || env.HOST?.trim() || '127.0.0.1'
  assertLoopbackHost(host)

  const portValue = Number.parseInt(
    env.TREEPORT_PORT?.trim() || env.PORT?.trim() || '8733',
    10
  )

  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
    throw new Error('TREEPORT_PORT must be an integer between 1 and 65535')
  }

  const urlHost =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host

  const dataDir = path.resolve(resolveDataDir(env))

  const runtimeDir = path.resolve(
    expandHome(env.TREEPORT_RUNTIME_DIR?.trim() || defaultRuntimeDir(env))
  )

  const config: AppConfig = {
    defaultPackages: [
      import.meta.resolve('@treeport/review/package.json'),
      import.meta.resolve('@treeport/vscode/package.json'),
      import.meta.resolve('@treeport/github/package.json')
    ].map((manifest) => path.dirname(fileURLToPath(manifest))),
    host,
    port: portValue,
    dataDir,
    cacheDir: path.resolve(
      expandHome(env.TREEPORT_CACHE_DIR?.trim() || defaultCacheDir(env))
    ),
    runtimeDir,
    databasePath: path.resolve(
      expandHome(
        env.TREEPORT_DATABASE_PATH?.trim() || path.join(dataDir, 'treeport.db')
      )
    ),
    shell: path.resolve(
      expandHome(env.TREEPORT_SHELL?.trim() || env.SHELL || '/bin/sh')
    ),
    gitPath: env.TREEPORT_GIT_PATH?.trim() || 'git',
    apiUrl: env.TREEPORT_API_URL?.trim() || `http://${urlHost}:${portValue}`,
    remoteUrl: env.TREEPORT_REMOTE_URL?.trim() || null,
    appVersion: env.TREEPORT_APP_VERSION?.trim() || 'development',
    instanceId: env.TREEPORT_INSTANCE_ID?.trim() || crypto.randomUUID(),
    installationMethod:
      env.TREEPORT_INSTALLATION_METHOD?.trim() || 'development',
    webDevelopment: env.TREEPORT_WEB_DEVELOPMENT?.trim() === '1'
  }

  if (env.TREEPORT_WEB_DIST?.trim()) {
    config.webDist = env.TREEPORT_WEB_DIST.trim()
  }

  return config
}
