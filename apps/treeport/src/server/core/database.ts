import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient, type Client } from '@libsql/client'
import { and, asc, desc, eq, ne, or, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/libsql'
import type { LibSQLDatabase } from 'drizzle-orm/libsql/driver'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { z } from 'zod'
import type {
  CreateOperationRequest,
  CreateOperationResult,
  ExternalRemoveOperationResult,
  OperationRecord,
  RemoveOperationRequest,
  RemoveOperationResult,
  PrInfo,
  ProjectRecord,
  RecentProjectRecord,
  TerminalPreset,
  WebPanel,
  WorktreeRecord
} from '@treeport/shared'
import * as schema from './database-schema'
import {
  operations,
  projects as projectTable,
  terminalPresets,
  webPanels,
  webPanelStorage,
  worktrees
} from './database-schema'
import { inferWorktreeName } from './zed'

const LEGACY_LATEST_VERSION = 10
const BACKUP_RETENTION = 2

const createOperationRequestSchema: z.ZodType<CreateOperationRequest> =
  z.strictObject({
    name: z.string(),
    base: z.enum(['default', 'current']),
    initialTerminal: z
      .strictObject({
        name: z.string(),
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
        repositoryIdentity: z.string().nullable()
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
        repositoryIdentity: null
      })
    )
  ]
)

const removeOperationResultSchema: z.ZodType<RemoveOperationResult> = z.union([
  z.strictObject({
    removed: z.literal(true),
    name: z.string(),
    branchPreserved: z.string().nullable(),
    path: z.string()
  }),
  z.strictObject({
    removed: z.literal(true),
    recovered: z.literal(true),
    path: z.string(),
    message: z.string()
  })
])

const externalRemoveOperationResultSchema: z.ZodType<ExternalRemoveOperationResult> =
  z.strictObject({
    removed: z.literal(true),
    external: z.literal(true),
    worktreeId: z.string(),
    path: z.string(),
    head: z.string(),
    branch: z.string().nullable()
  })

type TreeportOrm = LibSQLDatabase<typeof schema>
type ProjectRow = typeof projectTable.$inferSelect
type WorktreeRow = typeof worktrees.$inferSelect
type TerminalPresetRow = typeof terminalPresets.$inferSelect
type OperationRow = typeof operations.$inferSelect

export interface DatabaseOpenOptions {
  migrationsFolder?: string
  backupDirectory?: string
}

export function serializeOperation(value: object | null): string | null {
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

export class TreeportDatabase {
  private constructor(
    readonly filePath: string,
    readonly db: TreeportOrm,
    private readonly client: Client
  ) {}

  static async open(
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

        const pending =
          drizzleRows.length === 0 ||
          Number(drizzleRows.at(-1)?.createdAt) < latestMigration.folderMillis
        if (pending && hasDurableSchema) {
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
      await db.run(sql`PRAGMA foreign_keys = ON`)

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

      if (hasLegacyMigrations) {
        await db.transaction(async (tx) => {
          await tx.run(sql`DROP TABLE schema_migrations`)
        })
      }

      return new TreeportDatabase(absoluteFilePath, db, client)
    } catch (error) {
      client.close()
      throw error
    }
  }

  close(): void {
    this.client.close()
  }

  async projects(): Promise<ProjectRecord[]> {
    const rows = await this.db
      .select()
      .from(projectTable)
      .orderBy(sql`${projectTable.name} COLLATE NOCASE`)
    return Promise.all(rows.map((project) => this.mapProject(project)))
  }

  async openProjects(): Promise<ProjectRecord[]> {
    const rows = await this.db
      .select()
      .from(projectTable)
      .where(eq(projectTable.isOpen, 1))
      .orderBy(sql`${projectTable.name} COLLATE NOCASE`)
    return Promise.all(rows.map((project) => this.mapProject(project)))
  }

  async recentProjects(): Promise<RecentProjectRecord[]> {
    const rows = await this.db
      .select({
        id: projectTable.id,
        name: projectTable.name,
        repositoryPath: projectTable.repositoryPath,
        lastOpenedAt: projectTable.lastOpenedAt
      })
      .from(projectTable)
      .where(eq(projectTable.isOpen, 0))
      .orderBy(desc(projectTable.lastOpenedAt), asc(projectTable.id))
    return rows
  }

  async terminalPresets(): Promise<TerminalPreset[]> {
    const rows = await this.db
      .select()
      .from(terminalPresets)
      .orderBy(asc(terminalPresets.createdAt), asc(terminalPresets.id))
    return rows.map((preset) => this.mapTerminalPreset(preset))
  }

  async terminalPreset(id: string): Promise<TerminalPreset | null> {
    const [row] = await this.db
      .select()
      .from(terminalPresets)
      .where(eq(terminalPresets.id, id))
      .limit(1)
    return row ? this.mapTerminalPreset(row) : null
  }

  async insertTerminalPreset(preset: TerminalPreset): Promise<void> {
    await this.db.insert(terminalPresets).values({
      id: preset.id,
      name: preset.name,
      executable: preset.executable,
      argsJson: JSON.stringify(preset.args),
      closeOnSuccess: Number(preset.closeOnSuccess),
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt
    })
  }

  async updateTerminalPreset(
    preset: TerminalPreset,
    expectedUpdatedAt: string
  ): Promise<boolean> {
    const result = await this.db
      .update(terminalPresets)
      .set({
        name: preset.name,
        executable: preset.executable,
        argsJson: JSON.stringify(preset.args),
        closeOnSuccess: Number(preset.closeOnSuccess),
        updatedAt: preset.updatedAt
      })
      .where(
        and(
          eq(terminalPresets.id, preset.id),
          eq(terminalPresets.updatedAt, expectedUpdatedAt)
        )
      )
    return result.rowsAffected > 0
  }

  async deleteTerminalPreset(
    id: string,
    expectedUpdatedAt: string
  ): Promise<boolean> {
    const result = await this.db
      .delete(terminalPresets)
      .where(
        and(
          eq(terminalPresets.id, id),
          eq(terminalPresets.updatedAt, expectedUpdatedAt)
        )
      )
    return result.rowsAffected > 0
  }

  async isProjectOpen(projectId: string): Promise<boolean | null> {
    const [row] = await this.db
      .select({ isOpen: projectTable.isOpen })
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .limit(1)
    return row ? Boolean(row.isOpen) : null
  }

  async setProjectOpen(
    projectId: string,
    open: boolean,
    timestamp: string
  ): Promise<void> {
    await this.db
      .update(projectTable)
      .set(
        open
          ? { isOpen: 1, lastOpenedAt: timestamp, updatedAt: timestamp }
          : { isOpen: 0, updatedAt: timestamp }
      )
      .where(eq(projectTable.id, projectId))
  }

  async project(id: string): Promise<ProjectRecord | null> {
    const [row] = await this.db
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, id))
      .limit(1)
    return row ? this.mapProject(row) : null
  }

  async projectByPath(repositoryPath: string): Promise<ProjectRecord | null> {
    const [row] = await this.db
      .select()
      .from(projectTable)
      .where(
        or(
          eq(projectTable.repositoryPath, repositoryPath),
          eq(projectTable.mainWorktreePath, repositoryPath)
        )
      )
      .limit(1)
    return row ? this.mapProject(row) : null
  }

  async projectByRepositoryIdentity(
    identity: string
  ): Promise<ProjectRecord | null> {
    const [row] = await this.db
      .select()
      .from(projectTable)
      .where(eq(projectTable.repositoryIdentity, identity))
      .limit(1)
    return row ? this.mapProject(row) : null
  }

  async projectRepositoryMetadata(projectId: string): Promise<{
    identity: string | null
    device: string
    inode: string
    nameIsCustom: boolean
  } | null> {
    const [row] = await this.db
      .select({
        identity: projectTable.repositoryIdentity,
        device: projectTable.repositoryDevice,
        inode: projectTable.repositoryInode,
        nameIsCustom: projectTable.nameIsCustom
      })
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .limit(1)
    return row ? { ...row, nameIsCustom: Boolean(row.nameIsCustom) } : null
  }

  async webPanels(worktreeId?: string): Promise<WebPanel[]> {
    const rows = worktreeId
      ? await this.db
          .select()
          .from(webPanels)
          .where(eq(webPanels.worktreeId, worktreeId))
          .orderBy(asc(webPanels.createdAt), asc(webPanels.id))
      : await this.db
          .select()
          .from(webPanels)
          .orderBy(asc(webPanels.createdAt), asc(webPanels.id))
    return rows.map((row) => ({ ...row, kind: 'web' as const }))
  }

  async webPanel(id: string): Promise<WebPanel | null> {
    const [row] = await this.db
      .select()
      .from(webPanels)
      .where(eq(webPanels.id, id))
      .limit(1)
    return row ? { ...row, kind: 'web' } : null
  }

  async insertWebPanel(panel: WebPanel): Promise<void> {
    await this.db.insert(webPanels).values({
      id: panel.id,
      worktreeId: panel.worktreeId,
      definitionId: panel.definitionId,
      title: panel.title,
      createdAt: panel.createdAt,
      updatedAt: panel.updatedAt
    })
  }

  async deleteWebPanel(id: string): Promise<boolean> {
    return (
      (await this.db.delete(webPanels).where(eq(webPanels.id, id)))
        .rowsAffected > 0
    )
  }

  async hasWebPanelStorage(panelId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ key: webPanelStorage.key })
      .from(webPanelStorage)
      .where(eq(webPanelStorage.panelId, panelId))
      .limit(1)
    return row !== undefined
  }

  async webPanelStorageValue(
    panelId: string,
    key: string
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ valueJson: webPanelStorage.valueJson })
      .from(webPanelStorage)
      .where(
        and(eq(webPanelStorage.panelId, panelId), eq(webPanelStorage.key, key))
      )
      .limit(1)
    return row?.valueJson ?? null
  }

  async webPanelStorageUsage(
    panelId: string,
    excludingKey: string
  ): Promise<{ entries: number; bytes: number }> {
    const rows = await this.db
      .select({ valueJson: webPanelStorage.valueJson })
      .from(webPanelStorage)
      .where(
        and(
          eq(webPanelStorage.panelId, panelId),
          ne(webPanelStorage.key, excludingKey)
        )
      )
    return {
      entries: rows.length,
      bytes: rows.reduce(
        (total, row) => total + Buffer.byteLength(row.valueJson),
        0
      )
    }
  }

  async setWebPanelStorageValue(
    panelId: string,
    key: string,
    valueJson: string,
    updatedAt: string
  ): Promise<void> {
    await this.db
      .insert(webPanelStorage)
      .values({ panelId, key, valueJson, updatedAt })
      .onConflictDoUpdate({
        target: [webPanelStorage.panelId, webPanelStorage.key],
        set: { valueJson, updatedAt }
      })
  }

  async deleteWebPanelStorageValue(
    panelId: string,
    key: string
  ): Promise<void> {
    await this.db
      .delete(webPanelStorage)
      .where(
        and(eq(webPanelStorage.panelId, panelId), eq(webPanelStorage.key, key))
      )
  }

  async worktree(id: string): Promise<WorktreeRecord | null> {
    const [row] = await this.db
      .select({
        worktree: worktrees,
        mainWorktreePath: projectTable.mainWorktreePath
      })
      .from(worktrees)
      .innerJoin(projectTable, eq(worktrees.projectId, projectTable.id))
      .where(eq(worktrees.id, id))
      .limit(1)
    return row ? this.mapWorktree(row.worktree, row.mainWorktreePath) : null
  }

  async worktreeByPath(worktreePath: string): Promise<WorktreeRecord | null> {
    const [row] = await this.db
      .select({
        worktree: worktrees,
        mainWorktreePath: projectTable.mainWorktreePath
      })
      .from(worktrees)
      .innerJoin(projectTable, eq(worktrees.projectId, projectTable.id))
      .where(
        and(eq(worktrees.path, worktreePath), ne(worktrees.status, 'removed'))
      )
      .limit(1)
    return row ? this.mapWorktree(row.worktree, row.mainWorktreePath) : null
  }

  async operation(id: string): Promise<OperationRecord | null> {
    const [row] = await this.db
      .select()
      .from(operations)
      .where(eq(operations.id, id))
      .limit(1)
    return row ? this.mapOperation(row) : null
  }

  async activeOperations(
    filters: {
      projectId?: string
      kind?: OperationRecord['kind']
    } = {}
  ): Promise<OperationRecord[]> {
    const rows = await this.db
      .select()
      .from(operations)
      .where(
        and(
          or(
            eq(operations.status, 'pending'),
            eq(operations.status, 'running')
          ),
          ...(filters.projectId
            ? [eq(operations.projectId, filters.projectId)]
            : []),
          ...(filters.kind ? [eq(operations.kind, filters.kind)] : [])
        )
      )
      .orderBy(asc(operations.createdAt), asc(operations.id))
    return rows.map((row) => this.mapOperation(row))
  }

  private async mapProject(row: ProjectRow): Promise<ProjectRecord> {
    const rows = await this.db
      .select()
      .from(worktrees)
      .where(
        and(eq(worktrees.projectId, row.id), ne(worktrees.status, 'removed'))
      )
      .orderBy(
        sql`CASE ${worktrees.kind} WHEN 'main' THEN 0 ELSE 1 END`,
        asc(worktrees.createdAt),
        sql`rowid`
      )
    return {
      id: row.id,
      name: row.name,
      repositoryPath: row.repositoryPath,
      mainWorktreePath: row.mainWorktreePath,
      defaultBranch: row.defaultBranch,
      color: row.color as ProjectRecord['color'],
      availability: { state: 'available', message: null },
      worktrees: rows.map((worktree) =>
        this.mapWorktree(worktree, row.mainWorktreePath)
      ),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  private mapWorktree(
    row: WorktreeRow,
    mainWorktreePath: string
  ): WorktreeRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      name: inferWorktreeName(
        mainWorktreePath,
        row.path,
        row.kind as WorktreeRecord['kind']
      ),
      path: row.path,
      head: row.head,
      branch: row.branch,
      detached: Boolean(row.detached),
      locked: Boolean(row.locked),
      lockReason: row.lockReason,
      prunable: Boolean(row.prunable),
      kind: row.kind as WorktreeRecord['kind'],
      tmuxSocketName: row.tmuxSocketName,
      status: row.status as WorktreeRecord['status'],
      cleanupError: row.cleanupError,
      managedWrapperPath: row.managedWrapperPath,
      pr: {
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

  private mapTerminalPreset(row: TerminalPresetRow): TerminalPreset {
    return {
      id: row.id,
      name: row.name,
      executable: row.executable,
      args: JSON.parse(row.argsJson) as string[],
      closeOnSuccess: Boolean(row.closeOnSuccess),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  private mapOperation(row: OperationRow): OperationRecord {
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
        request: createOperationRequestSchema.parse(
          JSON.parse(row.requestJson)
        ),
        result: deserializeOperation(
          row.resultJson,
          createOperationResultSchema
        )
      }
    }

    if (row.kind === 'remove') {
      return {
        ...common,
        kind: row.kind,
        request: removeOperationRequestSchema.parse(
          JSON.parse(row.requestJson)
        ),
        result: deserializeOperation(
          row.resultJson,
          removeOperationResultSchema
        )
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
}
