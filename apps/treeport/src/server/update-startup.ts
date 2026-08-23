import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { AppConfig } from './core/config.js'

export type UpdateMigrationState =
  | 'not_started'
  | 'unchanged'
  | 'advanced'
  | 'unknown'

export interface UpdateStartupReport {
  schemaVersion: 1
  operationId: string
  targetVersion: string
  instanceId: string | null
  migrationState: UpdateMigrationState
  ready: boolean
  error: string | null
  logPath: string
  snapshotPaths: string[]
  updatedAt: string
}

const pendingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  targetVersion: z.string(),
  createdAt: z.string()
})

interface UpdatePaths {
  pending: string
  report: string
}

interface UpdateStartupReporter {
  databaseOpening(): Promise<void>
  databaseOpened(input: {
    migrationState: 'unchanged' | 'advanced'
    snapshotPaths: string[]
  }): Promise<void>
  ready(): Promise<void>
  failed(error: Error): Promise<void>
}

function updatePaths(dataDir: string): UpdatePaths {
  const directory = path.join(dataDir, 'updates')
  return {
    pending: path.join(directory, 'pending-startup.json'),
    report: path.join(directory, 'startup-report.json')
  }
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

export async function createUpdateStartupReporter(
  config: AppConfig
): Promise<UpdateStartupReporter> {
  const paths = updatePaths(config.dataDir)
  const pending = await fs
    .readFile(paths.pending, 'utf8')
    .then((value) => pendingSchema.safeParse(JSON.parse(value)))
    .then((result) => (result.success ? result.data : null))
    .catch(() => null)
  const active =
    pending && pending.targetVersion === config.appVersion ? pending : null
  const report: UpdateStartupReport | null = active
    ? {
        schemaVersion: 1,
        operationId: active.operationId,
        targetVersion: active.targetVersion,
        instanceId: config.instanceId ?? null,
        migrationState: 'not_started',
        ready: false,
        error: null,
        logPath: path.join(config.dataDir, 'logs', 'daemon.log'),
        snapshotPaths: [],
        updatedAt: new Date().toISOString()
      }
    : null

  const save = async () => {
    if (!report) {
      return
    }

    report.updatedAt = new Date().toISOString()
    await writeJson(paths.report, report)
  }
  await save()

  return {
    async databaseOpening() {
      if (report) {
        report.migrationState = 'unknown'
        await save()
      }
    },
    async databaseOpened(input) {
      if (report) {
        report.migrationState = input.migrationState
        report.snapshotPaths = input.snapshotPaths
        await save()
      }
    },
    async ready() {
      if (report) {
        report.ready = true
        report.error = null
        await save()
        await fs.rm(paths.pending, { force: true })
      }
    },
    async failed(error) {
      if (report) {
        report.error = error.message
        await save()
      }
    }
  }
}

export async function readUpdateStartupReport(
  dataDir: string
): Promise<UpdateStartupReport | null> {
  const schema: z.ZodType<UpdateStartupReport> = z.strictObject({
    schemaVersion: z.literal(1),
    operationId: z.string().uuid(),
    targetVersion: z.string(),
    instanceId: z.string().nullable(),
    migrationState: z.enum(['not_started', 'unchanged', 'advanced', 'unknown']),
    ready: z.boolean(),
    error: z.string().nullable(),
    logPath: z.string(),
    snapshotPaths: z.array(z.string()),
    updatedAt: z.string()
  })
  return fs
    .readFile(updatePaths(dataDir).report, 'utf8')
    .then((value) => schema.safeParse(JSON.parse(value)))
    .then((result) => (result.success ? result.data : null))
    .catch(() => null)
}
