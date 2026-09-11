import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { expect, it } from 'vitest'
import { openDatabase, type TreeportDatabase } from './database'
import baseline from './fixtures/database-0.5.0.json' with { type: 'json' }

it('preserves the published database contract through upgrade and downgrade refusal', async () => {
  const migrationsFolder = fileURLToPath(
    new URL('../../../drizzle', import.meta.url)
  )
  const migrations = readMigrationFiles({ migrationsFolder })
  const history = baseline.migrations.map((migration) => ({
    hash: migration.hash,
    created_at: migration.when
  }))
  // Frozen from the integrity-checked published tarball recorded in the fixture.
  // Reuse SQL only after verifying its historical hashes: constructing an old
  // schema by undoing today's schema could silently change both sides together.
  expect(
    migrations.slice(0, history.length).map((migration) => ({
      hash: migration.hash,
      created_at: migration.folderMillis
    }))
  ).toEqual(history)
  expect(migrations.length).toBeGreaterThan(history.length)

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-db-upgrade-'))
  const filePath = path.join(root, 'treeport.db')
  const historicalMigrations = path.join(root, 'historical-migrations')
  const historyQuery = sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at`
  const catalogQuery = sql`
    SELECT projects.id AS projectId, projects.name, projects.repository_path,
      worktrees.id AS worktreeId, worktrees.path, worktrees.kind, worktrees.branch
    FROM projects JOIN worktrees ON worktrees.project_id = projects.id
    ORDER BY worktrees.id
  `
  let database: TreeportDatabase | null = null
  try {
    await fs.mkdir(path.join(historicalMigrations, 'meta'), { recursive: true })
    await fs.writeFile(
      path.join(historicalMigrations, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: baseline.migrations.map((migration, idx) => ({
          idx,
          version: '6',
          when: migration.when,
          tag: migration.tag,
          breakpoints: true
        }))
      })
    )
    await Promise.all(
      baseline.migrations.map((migration) =>
        fs.copyFile(
          path.join(migrationsFolder, `${migration.tag}.sql`),
          path.join(historicalMigrations, `${migration.tag}.sql`)
        )
      )
    )
    database = await openDatabase(filePath, {
      migrationsFolder: historicalMigrations
    })
    // Seed the historical columns directly, independent of today's ORM schema.
    await database.db.run(sql`
      INSERT INTO projects (
        id, name, repository_path, main_worktree_path, default_branch,
        repository_device, repository_inode, last_opened_at, created_at, updated_at
      ) VALUES (
        'project', 'Historical project', '/repository', '/repository', 'main',
        '1', '2', '2026-01-01', '2026-01-01', '2026-01-01'
      )
    `)
    await database.db.run(sql`
      INSERT INTO worktrees (
        id, project_id, path, kind, branch, tmux_socket_name, created_at, updated_at
      ) VALUES
        ('main', 'project', '/repository', 'main', 'main', 'old-main', '2026-01-01', '2026-01-01'),
        ('linked', 'project', '/linked', 'linked', 'topic', 'old-linked', '2026-01-01', '2026-01-01')
    `)
    const catalog = await database.db.all(catalogQuery)
    expect(catalog).toHaveLength(2)
    expect(await database.db.all(historyQuery)).toEqual(history)
    database.close()
    database = null

    database = await openDatabase(filePath)
    expect(await database.db.all(catalogQuery)).toEqual(catalog)
    expect(await database.db.all(historyQuery)).toEqual(
      migrations.map((migration) => ({
        hash: migration.hash,
        created_at: migration.folderMillis
      }))
    )
    database.close()
    database = null

    database = await openDatabase(filePath)
    await database.db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
    database.close()
    database = null

    // Exercise the schema-version boundary, not an npm installation or old CLI.
    const beforeDowngrade = await fs.readFile(filePath)
    await expect(
      openDatabase(filePath, { migrationsFolder: historicalMigrations })
    ).rejects.toThrow(/newer than this binary supports/)
    expect(await fs.readFile(filePath)).toEqual(beforeDowngrade)
  } finally {
    database?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
