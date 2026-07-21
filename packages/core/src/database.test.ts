import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deserializeOperation,
  serializeOperation,
  TaskTTYDatabase
} from './database.js'

const databases: TaskTTYDatabase[] = []
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
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty-db-'))
    directories.push(directory)
    const database = new TaskTTYDatabase(path.join(directory, 'metadata.db'))
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
    expect(
      database.connection
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .pluck()
        .all()
    ).toEqual([7])
  })

  it('reopens an already-version-7 database without reapplying the baseline', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty-db-v7-'))
    directories.push(directory)
    const filePath = path.join(directory, 'metadata.db')
    const initial = new TaskTTYDatabase(filePath)
    initial.close()

    const reopened = new TaskTTYDatabase(filePath)
    databases.push(reopened)
    expect(
      reopened.connection
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .pluck()
        .all()
    ).toEqual([7])
    expect(
      reopened.connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .pluck()
        .all()
    ).toEqual(['operations', 'projects', 'schema_migrations', 'worktrees'])
  })
})
