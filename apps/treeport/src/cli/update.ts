import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { decodeUnknownOrNull, projectsResponseSchema } from '@treeport/shared'
import { z } from 'zod'
import {
  daemonDown,
  daemonStatus,
  localPaths,
  resolvePackagePath
} from './lifecycle.js'
import { serviceInstalled, serviceStatus, serviceStop } from './service.js'
import {
  readUpdateStartupReport,
  type UpdateMigrationState,
  type UpdateStartupReport
} from '../server/update-startup.js'

const PACKAGE_NAME = '@treeport/treeport'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const DESTRUCTIVE_PHASES = new Set([
  'stop',
  'activate',
  'restart',
  'health_check',
  'rollback',
  'recovery_required'
])

export type LocalUpdatePhase =
  | 'inspect'
  | 'resolve'
  | 'stage'
  | 'verify'
  | 'stop'
  | 'activate'
  | 'restart'
  | 'health_check'
  | 'rollback'
  | 'complete'
  | 'recovery_required'

interface UpdateOperation {
  schemaVersion: 1
  operationId: string
  phase: LocalUpdatePhase
  fromVersion: string
  toVersion: string | null
  npmPrefix: string | null
  activeTarget: string | null
  stagedTarget: string | null
  previousTarget: string | null
  daemonWasRunning: boolean
  daemonLifecycle: 'treeport' | 'service' | null
  serviceMode: 'user' | 'headless' | null
  terminalIds: string[]
  activated: boolean
  migrationState: UpdateMigrationState
  rollbackAttempted: boolean
  rollbackSucceeded: boolean
  recoveryAction: string | null
  updatedAt: string
}

const operationSchema: z.ZodType<UpdateOperation> = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  phase: z.enum([
    'inspect',
    'resolve',
    'stage',
    'verify',
    'stop',
    'activate',
    'restart',
    'health_check',
    'rollback',
    'complete',
    'recovery_required'
  ]),
  fromVersion: z.string(),
  toVersion: z.string().nullable(),
  npmPrefix: z.string().nullable(),
  activeTarget: z.string().nullable(),
  stagedTarget: z.string().nullable(),
  previousTarget: z.string().nullable(),
  daemonWasRunning: z.boolean(),
  daemonLifecycle: z.enum(['treeport', 'service']).nullable(),
  serviceMode: z.enum(['user', 'headless']).nullable(),
  terminalIds: z.array(z.string()),
  activated: z.boolean(),
  migrationState: z.enum(['not_started', 'unchanged', 'advanced', 'unknown']),
  rollbackAttempted: z.boolean(),
  rollbackSucceeded: z.boolean(),
  recoveryAction: z.string().nullable(),
  updatedAt: z.string()
})

const lockSchema = z.strictObject({
  operationId: z.string().uuid(),
  pid: z.number().int().positive(),
  fromVersion: z.string(),
  startedAt: z.string()
})

const packageSchema = z.looseObject({
  name: z.literal(PACKAGE_NAME),
  version: z.string()
})

const releaseSchema = z.looseObject({
  name: z.literal(PACKAGE_NAME),
  version: z.string(),
  dist: z.looseObject({
    tarball: z.string().url(),
    integrity: z.string().min(1)
  })
})

const packedReleaseSchema = z.tuple([
  z.looseObject({
    filename: z.string().min(1),
    integrity: z.string().min(1)
  })
])

export type TreeportRelease = z.infer<typeof releaseSchema>

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface LocalUpdateResult {
  schemaVersion: 1
  operationId: string
  status: 'current' | 'updated'
  phase: 'complete'
  fromVersion: string
  toVersion: string
  installation: { method: 'npm' }
  daemon: {
    wasRunning: boolean
    lifecycle: 'treeport' | 'service' | null
    restarted: boolean
    healthy: boolean
    version: string | null
  }
  terminals: {
    before: number
    after: number
    preserved: boolean
  }
  rollback: {
    attempted: boolean
    safe: boolean
    succeeded: boolean
  }
}

interface LocalUpdateRollbackDetails {
  attempted: boolean
  safe: boolean
  succeeded: boolean
}

export interface LocalUpdateErrorDetails {
  phase?: LocalUpdatePhase
  operationId?: string
  fromVersion?: string
  toVersion?: string | null
  entrypoint?: string
  npmPrefix?: string
  apiUrl?: string
  cause?: string
  pid?: number
  mode?: 'headless'
  migrationState?: UpdateMigrationState
  rollback?: LocalUpdateRollbackDetails
  recovery?: string
  logPath?: string
  snapshotPaths?: string[]
  terminalIds?: string[]
}

export function formatLocalUpdateError(
  message: string,
  details: {
    cause?: string | undefined
    recovery?: string | undefined
    logPath?: string | undefined
    snapshotPaths?: string[] | undefined
  } = {}
): string {
  return [
    ...new Set(
      [
        message,
        details.cause,
        details.recovery,
        details.logPath ? `Daemon log: ${details.logPath}` : null,
        ...(details.snapshotPaths ?? []).map(
          (snapshot) => `Pre-migration snapshot: ${snapshot}`
        )
      ].filter(Boolean)
    )
  ].join('\n')
}

export interface LocalUpdateOptions {
  environment?: NodeJS.ProcessEnv
  progress?: (message: string) => void
}

export class LocalUpdateError extends Error {
  readonly exitCode: number

  constructor(
    readonly code: string,
    message: string,
    readonly details: LocalUpdateErrorDetails,
    exitCode?: number
  ) {
    super(message)
    this.exitCode =
      exitCode ??
      ([
        'UPDATE_INSTALLATION_UNSUPPORTED',
        'UPDATE_INSTALLATION_NOT_WRITABLE',
        'UPDATE_REMOTE_REFUSED',
        'UPDATE_EXTERNAL_REFUSED',
        'UPDATE_IN_PROGRESS',
        'UPDATE_DOWNGRADE_REFUSED',
        'UPDATE_DAEMON_OWNERSHIP_FAILED',
        'UPDATE_SERVICE_ADMINISTRATOR_ACTION_REQUIRED'
      ].includes(code)
        ? 5
        : 1)
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // SAFETY: Node process.kill reports system failures through ErrnoException.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function runCommand(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (value: string) => {
      stdout += value
    })
    child.stderr.on('data', (value: string) => {
      stderr += value
    })
    child.once('error', (error) => {
      resolve({ code: 127, stdout, stderr: error.message })
    })
    child.once('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

function commandFailure(command: string, result: CommandResult): string {
  const detail = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join('\n')
  return `${command} failed${
    detail ? `: ${detail}` : ` with status ${result.code}`
  }`
}

async function writeJson<Value extends object>(
  filePath: string,
  value: Value
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  })
  await fs.rename(temporaryPath, filePath)
}

async function readOperation(
  filePath: string
): Promise<UpdateOperation | null> {
  return fs
    .readFile(filePath, 'utf8')
    .then((value) => operationSchema.safeParse(JSON.parse(value)))
    .then((result) => (result.success ? result.data : null))
    .catch(() => null)
}

export interface LocalUpdateProgress {
  active: boolean
  operationId: string | null
  phase: LocalUpdatePhase | null
  fromVersion: string | null
  toVersion: string | null
  recoveryAction: string | null
  migrationState: UpdateMigrationState | null
}

export async function readLocalUpdateProgress(
  dataDir: string
): Promise<LocalUpdateProgress> {
  const updateDirectory = path.join(dataDir, 'updates')
  const [operation, lock] = await Promise.all([
    readOperation(path.join(updateDirectory, 'operation.json')),
    fs
      .readFile(path.join(updateDirectory, 'update.lock'), 'utf8')
      .then((value) => lockSchema.safeParse(JSON.parse(value)))
      .then((result) => (result.success ? result.data : null))
      .catch(() => null)
  ])
  const active = Boolean(lock && processExists(lock.pid))
  const operationMatchesLock =
    !lock || operation?.operationId === lock.operationId

  return {
    active,
    operationId: operationMatchesLock
      ? (operation?.operationId ?? lock?.operationId ?? null)
      : (lock?.operationId ?? null),
    phase: operationMatchesLock ? (operation?.phase ?? null) : null,
    fromVersion: operationMatchesLock
      ? (operation?.fromVersion ?? lock?.fromVersion ?? null)
      : (lock?.fromVersion ?? null),
    toVersion: operationMatchesLock ? (operation?.toVersion ?? null) : null,
    recoveryAction: operationMatchesLock
      ? (operation?.recoveryAction ?? null)
      : null,
    migrationState: operationMatchesLock
      ? (operation?.migrationState ?? null)
      : null
  }
}

export function isCanonicalTreeportVersion(version: string): boolean {
  return VERSION.test(version)
}

export function compareTreeportVersions(left: string, right: string): number {
  const leftMatch = VERSION.exec(left)
  const rightMatch = VERSION.exec(right)
  if (!leftMatch || !rightMatch) {
    throw new LocalUpdateError(
      'UPDATE_RELEASE_INVALID',
      `Treeport update requires canonical stable versions; found ${left} and ${right}.`,
      { fromVersion: left, toVersion: right }
    )
  }

  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index])
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

async function replaceSymlink(linkPath: string, target: string): Promise<void> {
  const temporaryPath = `${linkPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.symlink(target, temporaryPath)
  await fs.rename(temporaryPath, linkPath)
}

async function terminalIds(apiUrl: string): Promise<string[]> {
  const result = await fetch(`${apiUrl}/api/projects`)
    .then(async (response) => (response.ok ? response.json() : null))
    .catch(() => null)
  const parsed = decodeUnknownOrNull(projectsResponseSchema, result)
  if (!parsed) {
    throw new Error('Treeport could not read the terminal inventory.')
  }

  return parsed.projects
    .flatMap((project) => project.worktrees)
    .flatMap((worktree) => worktree.terminals)
    .map((terminal) => terminal.id)
    .sort()
}

// Missing evidence after a possible startup must never authorize an older binary.
export function updateMigrationState(
  operation: Pick<
    UpdateOperation,
    'operationId' | 'toVersion' | 'phase' | 'migrationState'
  >,
  report: UpdateStartupReport | null
): UpdateMigrationState {
  if (operation.migrationState === 'advanced') {
    return 'advanced'
  }

  if (
    report?.operationId === operation.operationId &&
    report.targetVersion === operation.toVersion
  ) {
    return report.migrationState
  }

  return ['stop', 'activate'].includes(operation.phase) &&
    operation.migrationState === 'not_started'
    ? 'not_started'
    : 'unknown'
}

async function stopUpdateDaemon(
  lifecycle: UpdateOperation['daemonLifecycle']
): Promise<void> {
  if (lifecycle === 'service') {
    const stopped = await serviceStop()
    if (stopped.administratorCommand) {
      throw new LocalUpdateError(
        'UPDATE_SERVICE_ADMINISTRATOR_ACTION_REQUIRED',
        'The service requires administrator action and was not stopped.',
        { phase: 'stop' }
      )
    }

    const deadline = Date.now() + 7_000
    while ((await daemonStatus()).state) {
      if (Date.now() >= deadline) {
        throw new Error(
          'Treeport could not verify that the service daemon stopped. Inspect the daemon log before changing the installed version.'
        )
      }

      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } else {
    await daemonDown()
  }
}

async function startThroughStableEntrypoint(
  entrypoint: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const result = await runCommand(entrypoint, ['start', '--json'], environment)
  if (result.code !== 0) {
    throw new Error(commandFailure('treeport start', result))
  }
}

export interface LocalUpdateInstallation {
  prefix: string
  packageDirectory: string
  entrypoint: string
  version: string
  managedRoot: string
  currentLink: string
  versionsDirectory: string
  managed: boolean
}

export async function inspectLocalUpdateInstallation(
  environment: NodeJS.ProcessEnv = process.env
): Promise<LocalUpdateInstallation> {
  const entrypointValue = environment.TREEPORT_CLI_ENTRYPOINT?.trim()
  if (!entrypointValue || !path.isAbsolute(entrypointValue)) {
    throw new LocalUpdateError(
      'UPDATE_INSTALLATION_UNSUPPORTED',
      'Treeport could not identify a stable npm CLI entrypoint. Reinstall Treeport globally with npm, then retry.',
      { phase: 'inspect' }
    )
  }

  const npm = await runCommand('npm', ['prefix', '--global'], environment)
  if (npm.code !== 0 || !npm.stdout.trim()) {
    throw new LocalUpdateError(
      'UPDATE_INSTALLATION_UNSUPPORTED',
      commandFailure('npm prefix --global', npm),
      { phase: 'inspect' }
    )
  }

  const prefix = path.resolve(npm.stdout.trim())
  const entrypoint = path.resolve(entrypointValue)
  const expectedEntrypoint = path.join(prefix, 'bin', 'treeport')
  if (entrypoint !== expectedEntrypoint) {
    throw new LocalUpdateError(
      'UPDATE_INSTALLATION_UNSUPPORTED',
      `The active Treeport command is not in the current global npm prefix: ${entrypoint}`,
      { phase: 'inspect', entrypoint, npmPrefix: prefix }
    )
  }

  const packageDirectory = path.dirname(
    await resolvePackagePath('package.json')
  )
  const directPackage = path.join(
    prefix,
    'lib',
    'node_modules',
    '@treeport',
    'treeport'
  )
  const managedRoot = path.join(prefix, 'lib', 'treeport')
  const currentLink = path.join(managedRoot, 'current')
  const managedPackage = path.join(
    currentLink,
    'lib',
    'node_modules',
    '@treeport',
    'treeport'
  )
  const [actualPackage, actualDirect, actualManaged] = await Promise.all([
    fs.realpath(packageDirectory),
    fs.realpath(directPackage).catch(() => null),
    fs.realpath(managedPackage).catch(() => null)
  ])
  if (actualPackage !== actualDirect && actualPackage !== actualManaged) {
    throw new LocalUpdateError(
      'UPDATE_INSTALLATION_UNSUPPORTED',
      'The active Treeport package does not belong to the current global npm prefix. Reinstall Treeport globally with npm, then retry.',
      { phase: 'inspect', npmPrefix: prefix }
    )
  }

  const manifest = await fs
    .readFile(path.join(packageDirectory, 'package.json'), 'utf8')
    .then((value) => packageSchema.safeParse(JSON.parse(value)))
    .catch(() => null)
  if (!manifest?.success || !VERSION.test(manifest.data.version)) {
    throw new LocalUpdateError(
      'UPDATE_INSTALLATION_UNSUPPORTED',
      'The active Treeport package manifest is invalid.',
      { phase: 'inspect' }
    )
  }

  await Promise.all([
    fs.access(entrypoint, fsConstants.X_OK),
    fs.access(process.execPath, fsConstants.X_OK),
    fs.mkdir(managedRoot, { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(managedRoot, 'versions'), {
      recursive: true,
      mode: 0o700
    })
  ]).catch((error) => {
    throw new LocalUpdateError(
      'UPDATE_INSTALLATION_NOT_WRITABLE',
      'The global npm installation is not writable. Install Node and npm under your user account, reinstall Treeport globally, and retry.',
      {
        phase: 'inspect',
        npmPrefix: prefix,
        cause: error instanceof Error ? error.message : String(error)
      }
    )
  })

  const writeProbe = path.join(
    path.dirname(entrypoint),
    `.treeport-update-${process.pid}-${crypto.randomUUID()}`
  )
  await fs
    .writeFile(writeProbe, '', { mode: 0o600, flag: 'wx' })
    .then(() => fs.rename(writeProbe, `${writeProbe}.renamed`))
    .then(() => fs.rm(`${writeProbe}.renamed`, { force: true }))
    .catch(async (error) => {
      await fs.rm(writeProbe, { force: true })
      await fs.rm(`${writeProbe}.renamed`, { force: true })
      throw new LocalUpdateError(
        'UPDATE_INSTALLATION_NOT_WRITABLE',
        'The global npm bin directory is not writable. Install Node and npm under your user account, reinstall Treeport globally, and retry.',
        {
          phase: 'inspect',
          npmPrefix: prefix,
          cause: error instanceof Error ? error.message : String(error)
        }
      )
    })

  return {
    prefix,
    packageDirectory,
    entrypoint,
    version: manifest.data.version,
    managedRoot,
    currentLink,
    versionsDirectory: path.join(managedRoot, 'versions'),
    managed: actualPackage === actualManaged
  }
}

export async function resolveLatestTreeportRelease(
  environment: NodeJS.ProcessEnv = process.env,
  operationId?: string
): Promise<TreeportRelease> {
  const releaseCommand = await runCommand(
    'npm',
    ['view', `${PACKAGE_NAME}@latest`, '--json'],
    environment
  )
  if (releaseCommand.code !== 0) {
    throw new LocalUpdateError(
      'UPDATE_RELEASE_RESOLUTION_FAILED',
      commandFailure('npm view', releaseCommand),
      operationId ? { phase: 'resolve', operationId } : { phase: 'resolve' }
    )
  }

  const release = await Promise.resolve(releaseCommand.stdout)
    .then((value) => releaseSchema.safeParse(JSON.parse(value)))
    .catch(() => null)
  if (!release?.success || !VERSION.test(release.data.version)) {
    throw new LocalUpdateError(
      'UPDATE_RELEASE_INVALID',
      'npm returned an invalid Treeport stable release.',
      operationId ? { phase: 'resolve', operationId } : { phase: 'resolve' }
    )
  }

  return release.data
}

export async function runLocalUpdate(
  options: LocalUpdateOptions = {}
): Promise<LocalUpdateResult> {
  const environment = options.environment ?? process.env
  const progress = options.progress ?? (() => undefined)
  const explicitApiUrl = environment.TREEPORT_API_URL?.trim()
  if (explicitApiUrl) {
    const parsed = URL.canParse(explicitApiUrl) ? new URL(explicitApiUrl) : null
    if (
      !parsed ||
      !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)
    ) {
      throw new LocalUpdateError(
        'UPDATE_REMOTE_REFUSED',
        'Run `treeport update` on the computer that owns the selected Treeport daemon.',
        { phase: 'inspect', apiUrl: explicitApiUrl }
      )
    }
  }

  if (environment.TREEPORT_DAEMON_LIFECYCLE?.trim() === 'external') {
    throw new LocalUpdateError(
      'UPDATE_EXTERNAL_REFUSED',
      'Cannot update Treeport because this daemon lifecycle is externally managed.',
      { phase: 'inspect' }
    )
  }

  const paths = localPaths(environment)
  const updateDirectory = path.join(paths.dataDir, 'updates')
  const lockPath = path.join(updateDirectory, 'update.lock')
  const operationPath = path.join(updateDirectory, 'operation.json')
  await fs.mkdir(updateDirectory, { recursive: true, mode: 0o700 })

  const operationId = crypto.randomUUID()
  const staleOperation = await readOperation(operationPath)
  const provisionalVersion = await fs
    .readFile(await resolvePackagePath('package.json'), 'utf8')
    .then((value) => packageSchema.parse(JSON.parse(value)).version)
  const lock = {
    operationId,
    pid: process.pid,
    fromVersion: provisionalVersion,
    startedAt: new Date().toISOString()
  }
  const lockAcquired = await fs
    .open(lockPath, 'wx', 0o600)
    .then(async (file) => {
      await file.writeFile(`${JSON.stringify(lock)}\n`)
      await file.close()
      return true
    })
    .catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error
      }

      const owner = await fs
        .readFile(lockPath, 'utf8')
        .then((value) => lockSchema.safeParse(JSON.parse(value)))
        .then((result) => (result.success ? result.data : null))
        .catch(() => null)
      if (owner && processExists(owner.pid)) {
        throw new LocalUpdateError(
          'UPDATE_IN_PROGRESS',
          `Treeport update ${owner.operationId} is already running.`,
          { phase: 'inspect', operationId: owner.operationId }
        )
      }

      await fs.rm(lockPath, { force: true })
      const file = await fs.open(lockPath, 'wx', 0o600)
      await file.writeFile(`${JSON.stringify(lock)}\n`)
      await file.close()
      return true
    })

  if (!lockAcquired) {
    throw new LocalUpdateError(
      'UPDATE_IN_PROGRESS',
      'Another Treeport update is already running.',
      { phase: 'inspect' }
    )
  }

  let interrupted = false
  const interrupt = () => {
    interrupted = true
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)

  let operation: UpdateOperation = {
    schemaVersion: 1,
    operationId,
    phase: 'inspect',
    fromVersion: provisionalVersion,
    toVersion: null,
    npmPrefix: null,
    activeTarget: null,
    stagedTarget: null,
    previousTarget: null,
    daemonWasRunning: false,
    daemonLifecycle: null,
    serviceMode: null,
    terminalIds: [],
    activated: false,
    migrationState: 'not_started',
    rollbackAttempted: false,
    rollbackSucceeded: false,
    recoveryAction: null,
    updatedAt: new Date().toISOString()
  }
  let recoveryOperation: UpdateOperation | null = null
  let recoveryReport: UpdateStartupReport | null = null
  const save = async (phase: LocalUpdatePhase) => {
    operation = { ...operation, phase, updatedAt: new Date().toISOString() }
    if (recoveryOperation && !DESTRUCTIVE_PHASES.has(phase)) {
      return
    }

    await writeJson(operationPath, operation)
  }
  let installation: Awaited<
    ReturnType<typeof inspectLocalUpdateInstallation>
  > | null = null

  try {
    installation = await inspectLocalUpdateInstallation(environment)
    operation = {
      ...operation,
      fromVersion: installation.version,
      npmPrefix: installation.prefix,
      activeTarget: installation.managed
        ? await fs
            .realpath(installation.currentLink)
            .catch(() => installation!.prefix)
        : installation.prefix
    }

    if (
      staleOperation &&
      staleOperation.daemonWasRunning &&
      DESTRUCTIVE_PHASES.has(staleOperation.phase) &&
      !(await daemonStatus()).running
    ) {
      await stopUpdateDaemon(staleOperation.daemonLifecycle)
      const staleReport = await readUpdateStartupReport(paths.dataDir)
      staleOperation.migrationState = updateMigrationState(
        staleOperation,
        staleReport
      )
      const rollbackUnsafe = ['advanced', 'unknown'].includes(
        staleOperation.migrationState
      )
      if (rollbackUnsafe) {
        recoveryReport =
          staleReport?.operationId === staleOperation.operationId &&
          staleReport.targetVersion === staleOperation.toVersion
            ? staleReport
            : null
        if (
          staleOperation.previousTarget &&
          operation.activeTarget === staleOperation.previousTarget
        ) {
          throw new LocalUpdateError(
            'UPDATE_RECOVERY_REQUIRED',
            'The older Treeport version is active after a database migration may have started. Treeport will not start it.',
            {
              phase: 'recovery_required',
              operationId: staleOperation.operationId,
              migrationState: staleOperation.migrationState,
              logPath: recoveryReport?.logPath ?? paths.logPath,
              snapshotPaths: recoveryReport?.snapshotPaths ?? [],
              recovery:
                'Install the same or a newer Treeport release and inspect the daemon log.'
            }
          )
        }

        recoveryOperation = staleOperation
      } else {
        if (staleOperation.previousTarget) {
          await replaceSymlink(
            installation.currentLink,
            staleOperation.previousTarget
          )
        }

        await fs.rm(path.join(updateDirectory, 'pending-startup.json'), {
          force: true
        })
        await fs.rm(path.join(updateDirectory, 'startup-report.json'), {
          force: true
        })
        await startThroughStableEntrypoint(
          installation.entrypoint,
          environment
        ).catch((error) => {
          throw new LocalUpdateError(
            'UPDATE_RECOVERY_REQUIRED',
            'Treeport restored the previous version but could not restart its daemon.',
            {
              phase: 'recovery_required',
              operationId: staleOperation.operationId,
              cause: error instanceof Error ? error.message : String(error),
              recovery: 'Inspect the daemon log, then run `treeport start`.'
            }
          )
        })
        await writeJson(operationPath, {
          ...staleOperation,
          phase: 'complete',
          activated: false,
          rollbackAttempted: true,
          rollbackSucceeded: true,
          recoveryAction: 'Run `treeport update` again.',
          updatedAt: new Date().toISOString()
        } satisfies UpdateOperation)
        throw new LocalUpdateError(
          'UPDATE_ROLLED_BACK',
          'Treeport recovered the interrupted update and restored the previous running version. Run `treeport update` again.',
          {
            phase: 'rollback',
            operationId: staleOperation.operationId,
            migrationState: staleReport?.migrationState ?? 'not_started',
            rollback: { attempted: true, safe: true, succeeded: true },
            recovery: 'Run `treeport update` again.'
          }
        )
      }
    }

    await save('inspect')
    const initialDaemon = await daemonStatus()
    if (initialDaemon.state && !initialDaemon.verified) {
      throw new LocalUpdateError(
        'UPDATE_DAEMON_OWNERSHIP_FAILED',
        'Treeport found a daemon whose ownership or health could not be verified.',
        { phase: 'inspect', operationId, pid: initialDaemon.state.pid }
      )
    }

    if (initialDaemon.health?.daemonLifecycle === 'external') {
      throw new LocalUpdateError(
        'UPDATE_EXTERNAL_REFUSED',
        'Cannot update Treeport because this daemon lifecycle is externally managed.',
        { phase: 'inspect', operationId }
      )
    }

    if (explicitApiUrl && initialDaemon.state) {
      const selectedUrl = new URL(explicitApiUrl)
      const localUrl = new URL(initialDaemon.state.apiUrl)
      if (
        selectedUrl.protocol !== localUrl.protocol ||
        (selectedUrl.port || '80') !== (localUrl.port || '80')
      ) {
        throw new LocalUpdateError(
          'UPDATE_REMOTE_REFUSED',
          'The selected daemon is not the verified local Treeport daemon. Run the update against the local daemon.',
          { phase: 'inspect', operationId, apiUrl: explicitApiUrl }
        )
      }
    }

    const installedService = await serviceInstalled()
    const serviceBefore = installedService ? await serviceStatus() : null
    if (
      serviceBefore?.mode === 'headless' &&
      (serviceBefore.active || initialDaemon.running)
    ) {
      throw new LocalUpdateError(
        'UPDATE_SERVICE_ADMINISTRATOR_ACTION_REQUIRED',
        'Stop the advanced headless service with its administrator action, then run `treeport update` again.',
        { phase: 'inspect', operationId, mode: 'headless' }
      )
    }

    if (
      installedService &&
      initialDaemon.running &&
      initialDaemon.health?.daemonLifecycle !== 'service'
    ) {
      throw new LocalUpdateError(
        'UPDATE_DAEMON_OWNERSHIP_FAILED',
        'The running daemon does not belong to the installed Treeport service lifecycle.',
        { phase: 'inspect', operationId }
      )
    }

    await save('resolve')
    progress('Resolving the latest Treeport release…')
    const release = await resolveLatestTreeportRelease(environment, operationId)

    operation.toVersion = release.version
    const comparison = compareTreeportVersions(
      release.version,
      installation.version
    )
    if (comparison < 0) {
      throw new LocalUpdateError(
        'UPDATE_DOWNGRADE_REFUSED',
        `Treeport will not downgrade from ${installation.version} to ${release.version}.`,
        { phase: 'resolve', operationId }
      )
    }

    if (comparison === 0 && recoveryOperation) {
      throw new LocalUpdateError(
        'UPDATE_RECOVERY_REQUIRED',
        'Treeport needs a newer release to recover after the interrupted database migration.',
        {
          phase: 'recovery_required',
          operationId: recoveryOperation.operationId,
          migrationState: recoveryOperation.migrationState,
          logPath: recoveryReport?.logPath ?? paths.logPath,
          snapshotPaths: recoveryReport?.snapshotPaths ?? [],
          recovery:
            'Install the next Treeport release when it is available and run `treeport update` again.'
        }
      )
    }

    if (comparison === 0) {
      const currentTerminals = initialDaemon.verified
        ? await terminalIds(initialDaemon.state!.apiUrl)
        : []
      const currentLifecycle = initialDaemon.verified
        ? initialDaemon.health!.daemonLifecycle === 'service'
          ? 'service'
          : initialDaemon.health!.daemonLifecycle === 'treeport'
            ? 'treeport'
            : null
        : installedService
          ? 'service'
          : 'treeport'
      await save('complete')
      return {
        schemaVersion: 1,
        operationId,
        status: 'current',
        phase: 'complete',
        fromVersion: installation.version,
        toVersion: release.version,
        installation: { method: 'npm' },
        daemon: {
          wasRunning: initialDaemon.verified,
          lifecycle: currentLifecycle,
          restarted: false,
          healthy: initialDaemon.verified,
          version: initialDaemon.health?.version ?? null
        },
        terminals: {
          before: currentTerminals.length,
          after: currentTerminals.length,
          preserved: true
        },
        rollback: { attempted: false, safe: true, succeeded: false }
      }
    }

    const stagingPath = path.join(
      installation.managedRoot,
      `.staging-${release.version}-${operationId}`
    )
    const targetPath = path.join(
      installation.versionsDirectory,
      release.version
    )
    operation.stagedTarget = stagingPath
    await save('stage')
    progress(`Downloading Treeport ${release.version}…`)
    await fs.rm(stagingPath, { recursive: true, force: true })
    const downloadPath = path.join(
      installation.managedRoot,
      `.download-${operationId}`
    )
    await fs.rm(downloadPath, { recursive: true, force: true })
    await fs.mkdir(downloadPath, { recursive: true, mode: 0o700 })
    const packed = await runCommand(
      'npm',
      [
        'pack',
        `${PACKAGE_NAME}@${release.version}`,
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        downloadPath
      ],
      environment
    )
    const packedRelease = await Promise.resolve(packed.stdout)
      .then((value) =>
        packedReleaseSchema.safeParse(
          packed.code === 0 ? JSON.parse(value) : null
        )
      )
      .catch(() => null)
    if (
      !packedRelease?.success ||
      packedRelease.data[0].integrity !== release.dist.integrity ||
      path.basename(packedRelease.data[0].filename) !==
        packedRelease.data[0].filename
    ) {
      throw new LocalUpdateError(
        'UPDATE_STAGING_FAILED',
        packed.code === 0
          ? 'The downloaded Treeport package did not match npm release integrity.'
          : commandFailure('npm pack', packed),
        { phase: 'stage', operationId, toVersion: release.version }
      )
    }

    const tarballPath = path.join(downloadPath, packedRelease.data[0].filename)
    const install = await runCommand(
      'npm',
      [
        'install',
        '--global',
        '--prefix',
        stagingPath,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarballPath
      ],
      environment
    )
    await fs.rm(downloadPath, { recursive: true, force: true })
    if (install.code !== 0) {
      throw new LocalUpdateError(
        'UPDATE_STAGING_FAILED',
        commandFailure('npm install', install),
        { phase: 'stage', operationId, toVersion: release.version }
      )
    }

    await save('verify')
    const stagedPackage = path.join(
      stagingPath,
      'lib',
      'node_modules',
      '@treeport',
      'treeport'
    )
    const stagedManifest = await fs
      .readFile(path.join(stagedPackage, 'package.json'), 'utf8')
      .then((value) => packageSchema.safeParse(JSON.parse(value)))
      .catch(() => null)
    if (
      !stagedManifest?.success ||
      stagedManifest.data.version !== release.version
    ) {
      throw new LocalUpdateError(
        'UPDATE_VERIFICATION_FAILED',
        'The staged Treeport package does not match the resolved release.',
        { phase: 'verify', operationId, toVersion: release.version }
      )
    }

    await Promise.all(
      [
        'bin/treeport.mjs',
        'dist/node/cli/index.js',
        'dist/node/server/index.js',
        'dist/web/index.html',
        'drizzle/meta/_journal.json',
        'skills/treeport/SKILL.md'
      ].map((item) =>
        fs.access(path.join(stagedPackage, item), fsConstants.R_OK)
      )
    ).catch((error) => {
      throw new LocalUpdateError(
        'UPDATE_VERIFICATION_FAILED',
        `The staged Treeport package is incomplete: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { phase: 'verify', operationId, toVersion: release.version }
      )
    })
    const verificationData = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-update-verify-')
    )
    const stagedVersion = await runCommand(
      process.execPath,
      [
        path.join(stagedPackage, 'dist', 'node', 'cli', 'index.js'),
        'version',
        '--json'
      ],
      {
        ...environment,
        TREEPORT_API_URL: '',
        TREEPORT_DATA_DIR: path.join(verificationData, 'data'),
        TREEPORT_RUNTIME_DIR: path.join(verificationData, 'runtime'),
        TREEPORT_CLI_ENTRYPOINT: path.join(stagingPath, 'bin', 'treeport')
      }
    )
    await fs.rm(verificationData, { recursive: true, force: true })
    const verifiedVersion = await Promise.resolve(stagedVersion.stdout)
      .then((value) =>
        z
          .strictObject({ cli: z.string(), daemon: z.string().nullable() })
          .safeParse(stagedVersion.code === 0 ? JSON.parse(value) : null)
      )
      .catch(() => null)
    if (
      !verifiedVersion?.success ||
      verifiedVersion.data.cli !== release.version
    ) {
      throw new LocalUpdateError(
        'UPDATE_VERIFICATION_FAILED',
        `The staged Treeport CLI did not report version ${release.version}.`,
        { phase: 'verify', operationId, toVersion: release.version }
      )
    }

    const daemonBefore = await daemonStatus()
    if (daemonBefore.state && !daemonBefore.verified) {
      throw new LocalUpdateError(
        'UPDATE_DAEMON_OWNERSHIP_FAILED',
        'Treeport daemon ownership changed while the update was staged.',
        { phase: 'verify', operationId, pid: daemonBefore.state.pid }
      )
    }

    if (
      daemonBefore.running !== initialDaemon.running ||
      daemonBefore.state?.instanceId !== initialDaemon.state?.instanceId
    ) {
      throw new LocalUpdateError(
        'UPDATE_DAEMON_OWNERSHIP_FAILED',
        'Treeport daemon state changed while the update was staged. Retry the update.',
        { phase: 'verify', operationId }
      )
    }

    operation.migrationState =
      recoveryOperation?.migrationState ?? 'not_started'
    operation.daemonWasRunning =
      (daemonBefore.running && daemonBefore.verified) ||
      recoveryOperation !== null
    operation.daemonLifecycle = recoveryOperation
      ? recoveryOperation.daemonLifecycle
      : operation.daemonWasRunning
        ? daemonBefore.health?.daemonLifecycle === 'service'
          ? 'service'
          : 'treeport'
        : installedService
          ? 'service'
          : 'treeport'
    operation.serviceMode =
      recoveryOperation?.serviceMode ?? serviceBefore?.mode ?? null
    operation.terminalIds = recoveryOperation
      ? recoveryOperation.terminalIds
      : operation.daemonWasRunning
        ? await terminalIds(daemonBefore.state!.apiUrl)
        : []

    if (interrupted) {
      throw new LocalUpdateError(
        'UPDATE_INTERRUPTED',
        'Treeport update was interrupted before activation. The installed version and daemon are unchanged.',
        { phase: 'verify', operationId }
      )
    }

    await save('stop')
    progress('Stopping the Treeport daemon and preserving terminals…')
    if (operation.daemonWasRunning) {
      await stopUpdateDaemon(operation.daemonLifecycle)
    }

    await save('activate')
    progress(`Activating Treeport ${release.version}…`)
    await fs.rm(targetPath, { recursive: true, force: true })
    await fs.rename(stagingPath, targetPath)
    operation.stagedTarget = targetPath
    const currentExists = await fs
      .lstat(installation.currentLink)
      .then(() => true)
      .catch(() => false)
    if (!currentExists) {
      await fs.symlink(installation.prefix, installation.currentLink)
    } else if (!installation.managed) {
      await replaceSymlink(installation.currentLink, installation.prefix)
    }

    operation.previousTarget = await fs.realpath(installation.currentLink)
    await save('activate')
    const launcher = `#!/bin/sh\nset -eu\n# TREEPORT_MANAGED_LAUNCHER=1\nexport TREEPORT_INSTALLATION_METHOD=npm\nexport TREEPORT_CLI_ENTRYPOINT=${shellQuote(
      installation.entrypoint
    )}\nexec ${shellQuote(process.execPath)} ${shellQuote(
      path.join(
        installation.currentLink,
        'lib',
        'node_modules',
        '@treeport',
        'treeport',
        'bin',
        'treeport.mjs'
      )
    )} "$@"\n`
    const temporaryLauncher = `${installation.entrypoint}.${process.pid}.${operationId}.tmp`
    await fs.writeFile(temporaryLauncher, launcher, { mode: 0o755 })
    await fs.chmod(temporaryLauncher, 0o755)
    await fs.rename(temporaryLauncher, installation.entrypoint)
    await replaceSymlink(installation.currentLink, targetPath)
    operation.activeTarget = targetPath
    operation.activated = true
    await save('activate')

    let daemonAfter: Awaited<ReturnType<typeof daemonStatus>> | null = null
    let terminalsAfter: string[] = []
    if (operation.daemonWasRunning) {
      await writeJson(path.join(updateDirectory, 'pending-startup.json'), {
        schemaVersion: 1,
        operationId,
        targetVersion: release.version,
        createdAt: new Date().toISOString()
      })
      // Seed only lifecycle evidence, before any new daemon can open the database.
      await writeJson(path.join(updateDirectory, 'startup-report.json'), {
        schemaVersion: 1,
        operationId,
        targetVersion: release.version,
        instanceId: null,
        migrationState: operation.migrationState,
        ready: false,
        error: null,
        logPath: paths.logPath,
        snapshotPaths: recoveryReport?.snapshotPaths ?? [],
        updatedAt: new Date().toISOString()
      } satisfies UpdateStartupReport)
      operation.migrationState =
        operation.migrationState === 'advanced' ? 'advanced' : 'unknown'
      await save('restart')
      progress(
        `Restarting the ${
          operation.daemonLifecycle === 'service'
            ? 'Treeport service'
            : 'Treeport daemon'
        }…`
      )
      await startThroughStableEntrypoint(installation.entrypoint, environment)
      await save('health_check')
      const healthDeadline = Date.now() + 10_000
      let report = await readUpdateStartupReport(paths.dataDir)
      daemonAfter = await daemonStatus()
      while (
        Date.now() < healthDeadline &&
        (!daemonAfter.verified ||
          daemonAfter.health?.version !== release.version ||
          report?.operationId !== operationId ||
          !report.ready)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        daemonAfter = await daemonStatus()
        report = await readUpdateStartupReport(paths.dataDir)
      }
      operation.migrationState = updateMigrationState(operation, report)
      if (
        !daemonAfter.running ||
        !daemonAfter.verified ||
        daemonAfter.health?.version !== release.version ||
        daemonAfter.health.daemonLifecycle !== operation.daemonLifecycle ||
        path.resolve(daemonAfter.state!.dataDir) !== paths.dataDir ||
        report?.operationId !== operationId ||
        !report.ready
      ) {
        throw new LocalUpdateError(
          'UPDATE_HEALTH_VERIFICATION_FAILED',
          `Treeport ${release.version} did not pass startup verification.`,
          { phase: 'health_check', operationId }
        )
      }

      if (operation.daemonLifecycle === 'service') {
        const serviceAfter = await serviceStatus()
        if (
          !serviceAfter.healthy ||
          !serviceAfter.installed ||
          serviceAfter.definitionPath !== serviceBefore?.definitionPath ||
          serviceAfter.mode !== serviceBefore.mode
        ) {
          throw new LocalUpdateError(
            'UPDATE_HEALTH_VERIFICATION_FAILED',
            'The Treeport service did not preserve its enabled configuration.',
            { phase: 'health_check', operationId }
          )
        }
      }

      terminalsAfter = await terminalIds(daemonAfter.state!.apiUrl)
      const missing = operation.terminalIds.filter(
        (terminalId) => !terminalsAfter.includes(terminalId)
      )
      if (missing.length > 0) {
        throw new LocalUpdateError(
          'UPDATE_TERMINAL_VERIFICATION_FAILED',
          'Treeport restarted, but one or more terminal sessions were not recovered.',
          { phase: 'health_check', operationId, terminalIds: missing }
        )
      }
    } else {
      await fs.rm(path.join(updateDirectory, 'pending-startup.json'), {
        force: true
      })
    }

    await save('complete')
    const versionDirectories = await fs
      .readdir(installation.versionsDirectory, { withFileTypes: true })
      .then((entries) =>
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      )
      .catch(() => [])
    const removable = versionDirectories.filter(
      (name) =>
        name !== release.version &&
        path.join(installation!.versionsDirectory, name) !==
          operation.previousTarget
    )
    await Promise.all(
      removable.map((name) =>
        fs.rm(path.join(installation!.versionsDirectory, name), {
          recursive: true,
          force: true
        })
      )
    ).catch(() => undefined)
    return {
      schemaVersion: 1,
      operationId,
      status: 'updated',
      phase: 'complete',
      fromVersion: installation.version,
      toVersion: release.version,
      installation: { method: 'npm' },
      daemon: {
        wasRunning: operation.daemonWasRunning,
        lifecycle: operation.daemonLifecycle,
        restarted: operation.daemonWasRunning,
        healthy: operation.daemonWasRunning
          ? Boolean(daemonAfter?.verified)
          : false,
        version: daemonAfter?.health?.version ?? null
      },
      terminals: {
        before: operation.terminalIds.length,
        after: terminalsAfter.length,
        preserved: operation.terminalIds.every((id) =>
          terminalsAfter.includes(id)
        )
      },
      rollback: { attempted: false, safe: true, succeeded: false }
    }
  } catch (error) {
    const failedPhase = operation.phase
    if (!DESTRUCTIVE_PHASES.has(operation.phase)) {
      if (error instanceof LocalUpdateError) {
        throw error
      }

      const code =
        operation.phase === 'resolve'
          ? 'UPDATE_RELEASE_RESOLUTION_FAILED'
          : operation.phase === 'stage'
            ? 'UPDATE_STAGING_FAILED'
            : operation.phase === 'verify'
              ? 'UPDATE_VERIFICATION_FAILED'
              : 'UPDATE_INSTALLATION_UNSUPPORTED'
      throw new LocalUpdateError(
        code,
        error instanceof Error ? error.message : String(error),
        {
          phase: operation.phase,
          operationId,
          fromVersion: operation.fromVersion,
          toVersion: operation.toVersion
        }
      )
    }

    // Stop service retries before reading evidence or changing the active binary.
    const stopError = operation.daemonWasRunning
      ? await stopUpdateDaemon(operation.daemonLifecycle).then(
          () => null,
          (cause: unknown) =>
            cause instanceof Error ? cause.message : String(cause)
        )
      : null
    const observedReport = await readUpdateStartupReport(paths.dataDir)
    const startupReport =
      observedReport?.operationId === operationId &&
      observedReport.targetVersion === operation.toVersion
        ? observedReport
        : null
    operation.migrationState = updateMigrationState(operation, startupReport)

    const rollbackSafe =
      !stopError &&
      ['not_started', 'unchanged'].includes(operation.migrationState)
    if (!rollbackSafe) {
      operation.recoveryAction = stopError
        ? `Keep the new version installed. Stop the daemon, then inspect the daemon log. Stop failed: ${stopError}`
        : 'Keep the new version installed. Inspect the daemon log and repair with the same or a newer Treeport release.'
      await save('recovery_required')
      throw new LocalUpdateError(
        'UPDATE_RECOVERY_REQUIRED',
        'Treeport could not prove that rollback is safe. Treeport did not start the older daemon.',
        {
          operationId,
          phase: failedPhase,
          fromVersion: operation.fromVersion,
          toVersion: operation.toVersion,
          migrationState: operation.migrationState,
          rollback: { attempted: false, safe: false, succeeded: false },
          cause:
            startupReport?.error ??
            (error instanceof Error ? error.message : String(error)),
          logPath: startupReport?.logPath ?? paths.logPath,
          snapshotPaths: startupReport?.snapshotPaths ?? [],
          recovery: operation.recoveryAction
        }
      )
    }

    operation.rollbackAttempted = true
    await save('rollback')
    if (!installation) {
      throw error
    }

    const rollbackError = await (async () => {
      if (operation.previousTarget) {
        await replaceSymlink(installation.currentLink, operation.previousTarget)
      }

      await fs.rm(path.join(updateDirectory, 'pending-startup.json'), {
        force: true
      })
      if (operation.daemonWasRunning) {
        await startThroughStableEntrypoint(installation.entrypoint, environment)
      }
    })().then(
      () => null,
      (cause) => cause
    )
    operation.rollbackSucceeded = rollbackError === null
    operation.recoveryAction = rollbackError
      ? 'Inspect the active version and daemon log before starting Treeport.'
      : 'The previous Treeport version is active again.'
    await save(rollbackError ? 'recovery_required' : 'rollback')
    throw new LocalUpdateError(
      rollbackError ? 'UPDATE_ROLLBACK_FAILED' : 'UPDATE_ROLLED_BACK',
      rollbackError
        ? 'The update failed and Treeport could not restore the previous running state.'
        : 'The update failed. Treeport restored the previous version.',
      {
        operationId,
        phase: failedPhase,
        fromVersion: operation.fromVersion,
        toVersion: operation.toVersion,
        migrationState: operation.migrationState,
        rollback: {
          attempted: true,
          safe: true,
          succeeded: rollbackError === null
        },
        cause: error instanceof Error ? error.message : String(error),
        logPath: startupReport?.logPath ?? paths.logPath,
        snapshotPaths: startupReport?.snapshotPaths ?? [],
        recovery: operation.recoveryAction
      }
    )
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    if (installation) {
      await fs
        .rm(path.join(installation.managedRoot, `.download-${operationId}`), {
          recursive: true,
          force: true
        })
        .catch(() => undefined)
    }

    if (
      !operation.activated &&
      operation.stagedTarget &&
      ['stage', 'verify'].includes(operation.phase)
    ) {
      await fs
        .rm(operation.stagedTarget, { recursive: true, force: true })
        .catch(() => undefined)
    }

    await fs.rm(lockPath, { force: true }).catch(() => undefined)
  }
}
