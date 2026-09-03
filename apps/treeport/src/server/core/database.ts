import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/libsql'
import type { LibSQLDatabase } from 'drizzle-orm/libsql/driver'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { z } from 'zod'
import { treeContextValuesSchema } from '@treeport/shared'
import type {
  CreateOperationRequest,
  CreateOperationResult,
  ExternalRemoveOperationResult,
  OperationRecord,
  RemoveOperationRequest,
  RemoveOperationResult,
  PrInfo,
  ProjectRecord,
  TerminalPreset,
  WorktreeRecord
} from '@treeport/shared'
import * as schema from './database-schema'
import type {
  operations,
  projects as projectTable,
  terminalPresets,
  worktrees
} from './database-schema'
import { inferWorktreeName } from './zed'

const LEGACY_LATEST_VERSION = 10
const BACKUP_RETENTION = 2

const createOperationRequestSchema: z.ZodType<CreateOperationRequest> =
  z.strictObject({
    name: z.string(),
    base: z.enum(['default', 'current']),
    context: treeContextValuesSchema.optional(),
    initialTerminal: z
      .strictObject({
        name: z.string(),
        initialTitle: z.string().optional(),
        argv: z.array(z.string()).optional(),
        returnToShell: z.boolean().optional(),
        initialSize: z
          .strictObject({ cols: z.number().int(), rows: z.number().int() })
          .optional()
      })
      .optional(),
    sourceWorktreeId: z.string().optional()
  })

const createOperationResultSchema: z.ZodType<CreateOperationResult> =
  z.strictObject({
    worktreeId: z.string(),
    terminalId: z.string().nullable(),
    terminalError: z.string().nullable(),
    setupError: z.string().nullable()
  })

const cleanupCommandProgressSchema = z.strictObject({
  name: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  outputTruncated: z.boolean()
})

const emptyCleanupProgress = () => ({
  status: 'pending' as const,
  definitionHash: null,
  skippedReason: null,
  commands: []
})

const removeCleanupProgressSchema = z.strictObject({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
  definitionHash: z.string().nullable(),
  skippedReason: z.string().nullable(),
  commands: z.array(cleanupCommandProgressSchema)
})

const removePreviewSchema = z.strictObject({
  worktreeId: z.string(),
  name: z.string(),
  path: z.string(),
  head: z.string(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().nullable(),
  dirty: z.strictObject({
    dirty: z.boolean(),
    staged: z.number().int(),
    unstaged: z.number().int(),
    untracked: z.number().int(),
    conflicts: z.number().int(),
    total: z.number().int()
  }),
  detachedHeadReachable: z.boolean().nullable(),
  forceRequired: z.boolean(),
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  cleanup: z
    .strictObject({
      commands: z.array(z.string()),
      available: z.boolean(),
      unavailableReason: z.string().nullable()
    })
    .default({ commands: [], available: true, unavailableReason: null }),
  terminals: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      status: z.enum(['running', 'exited', 'missing'])
    })
  ),
  confirmationToken: z.string()
})

const removeOperationRequestSchema: z.ZodType<RemoveOperationRequest> = z.union(
  [
    z
      .strictObject({
        confirmation: z.null().default(null),
        confirmationToken: z.string(),
        confirmDestructive: z.boolean(),
        preview: removePreviewSchema,
        checkoutIdentity: z
          .strictObject({
            path: z.string(),
            device: z.string(),
            inode: z.string(),
            gitWorktreeKey: z.string(),
            gitMarker: z.string(),
            repositoryIdentity: z.string().nullable(),
            managedWrapperPath: z.string().nullable(),
            quarantinePath: z.string()
          })
          .nullable(),
        prunable: z.boolean(),
        gitWorktreeKey: z.string(),
        repositoryIdentity: z.string().nullable(),
        phase: z
          .enum([
            'accepted',
            'terminals_stopped',
            'cleanup_commands_completed',
            'git_removed',
            'cleanup_pending'
          ])
          .default('accepted'),
        managedWrapperPath: z.string().nullable().default(null),
        cleanupCommands: removeCleanupProgressSchema.default(
          emptyCleanupProgress()
        )
      })
      .transform((request) => request satisfies RemoveOperationRequest),
    z.strictObject({ confirmation: z.boolean() }).transform(
      ({ confirmation }): RemoveOperationRequest => ({
        confirmation,
        confirmationToken: null,
        confirmDestructive: null,
        preview: null,
        checkoutIdentity: null,
        prunable: null,
        gitWorktreeKey: null,
        repositoryIdentity: null,
        phase: null,
        managedWrapperPath: null,
        cleanupCommands: emptyCleanupProgress()
      })
    )
  ]
)

const removeOperationResultSchema: z.ZodType<RemoveOperationResult> =
  z.strictObject({
    removed: z.literal(true),
    worktreeId: z.string(),
    name: z.string(),
    branchPreserved: z.string().nullable(),
    path: z.string(),
    recovered: z.boolean(),
    cleanup: z.strictObject({
      status: z.enum(['completed', 'preserved']),
      residualPath: z.string().nullable(),
      warning: z.string().nullable(),
      commands: z.array(cleanupCommandProgressSchema).default([])
    })
  })

const externalRemoveOperationResultSchema: z.ZodType<ExternalRemoveOperationResult> =
  z.strictObject({
    removed: z.literal(true),
    external: z.literal(true),
    worktreeId: z.string(),
    path: z.string(),
    head: z.string(),
    branch: z.string().nullable(),
    cleanup: z
      .strictObject({
        status: z.literal('skipped'),
        skippedReason: z.string()
      })
      .default({
        status: 'skipped',
        skippedReason: 'Git removed the tree outside Treeport'
      })
  })

type TreeportOrm = LibSQLDatabase<typeof schema>
export type ProjectRow = typeof projectTable.$inferSelect
export type WorktreeRow = typeof worktrees.$inferSelect
export type TerminalPresetRow = typeof terminalPresets.$inferSelect
export type OperationRow = typeof operations.$inferSelect

export interface DatabaseOpenOptions {
  migrationsFolder?: string
  backupDirectory?: string
}

export function serializeOperation<Value extends object>(
  value: Value | null
): string | null {
  return value === null ? null : JSON.stringify(value)
}

function deserializeOperation<Value extends object>(
  value: string | null,
  schema: z.ZodType<Value>
): Value | null {
  if (value === null) {
    return null
  }

  return schema.parse(JSON.parse(value))
}

export interface TreeportDatabase {
  readonly filePath: string
  readonly db: TreeportOrm
  readonly migrationState: 'unchanged' | 'advanced'
  readonly migrationSnapshotPaths: string[]
  close(): void
}

export async function openDatabase(
  filePath: string,
  options: DatabaseOpenOptions = {}
): Promise<TreeportDatabase> {
  const absoluteFilePath = path.resolve(filePath)
  const packagedMigrations = fileURLToPath(
    new URL('../../../drizzle', import.meta.url)
  )
  const migrationsFolder = options.migrationsFolder ?? packagedMigrations
  const migrations = readMigrationFiles({ migrationsFolder })
  const latestMigration = migrations.at(-1)
  if (!latestMigration) {
    throw new Error(
      `Treeport has no database migrations in ${migrationsFolder}`
    )
  }

  const databaseExists = fs.existsSync(absoluteFilePath)
  let hasDurableSchema = false
  let hasLegacyMigrations = false
  let migrationsPending = !databaseExists
  const migrationSnapshotPaths: string[] = []
  let drizzleRows: Array<{ hash: string; createdAt: number | null }> = []

  if (!databaseExists) {
    await fs.promises.mkdir(path.dirname(absoluteFilePath), {
      recursive: true,
      mode: 0o700
    })
  }

  const client = createClient({
    url: pathToFileURL(absoluteFilePath).href,
    intMode: 'number',
    timeout: 5_000
  })
  const db = drizzle(client, { schema })

  try {
    if (databaseExists) {
      const tableNameRows = await db.all<{ name: string }>(sql`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        `)
      const tableNames = tableNameRows.map((row) => row.name)
      hasDurableSchema = tableNames.some(
        (name) =>
          name !== '__drizzle_migrations' && name !== 'schema_migrations'
      )
      hasLegacyMigrations = tableNames.includes('schema_migrations')

      if (hasLegacyMigrations) {
        const legacyRows = await db.all<{ version: number }>(sql`
            SELECT version FROM schema_migrations ORDER BY version
          `)
        const legacyVersions = legacyRows.map((row) => row.version)
        const newestLegacyVersion = legacyVersions.at(-1) ?? 0

        if (newestLegacyVersion > LEGACY_LATEST_VERSION) {
          throw new Error(
            `Treeport database schema version ${newestLegacyVersion} is newer than this binary supports (${LEGACY_LATEST_VERSION}). Upgrade Treeport before opening ${absoluteFilePath}.`
          )
        }

        if (!legacyVersions.includes(7)) {
          throw new Error(
            `Treeport cannot safely adopt the legacy database at ${absoluteFilePath}: schema migration 7 is missing.`
          )
        }

        const missingTables = ['projects', 'worktrees', 'operations'].filter(
          (table) => !tableNames.includes(table)
        )
        if (missingTables.length > 0) {
          throw new Error(
            `Treeport cannot safely adopt the legacy database at ${absoluteFilePath}: missing ${missingTables.join(
              ', '
            )}.`
          )
        }
      }

      if (tableNames.includes('__drizzle_migrations')) {
        drizzleRows = await db.all<{
          hash: string
          createdAt: number | null
        }>(sql`
            SELECT hash, created_at AS createdAt
            FROM __drizzle_migrations
            ORDER BY created_at
          `)
      }

      for (const row of drizzleRows) {
        const createdAt = Number(row.createdAt)

        if (createdAt > latestMigration.folderMillis) {
          throw new Error(
            `Treeport database schema ${createdAt} is newer than this binary supports (${latestMigration.folderMillis}). Upgrade Treeport before opening ${absoluteFilePath}.`
          )
        }

        const knownMigration = migrations.find(
          (migration) => migration.folderMillis === createdAt
        )
        if (!knownMigration || knownMigration.hash !== row.hash) {
          throw new Error(
            `Treeport database at ${absoluteFilePath} has an unrecognized migration history. Use a compatible Treeport version or restore a pre-migration snapshot.`
          )
        }
      }

      if (
        hasDurableSchema &&
        !hasLegacyMigrations &&
        drizzleRows.length === 0
      ) {
        throw new Error(
          `Treeport database at ${absoluteFilePath} has no recognized migration history; refusing to modify it.`
        )
      }

      migrationsPending =
        drizzleRows.length === 0 ||
        Number(drizzleRows.at(-1)?.createdAt) < latestMigration.folderMillis
      if (migrationsPending && hasDurableSchema) {
        const backupDirectory = path.resolve(
          options.backupDirectory ??
            path.join(path.dirname(absoluteFilePath), 'database-backups')
        )
        await fs.promises.mkdir(backupDirectory, {
          recursive: true,
          mode: 0o700
        })
        await fs.promises.chmod(backupDirectory, 0o700)
        const timestamp = new Date().toISOString().replaceAll(':', '-')
        const prefix = `${path.basename(absoluteFilePath)}.pre-migration-`
        const backupPath = path.join(
          backupDirectory,
          `${prefix}${timestamp}-${process.pid}-${crypto
            .randomBytes(4)
            .toString('hex')}.db`
        )
        try {
          await db.run(
            sql.raw(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`)
          )
          await fs.promises.chmod(backupPath, 0o600)
          migrationSnapshotPaths.push(backupPath)
        } catch (error) {
          await fs.promises.rm(backupPath, { force: true })
          throw error
        }
        const backups = (await fs.promises.readdir(backupDirectory))
          .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
          .sort()
        await Promise.all(
          backups
            .slice(0, Math.max(0, backups.length - BACKUP_RETENTION))
            .map((name) =>
              fs.promises.rm(path.join(backupDirectory, name), {
                force: true
              })
            )
        )
      }
    }

    await fs.promises.chmod(absoluteFilePath, 0o600)
    await db.run(sql`PRAGMA journal_mode = WAL`)
    // SQLite cannot rebuild a referenced table while foreign-key actions are
    // active. Generated migrations use table replacement for column removal,
    // so disable enforcement outside the migration transaction and validate
    // every reference before enabling it again.
    await db.run(
      migrationsPending
        ? sql`PRAGMA foreign_keys = OFF`
        : sql`PRAGMA foreign_keys = ON`
    )

    if (hasLegacyMigrations) {
      const [presetTable] = await db.all<{ found: number }>(sql`
          SELECT 1 AS found FROM sqlite_master
          WHERE type = 'table' AND name = 'terminal_presets'
        `)
      if (presetTable) {
        const columns = await db.all<{ name: string }>(
          sql`PRAGMA table_info(terminal_presets)`
        )
        if (!columns.some((column) => column.name === 'close_on_success')) {
          await db.transaction(async (tx) => {
            await tx.run(sql`
                ALTER TABLE terminal_presets
                ADD COLUMN close_on_success INTEGER NOT NULL DEFAULT 0
                CHECK(close_on_success IN (0,1))
              `)
          })
        }
      }
    }

    await migrate(db, { migrationsFolder })
    if (migrationsPending) {
      const foreignKeyViolations = await db.all<{
        table: string
        rowid: number
        parent: string
        fkid: number
      }>(sql`PRAGMA foreign_key_check`)
      if (foreignKeyViolations.length > 0) {
        throw new Error(
          `Treeport database migration introduced ${foreignKeyViolations.length} foreign-key violation(s)`
        )
      }

      await db.run(sql`PRAGMA foreign_keys = ON`)
    }

    if (hasLegacyMigrations) {
      await db.transaction(async (tx) => {
        await tx.run(sql`DROP TABLE schema_migrations`)
      })
    }

    return {
      filePath: absoluteFilePath,
      db,
      migrationState: migrationsPending ? 'advanced' : 'unchanged',
      migrationSnapshotPaths,
      close: () => client.close()
    }
  } catch (error) {
    client.close()
    throw error
  }
}

export function mapProject(
  row: ProjectRow,
  worktreeRows: WorktreeRow[]
): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    // SAFETY: The database check constrains this value.
    kind: row.kind as ProjectRecord['kind'],
    rootPath: row.repositoryPath,
    repositoryPath: row.repositoryPath,
    mainWorktreePath: row.mainWorktreePath,
    defaultBranch: row.defaultBranch,
    // SAFETY: The query selects the columns required by this database row contract.
    color: row.color as ProjectRecord['color'],
    availability: { state: 'available', message: null },
    worktrees: worktreeRows.map((worktree) =>
      mapWorktree(worktree, row.mainWorktreePath)
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function mapWorktree(
  row: WorktreeRow,
  mainWorktreePath: string
): WorktreeRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    name: inferWorktreeName(
      mainWorktreePath,
      row.path,
      // SAFETY: The query selects the columns required by this database row contract.
      row.kind as WorktreeRecord['kind']
    ),
    path: row.path,
    head: row.kind === 'folder' ? '' : row.head,
    branch: row.branch,
    detached: Boolean(row.detached),
    locked: Boolean(row.locked),
    lockReason: row.lockReason,
    prunable: Boolean(row.prunable),
    // SAFETY: The query selects the columns required by this database row contract.
    kind: row.kind as WorktreeRecord['kind'],
    managedWrapperPath: row.managedWrapperPath,
    pr: {
      // SAFETY: The query selects the columns required by this database row contract.
      state: row.prState as PrInfo['state'],
      number: row.prNumber,
      url: row.prUrl,
      baseBranch: row.prBaseBranch,
      headBranch: row.prHeadBranch,
      mergedAt: row.prMergedAt,
      refreshedAt: row.prRefreshedAt
    },
    dirty: null,
    terminals: [],
    panels: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function mapTerminalPreset(row: TerminalPresetRow): TerminalPreset {
  return {
    id: row.id,
    name: row.name,
    executable: row.executable,
    // SAFETY: The query selects the columns required by this database row contract.
    args: JSON.parse(row.argsJson) as string[],
    closeOnSuccess: Boolean(row.closeOnSuccess),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function mapOperation(row: OperationRow): OperationRecord {
  const common = {
    id: row.id,
    projectId: row.projectId,
    worktreeId: row.worktreeId,
    status: z
      .enum(['pending', 'running', 'completed', 'failed'])
      .parse(row.status),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }

  if (row.kind === 'create') {
    return {
      ...common,
      kind: row.kind,
      request: createOperationRequestSchema.parse(JSON.parse(row.requestJson)),
      result: deserializeOperation(row.resultJson, createOperationResultSchema)
    }
  }

  if (row.kind === 'remove') {
    return {
      ...common,
      kind: row.kind,
      request: removeOperationRequestSchema.parse(JSON.parse(row.requestJson)),
      result: deserializeOperation(row.resultJson, removeOperationResultSchema)
    }
  }

  if (row.kind === 'external_remove') {
    return {
      ...common,
      kind: row.kind,
      request: z
        .strictObject({ source: z.literal('git') })
        .parse(JSON.parse(row.requestJson)),
      result: deserializeOperation(
        row.resultJson,
        externalRemoveOperationResultSchema
      )
    }
  }

  const legacyKind = z
    .enum(['finish', 'discard', 'project_cleanup'])
    .parse(row.kind)
  return {
    ...common,
    kind: legacyKind,
    request: z.looseObject({}).parse(JSON.parse(row.requestJson)),
    result: deserializeOperation(row.resultJson, z.looseObject({}))
  }
}
