import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deserializeOperation,
  serializeOperation,
  TreeportDatabase
} from './database'

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
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-db-'))
    directories.push(directory)
    const database = new TreeportDatabase(path.join(directory, 'metadata.db'))
    databases.push(database)
    const request = {
      branch: 'feature/üñîçødé',
      argv: ['echo', 'a b', 'x;y', '$HOME', '"quoted"']
    }
    database.connection
      .prepare(
        `INSERT INTO operations(id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at)
         VALUES('op_1','finish',NULL,NULL,'pending',?,NULL,NULL,'2026-01-01','2026-01-01')`
      )
      .run(serializeOperation(request))
    expect(database.operation('op_1')).toMatchObject({
      id: 'op_1',
      kind: 'finish',
      status: 'pending',
      request
    })
    expect(deserializeOperation(serializeOperation(request))).toEqual(request)
    expect(database.connection.pragma('journal_mode', { simple: true })).toBe(
      'wal'
    )
    expect(
      database.connection
        .prepare("SELECT count(*) FROM sqlite_master WHERE name='terminals'")
        .pluck()
        .get()
    ).toBe(0)
  })

  it('persists literal preset argv, deterministic order, updates, and deletion', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-db-'))
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const database = new TreeportDatabase(filePath)
    databases.push(database)
    database.insertTerminalPreset({
      id: 'preset_b',
      name: 'Second by ID',
      executable: '/Applications/Tool with spaces/bin/tool',
      args: ['a b', '"quote"', 'semi;colon', '$HOME', 'Unicode 世界', ''],
      closeOnSuccess: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    database.insertTerminalPreset({
      id: 'preset_a',
      name: 'First by ID',
      executable: 'pi',
      args: [],
      closeOnSuccess: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    database.insertTerminalPreset({
      id: 'preset_c',
      name: 'Created later',
      executable: 'npx',
      args: ['--yes'],
      closeOnSuccess: false,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    })

    expect(database.terminalPresets().map((preset) => preset.id)).toEqual([
      'preset_a',
      'preset_b',
      'preset_c'
    ])
    const updated = {
      ...database.terminalPreset('preset_b')!,
      name: 'Updated',
      args: ['literal;value', '$NOT_EXPANDED'],
      updatedAt: '2026-01-03T00:00:00.000Z'
    }
    expect(
      database.updateTerminalPreset(updated, '2026-01-01T00:00:00.000Z')
    ).toBe(true)
    expect(
      database.deleteTerminalPreset('preset_a', '2026-01-01T00:00:00.000Z')
    ).toBe(true)
    expect(
      database.deleteTerminalPreset(
        'preset_missing',
        '2026-01-01T00:00:00.000Z'
      )
    ).toBe(false)
    database.close()
    databases.splice(databases.indexOf(database), 1)

    const reopened = new TreeportDatabase(filePath)
    databases.push(reopened)
    expect(reopened.terminalPresets()).toEqual([
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
    const database = new TreeportDatabase(path.join(directory, 'metadata.db'))
    databases.push(database)
    const insert = database.connection.prepare(
      `INSERT INTO projects(
         id,name,repository_path,main_worktree_path,default_branch,color,
         repository_device,repository_inode,name_is_custom,is_open,last_opened_at,
         created_at,updated_at
       ) VALUES(?,?,?,?,?,'blue',?,?,0,?,?,?,?)`
    )
    insert.run(
      'p_old',
      'Old',
      '/old',
      '/old',
      'main',
      '1',
      '1',
      0,
      '2026-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z'
    )
    insert.run(
      'p_new',
      'New',
      '/new',
      '/new',
      'main',
      '2',
      '2',
      0,
      '2026-02-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z'
    )
    insert.run(
      'p_open',
      'Open',
      '/open',
      '/open',
      'main',
      '3',
      '3',
      1,
      '2026-03-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z'
    )

    expect(
      database
        .projects()
        .map((project) => project.id)
        .sort()
    ).toEqual(['p_new', 'p_old', 'p_open'])
    expect(database.openProjects().map((project) => project.id)).toEqual([
      'p_open'
    ])
    expect(database.recentProjects()).toEqual([
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
    expect('worktrees' in database.recentProjects()[0]!).toBe(false)

    database.setProjectOpen('p_old', true, '2026-04-01T00:00:00.000Z')
    database.setProjectOpen('p_open', false, '2026-05-01T00:00:00.000Z')
    expect(database.isProjectOpen('p_old')).toBe(true)
    expect(database.isProjectOpen('p_open')).toBe(false)
    expect(database.recentProjects().map((project) => project.id)).toEqual([
      'p_open',
      'p_new'
    ])
    expect(
      database.connection
        .prepare('SELECT last_opened_at FROM projects WHERE id = ?')
        .pluck()
        .get('p_open')
    ).toBe('2026-03-01T00:00:00.000Z')
  })

  it('keeps the main worktree first and linked worktrees in creation order', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-db-'))
    directories.push(directory)
    const database = new TreeportDatabase(path.join(directory, 'metadata.db'))
    databases.push(database)
    database.connection
      .prepare(
        `INSERT INTO projects(
           id,name,repository_path,main_worktree_path,default_branch,color,
           repository_device,repository_inode,name_is_custom,is_open,last_opened_at,
           created_at,updated_at
         ) VALUES('p_order','Ordered','/ordered','/ordered','main',NULL,
           '1','1',0,1,'2026-01-01','2026-01-01','2026-01-01')`
      )
      .run()
    const insertWorktree = database.connection.prepare(
      `INSERT INTO worktrees(
         id,project_id,path,kind,tmux_socket_name,status,created_at,updated_at
       ) VALUES(?,'p_order',?,?,?,'active',?,?)`
    )
    const insert = (
      id: string,
      worktreePath: string,
      kind: 'main' | 'linked',
      createdAt: string
    ) =>
      insertWorktree.run(
        id,
        worktreePath,
        kind,
        `socket-${id}`,
        createdAt,
        createdAt
      )

    insert('wt_newest', '/ordered-newest', 'linked', '2026-03-01')
    insert('wt_main', '/ordered', 'main', '2026-04-01')
    insert('wt_oldest', '/ordered-oldest', 'linked', '2026-01-01')
    insert('wt_same_a', '/ordered-same-a', 'linked', '2026-02-01')
    insert('wt_same_b', '/ordered-same-b', 'linked', '2026-02-01')

    expect(
      database.project('p_order')!.worktrees.map((worktree) => worktree.id)
    ).toEqual(['wt_main', 'wt_oldest', 'wt_same_a', 'wt_same_b', 'wt_newest'])
  })

  it('upgrades a version-7 database without reapplying the baseline', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-v7-')
    )
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const initial = new TreeportDatabase(filePath)
    initial.connection.exec(
      'DROP INDEX terminal_presets_order_idx; DROP TABLE terminal_presets; DELETE FROM schema_migrations WHERE version IN (8, 9);'
    )
    initial.connection
      .prepare(
        `INSERT INTO projects(
           id,name,repository_path,main_worktree_path,default_branch,color,
           repository_device,repository_inode,name_is_custom,is_open,last_opened_at,
           created_at,updated_at
         ) VALUES(?,?,?,?,?,NULL,?,?,0,1,?,?,?)`
      )
      .run(
        'p_existing',
        'Existing',
        '/existing',
        '/existing',
        'main',
        '1',
        '2',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    initial.close()

    const reopened = new TreeportDatabase(filePath)
    databases.push(reopened)
    expect(
      reopened.connection
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .pluck()
        .all()
    ).toEqual([7, 8, 9, 10])
    expect(
      reopened.connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .pluck()
        .all()
    ).toEqual([
      'operations',
      'projects',
      'schema_migrations',
      'terminal_presets',
      'worktrees'
    ])
    expect(reopened.project('p_existing')).toMatchObject({
      id: 'p_existing',
      name: 'Existing',
      repositoryPath: '/existing'
    })
  })

  it('repairs a missing preset table when version 8 was already recorded', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-db-v8-')
    )
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const initial = new TreeportDatabase(filePath)
    initial.connection.exec(
      'DROP INDEX terminal_presets_order_idx; DROP TABLE terminal_presets; DELETE FROM schema_migrations WHERE version >= 9;'
    )
    initial.close()

    const reopened = new TreeportDatabase(filePath)
    databases.push(reopened)
    expect(
      reopened.connection
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .pluck()
        .all()
    ).toEqual([7, 8, 9, 10])
    expect(
      reopened.connection
        .prepare(
          "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='terminal_presets'"
        )
        .pluck()
        .get()
    ).toBe(1)
  })
})
