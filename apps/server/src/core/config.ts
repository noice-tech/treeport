import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface AppConfig {
  host: string
  port: number
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
  name: 'treeport' | 'tasktty',
  platform = process.platform
): string {
  if (env.XDG_DATA_HOME) {
    return path.join(expandHome(env.XDG_DATA_HOME), name)
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', name)
  }

  return path.join(os.homedir(), '.local', 'share', name)
}

function defaultRuntimeDir(
  env: NodeJS.ProcessEnv,
  name: 'treeport' | 'tasktty'
): string {
  if (env.XDG_RUNTIME_DIR) {
    return path.join(expandHome(env.XDG_RUNTIME_DIR), name)
  }

  return path.join(
    os.tmpdir(),
    `${name}-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`
  )
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host =
    env.TREEPORT_HOST?.trim() || env.TASKTTY_HOST?.trim() || '127.0.0.1'
  const portValue = Number.parseInt(
    env.TREEPORT_PORT?.trim() || env.TASKTTY_PORT?.trim() || '4780',
    10
  )
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
    throw new Error('TREEPORT_PORT must be an integer between 1 and 65535')
  }

  const canonicalDataDir = path.resolve(defaultDataDir(env, 'treeport'))
  const legacyDataDir = path.resolve(defaultDataDir(env, 'tasktty'))
  const canonicalExplicitDataDir = env.TREEPORT_DATA_DIR?.trim()
  const legacyExplicitDataDir = env.TASKTTY_DATA_DIR?.trim()
  const explicitDataDir = canonicalExplicitDataDir || legacyExplicitDataDir
  const canonicalDatabase = path.join(canonicalDataDir, 'treeport.db')
  const legacyDatabase = path.join(legacyDataDir, 'tasktty.db')
  const explicitDatabasePath =
    env.TREEPORT_DATABASE_PATH?.trim() || env.TASKTTY_DATABASE_PATH?.trim()
  if (
    !explicitDataDir &&
    !env.TREEPORT_DATABASE_PATH?.trim() &&
    !env.TASKTTY_DATABASE_PATH?.trim() &&
    fs.existsSync(canonicalDatabase) &&
    fs.existsSync(legacyDatabase)
  ) {
    throw new Error(
      `Both Treeport and legacy TaskTTY databases exist (${canonicalDatabase} and ${legacyDatabase}); set TREEPORT_DATABASE_PATH explicitly`
    )
  }

  const useLegacyDefault =
    !explicitDataDir &&
    !explicitDatabasePath &&
    !fs.existsSync(canonicalDatabase) &&
    fs.existsSync(legacyDatabase)
  const useLegacyDatabaseName = Boolean(
    (!canonicalExplicitDataDir && legacyExplicitDataDir) || useLegacyDefault
  )
  const dataDir = path.resolve(
    expandHome(
      explicitDataDir || (useLegacyDefault ? legacyDataDir : canonicalDataDir)
    )
  )
  const explicitRuntimeDir =
    env.TREEPORT_RUNTIME_DIR?.trim() || env.TASKTTY_RUNTIME_DIR?.trim()
  const canonicalRuntimeDir = defaultRuntimeDir(env, 'treeport')
  const legacyRuntimeDir = defaultRuntimeDir(env, 'tasktty')
  const runtimeDir = path.resolve(
    expandHome(
      explicitRuntimeDir ||
        (!fs.existsSync(canonicalRuntimeDir) && fs.existsSync(legacyRuntimeDir)
          ? legacyRuntimeDir
          : canonicalRuntimeDir)
    )
  )
  return {
    host,
    port: portValue,
    dataDir,
    runtimeDir,
    databasePath: path.resolve(
      expandHome(
        explicitDatabasePath ||
          path.join(
            dataDir,
            useLegacyDatabaseName ? 'tasktty.db' : 'treeport.db'
          )
      )
    ),
    shell: path.resolve(
      expandHome(
        env.TREEPORT_SHELL?.trim() ||
          env.TASKTTY_SHELL?.trim() ||
          env.SHELL ||
          '/bin/sh'
      )
    ),
    tmuxPath:
      env.TREEPORT_TMUX_PATH?.trim() || env.TASKTTY_TMUX_PATH?.trim() || 'tmux',
    gitPath:
      env.TREEPORT_GIT_PATH?.trim() || env.TASKTTY_GIT_PATH?.trim() || 'git',
    ghPath: env.TREEPORT_GH_PATH?.trim() || env.TASKTTY_GH_PATH?.trim() || 'gh',
    apiUrl:
      env.TREEPORT_API_URL?.trim() ||
      env.TASKTTY_API_URL?.trim() ||
      `http://${host}:${portValue}`
  }
}
