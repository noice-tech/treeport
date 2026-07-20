import os from 'node:os'
import path from 'node:path'

export interface AppConfig {
  host: string
  port: number
  authToken: string | null
  databasePath: string
  dataDir: string
  runtimeDir: string
  shell: string
  tmuxPath: string
  gitPath: string
  ghPath: string
  apiUrl: string
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2))
    : value
}

function defaultDataDir(
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string {
  if (env.XDG_DATA_HOME) {
    return path.join(expandHome(env.XDG_DATA_HOME), 'tasktty')
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'tasktty')
  }

  return path.join(os.homedir(), '.local', 'share', 'tasktty')
}

function defaultRuntimeDir(env: NodeJS.ProcessEnv): string {
  if (env.XDG_RUNTIME_DIR) {
    return path.join(expandHome(env.XDG_RUNTIME_DIR), 'tasktty')
  }

  return path.join(
    os.tmpdir(),
    `tasktty-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`
  )
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.TASKTTY_HOST?.trim() || '127.0.0.1'
  const portValue = Number.parseInt(env.TASKTTY_PORT || '4780', 10)
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
    throw new Error('TASKTTY_PORT must be an integer between 1 and 65535')
  }

  const dataDir = path.resolve(
    expandHome(env.TASKTTY_DATA_DIR || defaultDataDir(env))
  )
  const runtimeDir = path.resolve(
    expandHome(env.TASKTTY_RUNTIME_DIR || defaultRuntimeDir(env))
  )
  const authToken = env.TASKTTY_AUTH_TOKEN?.trim() || null
  if (
    host !== '127.0.0.1' &&
    host !== '::1' &&
    host !== 'localhost' &&
    !authToken
  ) {
    throw new Error(
      'Refusing to bind a non-loopback address without TASKTTY_AUTH_TOKEN'
    )
  }

  return {
    host,
    port: portValue,
    authToken,
    dataDir,
    runtimeDir,
    databasePath: path.resolve(
      expandHome(env.TASKTTY_DATABASE_PATH || path.join(dataDir, 'tasktty.db'))
    ),
    shell: path.resolve(
      expandHome(env.TASKTTY_SHELL || env.SHELL || '/bin/sh')
    ),
    tmuxPath: env.TASKTTY_TMUX_PATH?.trim() || 'tmux',
    gitPath: env.TASKTTY_GIT_PATH?.trim() || 'git',
    ghPath: env.TASKTTY_GH_PATH?.trim() || 'gh',
    apiUrl: env.TASKTTY_API_URL?.trim() || `http://${host}:${portValue}`
  }
}
