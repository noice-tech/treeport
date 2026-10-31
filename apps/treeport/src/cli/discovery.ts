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
import { tailDaemonLog } from '../server/daemon-log.ts'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8733

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

interface LocalPaths {
  dataDir: string
  runtimeDir: string
  statePath: string
  logPath: string
}

function localPaths(env: NodeJS.ProcessEnv = process.env): LocalPaths {
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
    statePath: path.join(runtimeDir, 'daemon.json'),
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

const daemonRecordSchema = z.strictObject({
  pid: z.number(),
  instanceId: z.string(),
  version: z.string(),
  apiUrl: z.string(),
  dataDir: z.string(),
  startedAt: z.string(),
  installationMethod: z.string()
})

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

  const record = await readJson(
    daemonRecordPath
      ? path.resolve(expandHome(daemonRecordPath))
      : localPaths(env).statePath,
    daemonRecordSchema
  )

  if (record) {
    return record.apiUrl.replace(/\/$/, '')
  }

  const host = env.TREEPORT_HOST?.trim() || env.HOST?.trim() || DEFAULT_HOST

  const port = Number.parseInt(
    env.TREEPORT_PORT?.trim() || env.PORT?.trim() || String(DEFAULT_PORT),
    10
  )

  return listenerUrl(host, port)
}

export function resolvePackagePath(...segments: string[]): string {
  return path.join(
    fileURLToPath(new URL('../../', import.meta.url)),
    ...segments
  )
}

export async function treeportVersion(): Promise<string> {
  const manifest = await readJson(
    resolvePackagePath('package.json'),
    z.looseObject({ version: z.string().optional() })
  )

  return manifest?.version ?? 'development'
}

export async function daemonHealth(
  apiUrl: string,
  timeoutMs = 1_500
): Promise<HealthResponse | null> {
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

async function resolveDaemonLogPaths(
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
    const record = await readJson(paths.statePath, daemonRecordSchema)

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

  const value = await tailDaemonLog(paths.logPath, lines)

  return value
    ? `=== ${paths.logPath} (including retained history) ===\n${value}\nAn absent exit event does not prove a crash; termination may be unknown. For supervisor evidence, check its logs and OS logs.\n`
    : `No daemon logs found at ${paths.logPath}. Check your supervisor for startup diagnostics.\n`
}
