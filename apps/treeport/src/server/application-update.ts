import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import * as Schedule from 'effect/Schedule'
import { z } from 'zod'
import {
  compareTreeportVersions,
  inspectLocalUpdateInstallation,
  isCanonicalTreeportVersion,
  readLocalUpdateProgress,
  resolveLatestTreeportRelease,
  type LocalUpdateInstallation,
  type LocalUpdatePhase,
  type LocalUpdateProgress,
  type TreeportRelease
} from '../cli/update.js'
import { serviceStatus, type ServiceStatus } from '../cli/service.js'
import { DomainError } from './core/index.js'
import type { AppConfig } from './core/index.js'

const POLL_INTERVAL_MS = 10 * 60_000
const POLL_JITTER_MS = 60_000
const updateResultSchema = z.looseObject({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  status: z.enum(['current', 'updated']),
  phase: z.literal('complete'),
  fromVersion: z.string(),
  toVersion: z.string()
})
const updateErrorSchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    details: z
      .looseObject({
        operationId: z.string().optional(),
        recovery: z.string().optional()
      })
      .optional()
  })
})

type ApplicationUpdatePhase =
  | 'idle'
  | 'checking'
  | 'starting'
  | LocalUpdatePhase
  | 'failed'

export interface ApplicationUpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  checkedAt: string | null
  canUpdate: boolean
  blockedReason: string | null
  phase: ApplicationUpdatePhase
  operationId: string | null
  targetVersion: string | null
  error: string | null
}

export interface ApplicationUpdateManager {
  status(): Promise<ApplicationUpdateStatus>
  check(): Promise<void>
  readonly polling: Effect.Effect<void>
  start(): Promise<ApplicationUpdateStatus>
  dispose(): void
}

interface ApplicationUpdateDependencies {
  environment?: NodeJS.ProcessEnv
  resolveRelease?: (environment: NodeJS.ProcessEnv) => Promise<TreeportRelease>
  inspectInstallation?: (
    environment: NodeJS.ProcessEnv
  ) => Promise<LocalUpdateInstallation>
  readProgress?: (dataDir: string) => Promise<LocalUpdateProgress>
  readServiceStatus?: () => Promise<ServiceStatus>
  spawnProcess?: typeof spawn
  random?: () => number
  pollIntervalMs?: number
  pollJitterMs?: number
}

async function readValidatedJson<Schema extends z.ZodType>(
  filePath: string,
  schema: Schema
): Promise<z.infer<Schema> | null> {
  return fs
    .readFile(filePath, 'utf8')
    .then((value) => schema.safeParse(JSON.parse(value)))
    .then((result) => (result.success ? result.data : null))
    .catch(() => null)
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false)
}

export function createApplicationUpdateManager(
  config: AppConfig,
  dependencies: ApplicationUpdateDependencies = {}
): ApplicationUpdateManager {
  const environment = dependencies.environment ?? process.env
  const resolveRelease =
    dependencies.resolveRelease ?? resolveLatestTreeportRelease
  const inspectInstallation =
    dependencies.inspectInstallation ?? inspectLocalUpdateInstallation
  const readProgress = dependencies.readProgress ?? readLocalUpdateProgress
  const readServiceStatus = dependencies.readServiceStatus ?? serviceStatus
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const random = dependencies.random ?? Math.random
  const pollIntervalMs = dependencies.pollIntervalMs ?? POLL_INTERVAL_MS
  const pollJitterMs = dependencies.pollJitterMs ?? POLL_JITTER_MS
  const updateDirectory = path.join(config.dataDir, 'updates')
  const resultPath = path.join(updateDirectory, 'web-update-result.json')
  const errorPath = path.join(updateDirectory, 'web-update-error.json')
  const currentVersion = config.appVersion ?? 'development'
  const staticBlockedReason =
    config.installationMethod !== 'npm'
      ? 'This Treeport installation cannot update itself. Update it with its installation method.'
      : config.daemonLifecycle === 'external'
        ? 'This Treeport daemon is managed by another process. Update it on the host.'
        : !isCanonicalTreeportVersion(currentVersion)
          ? 'Development and prerelease Treeport versions do not update from the stable npm channel.'
          : null

  let latestVersion: string | null = null
  let checkedAt: string | null = null
  let capabilityChecked = staticBlockedReason !== null
  let canUpdate = false
  let blockedReason = staticBlockedReason
  let installation: LocalUpdateInstallation | null = null
  let checking = false
  let checkPromise: Promise<void> | null = null
  let disposed = false
  let launching = false
  let launchError: string | null = null

  const refreshCapability = async (): Promise<void> => {
    if (staticBlockedReason) {
      capabilityChecked = true
      canUpdate = false
      blockedReason = staticBlockedReason
      installation = null
      return
    }

    const [installationResult, serviceResult] = await Promise.all([
      inspectInstallation(environment).then(
        (value) => ({ value, error: null }),
        (cause: unknown) => ({ value: null, error: cause })
      ),
      config.daemonLifecycle === 'service'
        ? readServiceStatus().then(
            (value) => ({ value, error: null }),
            (cause: unknown) => ({ value: null, error: cause })
          )
        : Promise.resolve({ value: null, error: null })
    ])

    capabilityChecked = true
    installation = installationResult.value
    if (!installation) {
      canUpdate = false
      blockedReason =
        installationResult.error instanceof Error
          ? installationResult.error.message
          : 'Treeport could not verify this npm installation.'
      return
    }

    if (serviceResult.error) {
      canUpdate = false
      blockedReason = 'Treeport could not verify the service update lifecycle.'
      return
    }

    if (
      serviceResult.value?.mode === 'headless' &&
      (serviceResult.value.active || serviceResult.value.daemon?.running)
    ) {
      canUpdate = false
      blockedReason =
        'Stop the advanced headless service with its administrator action before you update Treeport.'
      return
    }

    canUpdate = true
    blockedReason = null
  }

  const status = async (): Promise<ApplicationUpdateStatus> => {
    const [progress, result, updateError, resultFileExists, errorFileExists] =
      await Promise.all([
        readProgress(config.dataDir),
        readValidatedJson(resultPath, updateResultSchema),
        readValidatedJson(errorPath, updateErrorSchema),
        fileExists(resultPath),
        fileExists(errorPath)
      ])
    if (progress.active) {
      launching = false
    }

    const resultMatchesOperation =
      !result ||
      !progress.operationId ||
      result.operationId === progress.operationId
    const errorOperationId = updateError?.error.details?.operationId ?? null
    const errorMatchesOperation =
      !updateError ||
      !errorOperationId ||
      !progress.operationId ||
      errorOperationId === progress.operationId
    const available = Boolean(
      latestVersion &&
      isCanonicalTreeportVersion(currentVersion) &&
      compareTreeportVersions(latestVersion, currentVersion) > 0
    )
    const recoveryError = progress.recoveryAction
    const cliError = errorMatchesOperation ? updateError?.error : null
    const interrupted = Boolean(
      !progress.active &&
      progress.phase &&
      progress.phase !== 'complete' &&
      (resultFileExists || errorFileExists) &&
      !result &&
      !updateError
    )
    const error =
      launchError ??
      (cliError
        ? [cliError.message, cliError.details?.recovery]
            .filter((value, index, values) =>
              Boolean(value && values.indexOf(value) === index)
            )
            .join(' ')
        : recoveryError) ??
      (interrupted
        ? 'The update process stopped before it returned a result. Retry the update or run `treeport update` on the host.'
        : null)
    const inactiveFailedPhase =
      interrupted ||
      progress.phase === 'rollback' ||
      progress.phase === 'recovery_required'
    const phase: ApplicationUpdatePhase = progress.active
      ? (progress.phase ?? 'starting')
      : launching
        ? 'starting'
        : launchError || cliError || inactiveFailedPhase
          ? progress.phase === 'recovery_required'
            ? 'recovery_required'
            : 'failed'
          : result && resultMatchesOperation
            ? 'complete'
            : progress.phase === 'complete'
              ? 'complete'
              : checking
                ? 'checking'
                : 'idle'

    return {
      currentVersion,
      latestVersion,
      updateAvailable: available,
      checkedAt,
      canUpdate: canUpdate && !progress.active && !launching,
      blockedReason: capabilityChecked
        ? blockedReason
        : 'Treeport is checking whether this installation can update itself.',
      phase,
      operationId: progress.operationId ?? result?.operationId ?? null,
      targetVersion:
        progress.toVersion ?? result?.toVersion ?? latestVersion ?? null,
      error: error || null
    }
  }

  const check = async (): Promise<void> => {
    if (staticBlockedReason || disposed) {
      return
    }

    const progress = await readProgress(config.dataDir)
    if (progress.active) {
      return
    }

    if (checkPromise) {
      return checkPromise
    }

    checking = true
    checkPromise = Promise.all([
      resolveRelease(environment).then(
        (value) => ({ value, error: null }),
        (cause: unknown) => ({ value: null, error: cause })
      ),
      refreshCapability()
    ]).then(([releaseResult]) => {
      if (releaseResult.value) {
        latestVersion = releaseResult.value.version
        checkedAt = new Date().toISOString()
      } else {
        console.warn(
          '[Treeport] Application update check failed:',
          releaseResult.error instanceof Error
            ? releaseResult.error.message
            : String(releaseResult.error)
        )
      }
    })
    await checkPromise.finally(() => {
      checking = false
      checkPromise = null
    })
  }

  const polling = staticBlockedReason
    ? Effect.void
    : Effect.tryPromise({
        try: check,
        catch: (cause) => cause
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.sync(() =>
            console.warn(
              '[Treeport] Application update polling failed:',
              cause instanceof Error ? cause.message : String(cause)
            )
          )
        ),
        Effect.repeat(
          Schedule.spaced(pollIntervalMs).pipe(
            Schedule.addDelay(() => Math.floor(random() * pollJitterMs)),
            Schedule.whileInput(() => !disposed)
          )
        ),
        Effect.asVoid
      )

  return {
    status,
    check,
    polling,
    async start() {
      const currentStatus = await status()
      if (!currentStatus.updateAvailable) {
        throw new DomainError(
          'APPLICATION_UPDATE_NOT_AVAILABLE',
          'A newer stable Treeport release is not available.',
          409
        )
      }

      if (
        launching ||
        [
          'starting',
          'inspect',
          'resolve',
          'stage',
          'verify',
          'stop',
          'activate',
          'restart',
          'health_check',
          'rollback'
        ].includes(currentStatus.phase)
      ) {
        throw new DomainError(
          'APPLICATION_UPDATE_IN_PROGRESS',
          'Another Treeport update is already running.',
          409
        )
      }

      launching = true
      launchError = null
      const launchResult = await (async () => {
        await refreshCapability()
        if (!canUpdate || !installation) {
          throw new DomainError(
            'APPLICATION_UPDATE_BLOCKED',
            blockedReason ?? 'This Treeport installation cannot update itself.',
            409
          )
        }

        const entrypoint = installation.entrypoint

        await fs.mkdir(updateDirectory, { recursive: true, mode: 0o700 })
        await Promise.all([
          fs.rm(resultPath, { force: true }),
          fs.rm(errorPath, { force: true })
        ])
        const [resultFile, errorFile] = await Promise.all([
          fs.open(resultPath, 'wx', 0o600),
          fs.open(errorPath, 'wx', 0o600)
        ])
        const spawned = new Promise<ChildProcess>((resolve, reject) => {
          const child = spawnProcess(entrypoint, ['update', '--json'], {
            env: environment,
            detached: true,
            shell: false,
            stdio: ['ignore', resultFile.fd, errorFile.fd]
          })
          child.once('spawn', () => resolve(child))
          child.once('error', reject)
          child.once('exit', () => {
            launching = false
          })
        })
        const spawnResult = await spawned.then(
          (child) => ({ child, error: null }),
          (cause: unknown) => ({ child: null, error: cause })
        )
        await Promise.all([resultFile.close(), errorFile.close()])
        if (!spawnResult.child) {
          throw spawnResult.error instanceof Error
            ? spawnResult.error
            : new Error('Treeport could not start the update process.')
        }

        spawnResult.child.unref()
      })().then(
        () => ({ error: null }),
        (cause: unknown) => ({ error: cause })
      )
      if (launchResult.error) {
        launching = false
        if (launchResult.error instanceof DomainError) {
          throw launchResult.error
        }

        launchError =
          launchResult.error instanceof Error
            ? launchResult.error.message
            : 'Treeport could not start the update process.'
        throw new DomainError(
          'APPLICATION_UPDATE_START_FAILED',
          'Treeport could not start the update process.',
          500
        )
      }

      return status()
    },
    dispose() {
      disposed = true
    }
  }
}
