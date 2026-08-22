import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './core/config.js'
import {
  createUpdateStartupReporter,
  readUpdateStartupReport
} from './update-startup.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('update startup reporting', () => {
  it('records database compatibility and removes the pending marker only when ready', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-update-'))
    directories.push(root)
    const dataDir = path.join(root, 'data')
    const operationId = '11111111-1111-4111-8111-111111111111'
    const updateDirectory = path.join(dataDir, 'updates')
    await fs.mkdir(updateDirectory, { recursive: true })
    await fs.writeFile(
      path.join(updateDirectory, 'pending-startup.json'),
      JSON.stringify({
        schemaVersion: 1,
        operationId,
        targetVersion: '1.2.3',
        createdAt: '2026-01-01T00:00:00.000Z'
      })
    )
    const reporter = await createUpdateStartupReporter(
      loadConfig({
        HOME: root,
        TREEPORT_DATA_DIR: dataDir,
        TREEPORT_RUNTIME_DIR: path.join(root, 'runtime'),
        TREEPORT_DATABASE_PATH: path.join(dataDir, 'treeport.db'),
        TREEPORT_APP_VERSION: '1.2.3',
        TREEPORT_INSTANCE_ID: 'instance-1'
      })
    )

    await reporter.databaseOpening()
    expect(await readUpdateStartupReport(dataDir)).toMatchObject({
      operationId,
      migrationState: 'unknown',
      ready: false
    })

    const snapshot = path.join(dataDir, 'database-backups', 'snapshot.db')
    await reporter.databaseOpened({
      migrationState: 'advanced',
      snapshotPaths: [snapshot]
    })
    await reporter.ready()

    expect(await readUpdateStartupReport(dataDir)).toMatchObject({
      operationId,
      migrationState: 'advanced',
      ready: true,
      snapshotPaths: [snapshot]
    })
    await expect(
      fs.access(path.join(updateDirectory, 'pending-startup.json'))
    ).rejects.toThrow()
  })
})
