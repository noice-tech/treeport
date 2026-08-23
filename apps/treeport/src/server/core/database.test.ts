import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@libsql/client'
import { and, asc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mapOperation,
  mapProject,
  mapTerminalPreset,
  openDatabase,
  type TreeportDatabase
} from './database'
import {
  operations,
  projects,
  terminalBellStates,
  terminalPresets,
  webPanels,
  webPanelStorage,
  worktrees
} from './database-schema'

const databases: TreeportDatabase[] = []
const directories: string[] = []

async function removeFolderProjectSchema(
  database: TreeportDatabase
): Promise<void> {
  const [table] = await database.db.all<{ sql: string }>(sql`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'
  `)
  const legacySql = table?.sql.replace(
    /,\s*`project_kind` text DEFAULT 'repository' NOT NULL CONSTRAINT `projects_kind_check` CHECK\(`project_kind` IN \('repository','folder'\)\)/u,
    ''
  )
  if (!table || legacySql === table.sql) {
    throw new Error('Could not prepare the legacy project schema')
  }

  const [versionRow] = await database.db.all<{ schemaVersion: number }>(
    sql`PRAGMA schema_version`
  )
  if (!versionRow) {
    throw new Error('Could not read the legacy schema version')
  }

  const { schemaVersion } = versionRow
  await database.db.run(sql`PRAGMA writable_schema = ON`)
  await database.db.run(sql`
    UPDATE sqlite_master SET sql=${legacySql}
    WHERE type='table' AND name='projects'
  `)
  await database.db.run(
    sql.raw(`PRAGMA schema_version = ${Number(schemaVersion) + 1}`)
  )
  await database.db.run(sql`PRAGMA writable_schema = OFF`)
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('SQLite migration and catalog ordering', () => {
  it('migrates an empty database from a path with URL delimiters', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-#?%-')
    )
    directories.push(directory)
    const database = await openDatabase(path.join(directory, 'metadata.db'))
    databases.push(database)

    expect(database.migrationState).toBe('advanced')
    expect(database.migrationSnapshotPaths).toEqual([])
    expect(
      await database.db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`)
    ).toEqual({ journal_mode: 'wal' })
    expect(
      await database.db.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM __drizzle_migrations`
      )
    ).toEqual({ count: 11 })
    expect(
      await database.db.get<{ count: number }>(sql`
        SELECT count(*) AS count FROM sqlite_master WHERE name='terminals'
      `)
    ).toEqual({ count: 0 })

    const timestamps = {
      lastOpenedAt: '2026-01-01',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    }
    await database.db.insert(projects).values([
      {
        id: 'legacy-a',
        name: 'Legacy A',
        repositoryPath: '/legacy-a',
        mainWorktreePath: '/legacy-a',
        defaultBranch: 'main',
        repositoryDevice: '1',
        repositoryInode: '2',
        ...timestamps
      },
      {
        id: 'legacy-b',
        name: 'Legacy B',
        repositoryPath: '/legacy-b',
        mainWorktreePath: '/legacy-b',
        defaultBranch: 'main',
        repositoryDevice: '1',
        repositoryInode: '2',
        ...timestamps
      }
    ])
    await database.db.run(sql`
      UPDATE projects SET repository_identity='11111111-1111-4111-8111-111111111111'
      WHERE id='legacy-a'
    `)
    expect(
      await database.db
        .select()
        .from(projects)
        .where(
          eq(
            projects.repositoryIdentity,
            '11111111-1111-4111-8111-111111111111'
          )
        )
        .then(([project]) => project)
    ).toMatchObject({ id: 'legacy-a', name: 'Legacy A' })
  })

  it('persists terminal bell state and removes it with its worktree', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-bells-')
    )
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const database = await openDatabase(filePath)
    await database.db.insert(projects).values({
      id: 'p_bells',
      name: 'Bells',
      repositoryPath: '/bells',
      mainWorktreePath: '/bells',
      defaultBranch: 'main',
      repositoryDevice: '1',
      repositoryInode: '3',
      lastOpenedAt: '2026-01-01',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    await database.db.insert(worktrees).values({
      id: 'wt_bells',
      projectId: 'p_bells',
      path: '/bells',
      kind: 'main',
      tmuxSocketName: 'bells-socket',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    await database.db.insert(terminalBellStates).values({
      terminalId: 'term_bells',
      worktreeId: 'wt_bells',
      sequence: 4,
      occurredAt: '2026-01-01T00:02:00.000Z',
      unread: 1
    })
    database.close()

    const reopened = await openDatabase(filePath)
    databases.push(reopened)
    expect(reopened.migrationState).toBe('unchanged')
    expect(reopened.migrationSnapshotPaths).toEqual([])
    expect(await reopened.db.select().from(terminalBellStates)).toEqual([
      {
        terminalId: 'term_bells',
        worktreeId: 'wt_bells',
        sequence: 4,
        occurredAt: '2026-01-01T00:02:00.000Z',
        unread: 1
      }
    ])

    await reopened.db.delete(worktrees).where(eq(worktrees.id, 'wt_bells'))
    expect(await reopened.db.select().from(terminalBellStates)).toEqual([])
  })

  it('keeps the main worktree first and linked worktrees in creation order', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-db-'))
    directories.push(directory)
    const database = await openDatabase(path.join(directory, 'metadata.db'))
    databases.push(database)
    await database.db.insert(projects).values({
      id: 'p_order',
      name: 'Ordered',
      repositoryPath: '/ordered',
      mainWorktreePath: '/ordered',
      defaultBranch: 'main',
      repositoryDevice: '1',
      repositoryInode: '1',
      lastOpenedAt: '2026-01-01',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    await database.db.insert(worktrees).values(
      [
        ['wt_newest', '/ordered-newest', 'linked', '2026-03-01'],
        ['wt_main', '/ordered', 'main', '2026-04-01'],
        ['wt_oldest', '/ordered-oldest', 'linked', '2026-01-01'],
        ['wt_same_a', '/ordered-same-a', 'linked', '2026-02-01'],
        ['wt_same_b', '/ordered-same-b', 'linked', '2026-02-01']
      ].map(([id, worktreePath, kind, createdAt]) => ({
        id: id!,
        projectId: 'p_order',
        path: worktreePath!,
        kind: kind!,
        tmuxSocketName: `socket-${id}`,
        createdAt: createdAt!,
        updatedAt: createdAt!
      }))
    )

    const rows = await database.db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(eq(worktrees.projectId, 'p_order'))
      .orderBy(
        sql`CASE ${worktrees.kind} WHEN 'main' THEN 0 ELSE 1 END`,
        asc(worktrees.createdAt),
        sql`rowid`
      )
    expect(rows.map((worktree) => worktree.id)).toEqual([
      'wt_main',
      'wt_oldest',
      'wt_same_a',
      'wt_same_b',
      'wt_newest'
    ])
  })

  it('persists ordered web panels with their worktree lifecycle', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-panels-')
    )
    directories.push(directory)
    const database = await openDatabase(path.join(directory, 'metadata.db'))
    databases.push(database)
    await database.db.insert(projects).values({
      id: 'p',
      name: 'Panels',
      repositoryPath: '/panels',
      mainWorktreePath: '/panels',
      defaultBranch: 'main',
      repositoryDevice: '1',
      repositoryInode: '9',
      lastOpenedAt: '2026-01-01',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    await database.db.insert(worktrees).values({
      id: 'wt',
      projectId: 'p',
      path: '/panels',
      kind: 'main',
      tmuxSocketName: 'panel-socket',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    for (const [id, createdAt] of [
      ['later', '2026-02-02'],
      ['earlier', '2026-02-01']
    ] as const) {
      await database.db.insert(webPanels).values({
        id,
        worktreeId: 'wt',
        definitionId: 'project:review',
        title: id,
        createdAt,
        updatedAt: createdAt
      })
    }
    expect(
      (
        await database.db
          .select({ id: webPanels.id })
          .from(webPanels)
          .where(eq(webPanels.worktreeId, 'wt'))
          .orderBy(asc(webPanels.createdAt), asc(webPanels.id))
      ).map((panel) => panel.id)
    ).toEqual(['earlier', 'later'])

    expect(
      await database.db
        .select()
        .from(webPanelStorage)
        .where(eq(webPanelStorage.panelId, 'earlier'))
    ).toEqual([])
    await database.db.insert(webPanelStorage).values({
      panelId: 'earlier',
      key: 'comments',
      valueJson: '[{"line":12}]',
      updatedAt: '2026-02-03'
    })
    expect(
      await database.db
        .select({ valueJson: webPanelStorage.valueJson })
        .from(webPanelStorage)
        .where(
          and(
            eq(webPanelStorage.panelId, 'earlier'),
            eq(webPanelStorage.key, 'comments')
          )
        )
        .then(([row]) => row?.valueJson)
    ).toBe('[{"line":12}]')
    await database.db
      .insert(webPanelStorage)
      .values({
        panelId: 'earlier',
        key: 'comments',
        valueJson: '[{"line":13}]',
        updatedAt: '2026-02-04'
      })
      .onConflictDoUpdate({
        target: [webPanelStorage.panelId, webPanelStorage.key],
        set: { valueJson: '[{"line":13}]', updatedAt: '2026-02-04' }
      })
    expect(
      await database.db
        .select({ valueJson: webPanelStorage.valueJson })
        .from(webPanelStorage)
        .where(eq(webPanelStorage.panelId, 'earlier'))
        .then(([row]) => row?.valueJson)
    ).toBe('[{"line":13}]')

    await database.db.delete(worktrees).where(eq(worktrees.id, 'wt'))
    expect(await database.db.select().from(webPanels)).toEqual([])
    expect(await database.db.select().from(webPanelStorage)).toEqual([])
  })

  it('adopts a version-7 database, preserves catalog data, and snapshots once', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-v7-')
    )
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const initial = await openDatabase(filePath)
    await initial.db.insert(projects).values({
      id: 'p_existing',
      name: 'Existing',
      repositoryPath: '/existing',
      mainWorktreePath: '/existing',
      defaultBranch: 'main',
      repositoryDevice: '1',
      repositoryInode: '2',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    await initial.db.insert(worktrees).values({
      id: 'wt_existing',
      projectId: 'p_existing',
      path: '/existing-linked',
      kind: 'linked',
      tmuxSocketName: 'treeport-existing',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    await initial.db.insert(operations).values({
      id: 'op_existing',
      kind: 'remove',
      projectId: 'p_existing',
      worktreeId: 'wt_existing',
      status: 'pending',
      requestJson: '{"confirmation":true}',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    await removeFolderProjectSchema(initial)
    await initial.db.transaction(async (tx) => {
      await tx.run(sql`DROP INDEX terminal_presets_order_idx`)
      await tx.run(sql`DROP TABLE terminal_presets`)
      await tx.run(sql`DROP INDEX projects_recent_idx`)
      await tx.run(sql`ALTER TABLE projects DROP COLUMN show_in_recents`)
      await tx.run(sql`
        CREATE INDEX projects_recent_idx
        ON projects(is_open,last_opened_at DESC,id)
      `)
      await tx.run(sql`DROP INDEX projects_repository_identity_idx`)
      await tx.run(sql`ALTER TABLE projects DROP COLUMN repository_identity`)
      await tx.run(sql`
        CREATE UNIQUE INDEX projects_fs_identity_idx
        ON projects(repository_device,repository_inode)
      `)
      await tx.run(sql`ALTER TABLE web_panels DROP COLUMN input_json`)
      await tx.run(sql`ALTER TABLE web_panels DROP COLUMN launch_cwd`)
      await tx.run(sql`DROP TABLE terminal_bell_states`)
      await tx.run(sql`DROP TABLE __drizzle_migrations`)
      await tx.run(sql`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `)
      await tx.run(sql`INSERT INTO schema_migrations VALUES (7, '2026-01-01')`)
    })
    initial.close()

    const reopened = await openDatabase(filePath)
    databases.push(reopened)
    const [projectRow] = await reopened.db
      .select()
      .from(projects)
      .where(eq(projects.id, 'p_existing'))
    const worktreeRows = await reopened.db
      .select()
      .from(worktrees)
      .where(eq(worktrees.projectId, 'p_existing'))
    expect(mapProject(projectRow!, worktreeRows)).toMatchObject({
      id: 'p_existing',
      name: 'Existing',
      repositoryPath: '/existing',
      worktrees: [{ id: 'wt_existing', path: '/existing-linked' }]
    })
    const [operationRow] = await reopened.db
      .select()
      .from(operations)
      .where(eq(operations.id, 'op_existing'))
    expect(mapOperation(operationRow!)).toMatchObject({
      id: 'op_existing',
      projectId: 'p_existing',
      worktreeId: 'wt_existing',
      request: { confirmation: true }
    })
    expect(
      await reopened.db.all<{ name: string }>(sql`
        SELECT name FROM sqlite_master
        WHERE type='table'
          AND name IN ('schema_migrations','__drizzle_migrations','terminal_presets')
        ORDER BY name
      `)
    ).toEqual([{ name: '__drizzle_migrations' }, { name: 'terminal_presets' }])
    expect(
      await reopened.db.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM __drizzle_migrations`
      )
    ).toEqual({ count: 11 })

    const backupDirectory = path.join(directory, 'database-backups')
    const [backupName] = await fs.readdir(backupDirectory)
    expect(backupName).toBeDefined()
    const snapshotClient = createClient({
      url: pathToFileURL(path.join(backupDirectory, backupName!)).href
    })
    const snapshot = drizzle(snapshotClient)
    expect(
      await snapshot.get<{ count: number }>(sql`
        SELECT count(*) AS count FROM projects WHERE id='p_existing'
      `)
    ).toEqual({ count: 1 })
    expect(
      await snapshot.all<{ version: number }>(
        sql`SELECT version FROM schema_migrations`
      )
    ).toEqual([{ version: 7 }])
    snapshotClient.close()

    reopened.close()
    databases.splice(databases.indexOf(reopened), 1)
    const openedAgain = await openDatabase(filePath)
    databases.push(openedAgain)
    expect(
      (await fs.readdir(backupDirectory)).filter((name) => name.endsWith('.db'))
    ).toHaveLength(1)
  })

  it('preserves populated web panels when adding folder projects', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-folder-project-migration-')
    )
    directories.push(directory)
    const oldMigrations = path.join(directory, 'old-migrations')
    const packagedMigrations = fileURLToPath(
      new URL('../../../drizzle', import.meta.url)
    )
    await fs.cp(packagedMigrations, oldMigrations, { recursive: true })
    await Promise.all([
      fs.rm(path.join(oldMigrations, '0009_open_folders.sql')),
      fs.rm(path.join(oldMigrations, '0010_host_browser_permissions.sql')),
      fs.rm(path.join(oldMigrations, 'meta', '0009_snapshot.json')),
      fs.rm(path.join(oldMigrations, 'meta', '0010_snapshot.json'))
    ])
    const journalPath = path.join(oldMigrations, 'meta', '_journal.json')
    // SAFETY: The copied migration journal has the asserted test shape.
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as {
      entries: unknown[]
    }
    journal.entries.splice(9)
    await fs.writeFile(journalPath, JSON.stringify(journal, null, 2))

    const filePath = path.join(directory, 'treeport.db')
    const oldDatabase = await openDatabase(filePath, {
      migrationsFolder: oldMigrations
    })
    await oldDatabase.db.run(sql`
      INSERT INTO projects(
        id,name,repository_path,main_worktree_path,default_branch,
        repository_device,repository_inode,last_opened_at,created_at,updated_at
      ) VALUES(
        'p_panel','Panel project','/panel','/panel','main',
        '1','2','2026-01-01','2026-01-01','2026-01-01'
      )
    `)
    await oldDatabase.db.run(sql`
      INSERT INTO worktrees(
        id,project_id,path,kind,tmux_socket_name,created_at,updated_at
      ) VALUES(
        'wt_panel','p_panel','/panel','main','panel-socket',
        '2026-01-01','2026-01-01'
      )
    `)
    await oldDatabase.db.run(sql`
      INSERT INTO web_panels(
        id,worktree_id,definition_id,title,created_at,updated_at,
        input_json,launch_cwd
      ) VALUES(
        'panel_existing','wt_panel','browser','Existing panel',
        '2026-01-02','2026-01-03','{"url":"http://localhost:3000"}','/panel'
      )
    `)
    await oldDatabase.db.run(sql`
      INSERT INTO web_panel_storage(panel_id,key,value_json,updated_at)
      VALUES('panel_existing','state','{"ready":true}','2026-01-04')
    `)
    oldDatabase.close()

    const migrated = await openDatabase(filePath)
    databases.push(migrated)
    expect(
      await migrated.db
        .select()
        .from(webPanels)
        .where(eq(webPanels.id, 'panel_existing'))
        .then(([panel]) => panel)
    ).toEqual({
      id: 'panel_existing',
      worktreeId: 'wt_panel',
      definitionId: 'browser',
      title: 'Existing panel',
      inputJson: '{"url":"http://localhost:3000"}',
      launchCwd: '/panel',
      createdAt: '2026-01-02',
      updatedAt: '2026-01-03'
    })
    expect(
      await migrated.db
        .select()
        .from(webPanelStorage)
        .where(eq(webPanelStorage.panelId, 'panel_existing'))
        .then(([entry]) => entry)
    ).toEqual({
      panelId: 'panel_existing',
      key: 'state',
      valueJson: '{"ready":true}',
      updatedAt: '2026-01-04'
    })
  })

  it('adopts version-8 preset rows that predate close-on-success', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-v8-')
    )
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const initial = await openDatabase(filePath)
    await initial.db.insert(terminalPresets).values({
      id: 'preset_legacy',
      name: 'Legacy preset',
      executable: 'pi',
      argsJson: '["--continue"]',
      closeOnSuccess: 0,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    await removeFolderProjectSchema(initial)
    await initial.db.transaction(async (tx) => {
      await tx.run(
        sql`ALTER TABLE terminal_presets RENAME TO terminal_presets_latest`
      )
      await tx.run(sql`
        CREATE TABLE terminal_presets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          executable TEXT NOT NULL,
          args_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      await tx.run(sql`
        INSERT INTO terminal_presets(id,name,executable,args_json,created_at,updated_at)
        SELECT id,name,executable,args_json,created_at,updated_at
        FROM terminal_presets_latest
      `)
      await tx.run(sql`DROP TABLE terminal_presets_latest`)
      await tx.run(sql`DROP INDEX projects_recent_idx`)
      await tx.run(sql`ALTER TABLE projects DROP COLUMN show_in_recents`)
      await tx.run(sql`
        CREATE INDEX projects_recent_idx
        ON projects(is_open,last_opened_at DESC,id)
      `)
      await tx.run(sql`DROP INDEX projects_repository_identity_idx`)
      await tx.run(sql`ALTER TABLE projects DROP COLUMN repository_identity`)
      await tx.run(sql`
        CREATE UNIQUE INDEX projects_fs_identity_idx
        ON projects(repository_device,repository_inode)
      `)
      await tx.run(sql`ALTER TABLE web_panels DROP COLUMN input_json`)
      await tx.run(sql`ALTER TABLE web_panels DROP COLUMN launch_cwd`)
      await tx.run(sql`DROP TABLE terminal_bell_states`)
      await tx.run(sql`DROP TABLE __drizzle_migrations`)
      await tx.run(sql`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `)
      await tx.run(sql`INSERT INTO schema_migrations VALUES (7, '2026-01-01')`)
      await tx.run(sql`INSERT INTO schema_migrations VALUES (8, '2026-01-02')`)
    })
    initial.close()

    const reopened = await openDatabase(filePath)
    databases.push(reopened)
    expect(
      (await reopened.db.select().from(terminalPresets)).map(mapTerminalPreset)
    ).toEqual([
      {
        id: 'preset_legacy',
        name: 'Legacy preset',
        executable: 'pi',
        args: ['--continue'],
        closeOnSuccess: false,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }
    ])
  })

  it('refuses a newer migration history without modifying the database', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-newer-')
    )
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const current = await openDatabase(filePath)
    const { supported } = (await current.db.get<{ supported: number }>(sql`
      SELECT max(created_at) AS supported FROM __drizzle_migrations
    `))!
    await current.db.run(sql`
      INSERT INTO __drizzle_migrations(hash, created_at)
      VALUES('future-migration', ${supported + 1})
    `)
    await current.db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
    current.close()
    const before = await fs.readFile(filePath)

    await expect(openDatabase(filePath)).rejects.toThrow(
      /newer than this binary supports.*Upgrade Treeport/
    )
    expect(await fs.readFile(filePath)).toEqual(before)
    await expect(
      fs.stat(path.join(directory, 'database-backups'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cuts cleanup lifecycle columns out of an existing worktree catalog', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-cleanup-cutover-')
    )
    directories.push(directory)
    const oldMigrations = path.join(directory, 'old-migrations')
    const packagedMigrations = fileURLToPath(
      new URL('../../../drizzle', import.meta.url)
    )
    await fs.cp(packagedMigrations, oldMigrations, { recursive: true })
    await Promise.all([
      fs.rm(path.join(oldMigrations, '0005_git_authoritative_worktrees.sql')),
      fs.rm(path.join(oldMigrations, '0006_web_panel_launch_input.sql')),
      fs.rm(path.join(oldMigrations, '0007_dashing_pestilence.sql')),
      fs.rm(path.join(oldMigrations, '0008_recent_project_visibility.sql')),
      fs.rm(path.join(oldMigrations, '0009_open_folders.sql')),
      fs.rm(path.join(oldMigrations, '0010_host_browser_permissions.sql')),
      fs.rm(path.join(oldMigrations, 'meta', '0005_snapshot.json')),
      fs.rm(path.join(oldMigrations, 'meta', '0006_snapshot.json')),
      fs.rm(path.join(oldMigrations, 'meta', '0007_snapshot.json')),
      fs.rm(path.join(oldMigrations, 'meta', '0008_snapshot.json')),
      fs.rm(path.join(oldMigrations, 'meta', '0009_snapshot.json')),
      fs.rm(path.join(oldMigrations, 'meta', '0010_snapshot.json'))
    ])
    const journalPath = path.join(oldMigrations, 'meta', '_journal.json')
    // SAFETY: The test fixture provides the asserted contract used here.
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as {
      entries: unknown[]
    }
    journal.entries.splice(5)
    await fs.writeFile(journalPath, JSON.stringify(journal, null, 2))

    const filePath = path.join(directory, 'treeport.db')
    const oldDatabase = await openDatabase(filePath, {
      migrationsFolder: oldMigrations
    })
    await oldDatabase.db.run(sql`
      INSERT INTO projects(
        id,name,repository_path,main_worktree_path,default_branch,
        repository_device,repository_inode,is_open,last_opened_at,created_at,updated_at
      ) VALUES(
        'p_cutover','Cutover','/cutover','/cutover','main',
        '1','1',0,'2026-01-01','2026-01-01','2026-01-01'
      )
    `)
    await oldDatabase.db.run(sql`
      INSERT INTO worktrees(
        id,project_id,path,kind,tmux_socket_name,status,cleanup_error,
        created_at,updated_at
      ) VALUES(
        'w_cutover','p_cutover','/cutover','main','cutover-socket',
        'cleanup_failed','old cleanup error','2026-01-01','2026-01-01'
      )
    `)
    oldDatabase.close()

    const migrated = await openDatabase(filePath)
    databases.push(migrated)
    expect(migrated.migrationState).toBe('advanced')
    expect(migrated.migrationSnapshotPaths).toHaveLength(1)
    expect(
      await migrated.db
        .select()
        .from(projects)
        .where(eq(projects.id, 'p_cutover'))
        .then(([project]) => project)
    ).toMatchObject({ id: 'p_cutover', showInRecents: 1 })
    expect(
      await migrated.db
        .select()
        .from(worktrees)
        .where(eq(worktrees.id, 'w_cutover'))
        .then(([worktree]) => worktree)
    ).toMatchObject({ id: 'w_cutover', path: '/cutover' })
    expect(
      (
        await migrated.db.all<{ name: string }>(
          sql`PRAGMA table_info(worktrees)`
        )
      )
        .map((column) => column.name)
        .filter((name) => name === 'status' || name === 'cleanup_error')
    ).toEqual([])
  })

  it('rolls back a failed migration and recovers on the next startup', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-failure-')
    )
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const initial = await openDatabase(filePath)
    await initial.db.insert(projects).values({
      id: 'p_recover',
      name: 'Recover me',
      repositoryPath: '/recover',
      mainWorktreePath: '/recover',
      defaultBranch: 'main',
      repositoryDevice: '3',
      repositoryInode: '4',
      lastOpenedAt: '2026-01-01',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    await removeFolderProjectSchema(initial)
    await initial.db.transaction(async (tx) => {
      await tx.run(sql`DROP INDEX projects_recent_idx`)
      await tx.run(sql`ALTER TABLE projects DROP COLUMN show_in_recents`)
      await tx.run(sql`
        CREATE INDEX projects_recent_idx
        ON projects(is_open,last_opened_at DESC,id)
      `)
      await tx.run(sql`DROP INDEX projects_repository_identity_idx`)
      await tx.run(sql`ALTER TABLE projects DROP COLUMN repository_identity`)
      await tx.run(sql`
        CREATE UNIQUE INDEX projects_fs_identity_idx
        ON projects(repository_device,repository_inode)
      `)
      await tx.run(sql`ALTER TABLE web_panels DROP COLUMN input_json`)
      await tx.run(sql`ALTER TABLE web_panels DROP COLUMN launch_cwd`)
      await tx.run(sql`DROP TABLE terminal_bell_states`)
      await tx.run(sql`DROP TABLE __drizzle_migrations`)
      await tx.run(sql`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `)
      await tx.run(sql`INSERT INTO schema_migrations VALUES (7, '2026-01-01')`)
    })
    initial.close()

    const validMigrations = fileURLToPath(
      new URL('../../../drizzle', import.meta.url)
    )
    const brokenMigrations = path.join(directory, 'broken-migrations')
    await fs.cp(validMigrations, brokenMigrations, { recursive: true })
    const migrationFile = path.join(
      brokenMigrations,
      '0000_public_baseline.sql'
    )
    await fs.appendFile(
      migrationFile,
      '--> statement-breakpoint\nCREATE TABLE migration_will_rollback(id TEXT);\n--> statement-breakpoint\nTHIS IS NOT SQL;\n'
    )

    await expect(
      openDatabase(filePath, {
        migrationsFolder: brokenMigrations
      })
    ).rejects.toThrow()
    const failedClient = createClient({ url: pathToFileURL(filePath).href })
    const failed = drizzle(failedClient)
    expect(
      await failed.get<{ count: number }>(sql`
        SELECT count(*) AS count FROM projects WHERE id='p_recover'
      `)
    ).toEqual({ count: 1 })
    expect(
      await failed.get<{ count: number }>(sql`
        SELECT count(*) AS count FROM sqlite_master
        WHERE name='migration_will_rollback'
      `)
    ).toEqual({ count: 0 })
    expect(
      await failed.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM __drizzle_migrations`
      )
    ).toEqual({ count: 0 })
    failedClient.close()
    expect(
      await fs.readdir(path.join(directory, 'database-backups'))
    ).toHaveLength(1)

    const recovered = await openDatabase(filePath)
    databases.push(recovered)
    expect(
      await recovered.db
        .select()
        .from(projects)
        .where(eq(projects.id, 'p_recover'))
        .then(([project]) => project)
    ).toMatchObject({ id: 'p_recover', name: 'Recover me' })
    expect(
      await recovered.db.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM __drizzle_migrations`
      )
    ).toEqual({ count: 11 })
  })
})
