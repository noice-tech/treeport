import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deserializeOperation,
  serializeOperation,
  TreeportDatabase
} from './database'
import { operations, projects, worktrees } from './database-schema'

const databases: TreeportDatabase[] = []
const directories: string[] = []
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('SQLite metadata', () => {
  it('migrates an empty database and serializes operation payloads', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-#?%-')
    )
    directories.push(directory)
    const database = await TreeportDatabase.open(
      path.join(directory, 'metadata.db')
    )
    databases.push(database)
    const request = {
      branch: 'feature/üñîçødé',
      argv: ['echo', 'a b', 'x;y', '$HOME', '"quoted"']
    }
    await database.db.insert(operations).values({
      id: 'op_1',
      kind: 'finish',
      projectId: null,
      worktreeId: null,
      status: 'pending',
      requestJson: serializeOperation(request)!,
      resultJson: null,
      error: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    expect(await database.operation('op_1')).toMatchObject({
      id: 'op_1',
      kind: 'finish',
      status: 'pending',
      request
    })
    expect(deserializeOperation(serializeOperation(request))).toEqual(request)
    expect(
      await database.db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`)
    ).toEqual({ journal_mode: 'wal' })
    expect(
      await database.db.get<{ count: number }>(sql`
        SELECT count(*) AS count FROM sqlite_master WHERE name='terminals'
      `)
    ).toEqual({ count: 0 })
  })

  it('persists literal preset argv, deterministic order, updates, and deletion', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-db-'))
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const database = await TreeportDatabase.open(filePath)
    databases.push(database)
    await database.insertTerminalPreset({
      id: 'preset_b',
      name: 'Second by ID',
      executable: '/Applications/Tool with spaces/bin/tool',
      args: ['a b', '"quote"', 'semi;colon', '$HOME', 'Unicode 世界', ''],
      closeOnSuccess: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    await database.insertTerminalPreset({
      id: 'preset_a',
      name: 'First by ID',
      executable: 'pi',
      args: [],
      closeOnSuccess: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    await database.insertTerminalPreset({
      id: 'preset_c',
      name: 'Created later',
      executable: 'npx',
      args: ['--yes'],
      closeOnSuccess: false,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    })

    expect(
      (await database.terminalPresets()).map((preset) => preset.id)
    ).toEqual(['preset_a', 'preset_b', 'preset_c'])
    const updated = {
      ...(await database.terminalPreset('preset_b'))!,
      name: 'Updated',
      args: ['literal;value', '$NOT_EXPANDED'],
      updatedAt: '2026-01-03T00:00:00.000Z'
    }
    await expect(
      database.updateTerminalPreset(updated, '2026-01-01T00:00:00.000Z')
    ).resolves.toBe(true)
    await expect(
      database.deleteTerminalPreset('preset_a', '2026-01-01T00:00:00.000Z')
    ).resolves.toBe(true)
    await expect(
      database.deleteTerminalPreset(
        'preset_missing',
        '2026-01-01T00:00:00.000Z'
      )
    ).resolves.toBe(false)
    database.close()
    databases.splice(databases.indexOf(database), 1)

    const reopened = await TreeportDatabase.open(filePath)
    databases.push(reopened)
    expect(await reopened.terminalPresets()).toEqual([
      updated,
      expect.objectContaining({
        id: 'preset_c',
        executable: 'npx',
        args: ['--yes']
      })
    ])
  })

  it('filters open projects and orders lightweight recent registrations by open time', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-db-'))
    directories.push(directory)
    const database = await TreeportDatabase.open(
      path.join(directory, 'metadata.db')
    )
    databases.push(database)
    await database.db.insert(projects).values([
      {
        id: 'p_old',
        name: 'Old',
        repositoryPath: '/old',
        mainWorktreePath: '/old',
        defaultBranch: 'main',
        color: 'blue',
        repositoryDevice: '1',
        repositoryInode: '1',
        nameIsCustom: 0,
        isOpen: 0,
        lastOpenedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2026-12-01T00:00:00.000Z'
      },
      {
        id: 'p_new',
        name: 'New',
        repositoryPath: '/new',
        mainWorktreePath: '/new',
        defaultBranch: 'main',
        color: 'blue',
        repositoryDevice: '2',
        repositoryInode: '2',
        nameIsCustom: 0,
        isOpen: 0,
        lastOpenedAt: '2026-02-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 'p_open',
        name: 'Open',
        repositoryPath: '/open',
        mainWorktreePath: '/open',
        defaultBranch: 'main',
        color: 'blue',
        repositoryDevice: '3',
        repositoryInode: '3',
        nameIsCustom: 0,
        isOpen: 1,
        lastOpenedAt: '2026-03-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z'
      }
    ])

    expect(
      (await database.projects()).map((project) => project.id).sort()
    ).toEqual(['p_new', 'p_old', 'p_open'])
    expect(
      (await database.openProjects()).map((project) => project.id)
    ).toEqual(['p_open'])
    const recent = await database.recentProjects()
    expect(recent).toEqual([
      {
        id: 'p_new',
        name: 'New',
        repositoryPath: '/new',
        lastOpenedAt: '2026-02-01T00:00:00.000Z'
      },
      {
        id: 'p_old',
        name: 'Old',
        repositoryPath: '/old',
        lastOpenedAt: '2026-01-01T00:00:00.000Z'
      }
    ])
    expect('worktrees' in recent[0]!).toBe(false)

    await database.setProjectOpen('p_old', true, '2026-04-01T00:00:00.000Z')
    await database.setProjectOpen('p_open', false, '2026-05-01T00:00:00.000Z')
    await expect(database.isProjectOpen('p_old')).resolves.toBe(true)
    await expect(database.isProjectOpen('p_open')).resolves.toBe(false)
    expect(
      (await database.recentProjects()).map((project) => project.id)
    ).toEqual(['p_open', 'p_new'])
    expect(
      await database.db.get<{ lastOpenedAt: string }>(sql`
        SELECT last_opened_at AS lastOpenedAt FROM projects WHERE id = 'p_open'
      `)
    ).toEqual({ lastOpenedAt: '2026-03-01T00:00:00.000Z' })
  })

  it('keeps the main worktree first and linked worktrees in creation order', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-db-'))
    directories.push(directory)
    const database = await TreeportDatabase.open(
      path.join(directory, 'metadata.db')
    )
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
        status: 'active',
        createdAt: createdAt!,
        updatedAt: createdAt!
      }))
    )

    expect(
      (await database.project('p_order'))!.worktrees.map(
        (worktree) => worktree.id
      )
    ).toEqual(['wt_main', 'wt_oldest', 'wt_same_a', 'wt_same_b', 'wt_newest'])
  })

  it('adopts a version-7 database, preserves catalog data, and snapshots once', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-v7-')
    )
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const initial = await TreeportDatabase.open(filePath)
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
      status: 'active',
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
    await initial.db.transaction(async (tx) => {
      await tx.run(sql`DROP INDEX terminal_presets_order_idx`)
      await tx.run(sql`DROP TABLE terminal_presets`)
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

    const reopened = await TreeportDatabase.open(filePath)
    databases.push(reopened)
    expect(await reopened.project('p_existing')).toMatchObject({
      id: 'p_existing',
      name: 'Existing',
      repositoryPath: '/existing',
      worktrees: [{ id: 'wt_existing', path: '/existing-linked' }]
    })
    expect(await reopened.operation('op_existing')).toMatchObject({
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
    ).toEqual({ count: 1 })

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
    const openedAgain = await TreeportDatabase.open(filePath)
    databases.push(openedAgain)
    expect(
      (await fs.readdir(backupDirectory)).filter((name) => name.endsWith('.db'))
    ).toHaveLength(1)
  })

  it('adopts version-8 preset rows that predate close-on-success', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-v8-')
    )
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const initial = await TreeportDatabase.open(filePath)
    await initial.insertTerminalPreset({
      id: 'preset_legacy',
      name: 'Legacy preset',
      executable: 'pi',
      args: ['--continue'],
      closeOnSuccess: false,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
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

    const reopened = await TreeportDatabase.open(filePath)
    databases.push(reopened)
    expect(await reopened.terminalPresets()).toEqual([
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
    const current = await TreeportDatabase.open(filePath)
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

    await expect(TreeportDatabase.open(filePath)).rejects.toThrow(
      /newer than this binary supports.*Upgrade Treeport/
    )
    expect(await fs.readFile(filePath)).toEqual(before)
    await expect(
      fs.stat(path.join(directory, 'database-backups'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back a failed migration and recovers on the next startup', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-failure-')
    )
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const initial = await TreeportDatabase.open(filePath)
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
    await initial.db.transaction(async (tx) => {
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
      new URL('../../drizzle', import.meta.url)
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
      TreeportDatabase.open(filePath, {
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

    const recovered = await TreeportDatabase.open(filePath)
    databases.push(recovered)
    expect(await recovered.project('p_recover')).toMatchObject({
      id: 'p_recover',
      name: 'Recover me'
    })
    expect(
      await recovered.db.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM __drizzle_migrations`
      )
    ).toEqual({ count: 1 })
  })
})
