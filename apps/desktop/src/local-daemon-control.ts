import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DesktopHealthResponse } from '@treeport/shared'
import { z } from 'zod'
import type {
  LocalControlAction,
  LocalControlAssociation,
  LocalControlDetails
} from './desktop-contract'
import { isLoopbackUrl } from './renderer-url'

const daemonRecordSchema = z.strictObject({
  pid: z.number().int().positive(),
  instanceId: z.string().min(1),
  version: z.string(),
  apiUrl: z.string().url(),
  dataDir: z.string(),
  runtimeDir: z.string(),
  cliEntrypoint: z.string().nullable(),
  runtimeExecutable: z.string(),
  startedAt: z.string(),
  installationMethod: z.string(),
  daemonLifecycle: z.enum(['treeport', 'service', 'external'])
})

type DaemonRecord = z.infer<typeof daemonRecordSchema>

const unavailable = (
  state: LocalControlDetails['state'],
  reason: string
): LocalControlDetails => ({
  state,
  reason,
  canStart: false,
  canStop: false,
  canRestart: false
})

function defaultRecordPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim()
    ? path.join(process.env.XDG_RUNTIME_DIR.trim(), 'treeport')
    : path.join(os.tmpdir(), `treeport-${process.getuid?.() ?? 'user'}`)
  return path.join(runtimeDir, 'daemon.json')
}

async function readPrivateRecord(
  recordPath: string
): Promise<DaemonRecord | null> {
  const [source, stat] = await Promise.all([
    fs.readFile(recordPath, 'utf8').catch(() => null),
    fs.stat(recordPath).catch(() => null)
  ])
  if (
    source === null ||
    !stat?.isFile() ||
    (process.getuid !== undefined && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  ) {
    return null
  }

  const parsed = await Promise.resolve(source)
    .then((value) => daemonRecordSchema.safeParse(JSON.parse(value)))
    .catch(() => null)
  if (!parsed?.success) {
    return null
  }

  const record = parsed.data
  if (
    !path.isAbsolute(record.dataDir) ||
    !path.isAbsolute(record.runtimeDir) ||
    !path.isAbsolute(record.runtimeExecutable) ||
    path.resolve(record.runtimeDir) !== path.resolve(path.dirname(recordPath))
  ) {
    return null
  }

  return record
}

async function executable(pathname: string): Promise<boolean> {
  return fs
    .access(pathname, fsConstants.X_OK)
    .then(() => true)
    .catch(() => false)
}

function associationFor(
  origin: string,
  recordPath: string,
  record: DaemonRecord
): LocalControlAssociation | null {
  return record.cliEntrypoint &&
    path.isAbsolute(record.cliEntrypoint) &&
    record.daemonLifecycle !== 'external'
    ? {
        origin,
        dataDir: path.resolve(record.dataDir),
        runtimeDir: path.resolve(record.runtimeDir),
        recordPath: path.resolve(recordPath),
        cliEntrypoint: path.resolve(record.cliEntrypoint),
        runtimeExecutable: path.resolve(record.runtimeExecutable),
        daemonLifecycle: record.daemonLifecycle
      }
    : null
}

async function associationIsUsable(
  association: LocalControlAssociation
): Promise<boolean> {
  return (
    path.isAbsolute(association.dataDir) &&
    path.isAbsolute(association.runtimeDir) &&
    path.resolve(path.dirname(association.recordPath)) ===
      path.resolve(association.runtimeDir) &&
    (await executable(association.cliEntrypoint)) &&
    (await executable(association.runtimeExecutable))
  )
}

export async function runLocalDaemonCommand(
  association: LocalControlAssociation,
  action: Exclude<LocalControlAction, 'restart'>
): Promise<{ ok: boolean; error: string | null }> {
  if (!(await associationIsUsable(association))) {
    return {
      ok: false,
      error: 'The verified Treeport installation is no longer available.'
    }
  }

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('TREEPORT_') && name !== 'NODE_OPTIONS'
    )
  )
  const listener = new URL(association.origin)
  Object.assign(environment, {
    // npm entrypoints use /usr/bin/env node; desktop PATH may omit Node.
    PATH: [path.dirname(association.runtimeExecutable), environment.PATH]
      .filter(Boolean)
      .join(path.delimiter),
    TREEPORT_API_URL: association.origin,
    TREEPORT_HOST: listener.hostname.replace(/^\[|\]$/gu, ''),
    TREEPORT_PORT: listener.port,
    TREEPORT_DATA_DIR: association.dataDir,
    TREEPORT_RUNTIME_DIR: association.runtimeDir,
    TREEPORT_DAEMON_RECORD: association.recordPath,
    TREEPORT_DAEMON_LIFECYCLE: association.daemonLifecycle,
    TREEPORT_INSTALLATION_METHOD: 'npm',
    TREEPORT_CLI_ENTRYPOINT: association.cliEntrypoint
  })

  return new Promise<{ ok: boolean; error: string | null }>((resolve) => {
    const child = spawn(association.cliEntrypoint, [action, '--json'], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (result: { ok: boolean; error: string | null }) => {
      if (settled) {
        return
      }

      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }

      resolve(result)
    }
    const append = (value: Buffer) => {
      output = `${output}${value.toString('utf8')}`.slice(-64 * 1024)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (error) => finish({ ok: false, error: error.message }))
    child.once('close', (code) => {
      if (code === 0) {
        finish({ ok: true, error: null })
        return
      }

      const parsed = Promise.resolve(output)
        .then((value) =>
          z
            .object({ error: z.object({ message: z.string() }) })
            .safeParse(JSON.parse(value))
        )
        .catch(() => null)
      void parsed.then((result) =>
        finish({
          ok: false,
          error:
            result?.success === true
              ? result.data.error.message
              : output.trim() || `Treeport exited with status ${code ?? 1}.`
        })
      )
    })
    timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish({
        ok: false,
        error: `Treeport ${action} did not complete within 30 seconds.`
      })
    }, 30_000)
  }).catch(() => ({
    ok: false,
    error: 'Could not launch the verified Treeport installation.'
  }))
}

export async function inspectLocalDaemonControl(input: {
  origin: string
  health: DesktopHealthResponse | null
  remembered: LocalControlAssociation | null
}): Promise<{
  details: LocalControlDetails
  association: LocalControlAssociation | null
}> {
  const target = new URL(input.origin)
  if (!isLoopbackUrl(target)) {
    return {
      details: unavailable(
        'remote',
        'Lifecycle control is available only for a verified local installation.'
      ),
      association: null
    }
  }

  if (input.health?.daemonLifecycle === 'external') {
    return {
      details: unavailable(
        'external',
        'This daemon is managed by the process that started it.'
      ),
      association: null
    }
  }

  if (!input.health && input.remembered?.origin === input.origin) {
    if (!(await associationIsUsable(input.remembered))) {
      return {
        details: unavailable(
          'unverified',
          'The previously verified Treeport installation is no longer available.'
        ),
        association: null
      }
    }

    const record = await readPrivateRecord(input.remembered.recordPath)
    if (!record) {
      return {
        details: {
          state: 'stopped',
          reason: null,
          canStart: true,
          canStop: false,
          canRestart: false
        },
        association: input.remembered
      }
    }

    const current = associationFor(
      input.origin,
      input.remembered.recordPath,
      record
    )
    if (
      !current ||
      JSON.stringify(current) !== JSON.stringify(input.remembered)
    ) {
      return {
        details: unavailable(
          'unverified',
          'The local daemon record no longer matches this saved installation.'
        ),
        association: null
      }
    }

    return {
      details: unavailable(
        'unhealthy',
        'The verified daemon process has a record but did not respond to health checks.'
      ),
      association: input.remembered
    }
  }

  if (!input.health) {
    return {
      details: unavailable(
        'unverified',
        'Start Treeport once from the CLI so the desktop can verify its installation.'
      ),
      association: null
    }
  }

  if (
    input.health.pid === undefined ||
    input.health.instanceId === undefined ||
    !input.health.daemonLifecycle
  ) {
    return {
      details: unavailable(
        'unverified',
        'The backend did not provide enough ownership information.'
      ),
      association: null
    }
  }

  const candidatePaths = [
    ...(input.remembered?.origin === input.origin
      ? [input.remembered.recordPath]
      : []),
    defaultRecordPath()
  ].filter((value, index, values) => values.indexOf(value) === index)

  for (const recordPath of candidatePaths) {
    const record = await readPrivateRecord(recordPath)
    if (!record || new URL(record.apiUrl).origin !== input.origin) {
      continue
    }

    if (
      record.pid !== input.health.pid ||
      record.instanceId !== input.health.instanceId ||
      record.daemonLifecycle !== input.health.daemonLifecycle
    ) {
      continue
    }

    const association = associationFor(input.origin, recordPath, record)
    if (!association || !(await associationIsUsable(association))) {
      continue
    }

    return {
      details: {
        state: 'running',
        reason: null,
        canStart: false,
        canStop: true,
        canRestart: true
      },
      association
    }
  }

  return {
    details: unavailable(
      'unverified',
      'The running backend could not be matched to a private local daemon record.'
    ),
    association: null
  }
}
