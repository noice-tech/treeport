import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './core/config.js'
import { updateMigrationState, formatLocalUpdateError } from '../cli/update.js'
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
  it('preserves rollback evidence and snapshot guidance through failed and repeated startup', async () => {
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
    const config = loadConfig({
      HOME: root,
      TREEPORT_DATA_DIR: dataDir,
      TREEPORT_RUNTIME_DIR: path.join(root, 'runtime'),
      TREEPORT_DATABASE_PATH: path.join(dataDir, 'treeport.db'),
      TREEPORT_APP_VERSION: '1.2.3',
      TREEPORT_INSTANCE_ID: 'instance-1'
    })
    const reportPath = path.join(updateDirectory, 'startup-report.json')
    const initialReport = {
      schemaVersion: 1 as const,
      operationId,
      targetVersion: '1.2.3',
      instanceId: null,
      migrationState: 'not_started' as const,
      ready: false,
      error: null,
      logPath: path.join(dataDir, 'logs', 'daemon.log'),
      snapshotPaths: [],
      updatedAt: new Date().toISOString()
    }
    await fs.writeFile(reportPath, JSON.stringify(initialReport))
    const operation = {
      operationId,
      toVersion: '1.2.3',
      phase: 'restart' as const,
      migrationState: 'unknown' as const
    }
    const reporter = await createUpdateStartupReporter(config)
    await reporter.databaseOpening()
    expect(await readUpdateStartupReport(dataDir)).toMatchObject({
      operationId,
      migrationState: 'unknown',
      ready: false
    })

    const snapshot = path.join(dataDir, 'database-backups', 'snapshot.db')
    await reporter.snapshotCreated(snapshot)
    await reporter.failed(new Error('Migration failed'))
    const failed = await readUpdateStartupReport(dataDir)
    expect(failed).toMatchObject({
      error: 'Migration failed',
      snapshotPaths: [snapshot],
      ready: false
    })
    expect(updateMigrationState(operation, failed)).toBe('unknown')
    expect(
      formatLocalUpdateError('Update failed', {
        cause: failed?.error ?? undefined,
        logPath: failed?.logPath,
        snapshotPaths: failed?.snapshotPaths,
        recovery: 'Keep the new version installed.'
      })
    ).toBe(
      `Update failed\nMigration failed\nKeep the new version installed.\nDaemon log: ${initialReport.logPath}\nPre-migration snapshot: ${snapshot}`
    )

    // The process can die after a committed migration but before readiness.
    await reporter.databaseOpened({
      migrationState: 'advanced',
      snapshotPaths: [snapshot]
    })
    const retry = await createUpdateStartupReporter(config)
    await retry.databaseOpening()
    await retry.databaseOpened({
      migrationState: 'unchanged',
      snapshotPaths: []
    })
    expect(
      updateMigrationState(operation, await readUpdateStartupReport(dataDir))
    ).toBe('advanced')
    await retry.ready()

    expect(await readUpdateStartupReport(dataDir)).toMatchObject({
      operationId,
      migrationState: 'advanced',
      ready: true,
      snapshotPaths: [snapshot]
    })
    await expect(
      fs.access(path.join(updateDirectory, 'pending-startup.json'))
    ).rejects.toThrow()

    await fs.writeFile(
      path.join(updateDirectory, 'pending-startup.json'),
      JSON.stringify({
        schemaVersion: 1,
        operationId,
        targetVersion: '1.2.3',
        createdAt: new Date().toISOString()
      })
    )
    for (const previous of [
      null,
      '{bad',
      JSON.stringify({
        ...initialReport,
        operationId: '22222222-2222-4222-8222-222222222222'
      }),
      JSON.stringify({ ...initialReport, migrationState: 'unknown' })
    ]) {
      if (previous === null) {
        await fs.rm(reportPath, { force: true })
      } else {
        await fs.writeFile(reportPath, previous)
      }

      expect(
        updateMigrationState(operation, await readUpdateStartupReport(dataDir))
      ).toBe('unknown')
      const uncertain = await createUpdateStartupReporter(config)
      await uncertain.databaseOpening()
      await uncertain.databaseOpened({
        migrationState: 'unchanged',
        snapshotPaths: []
      })
      expect(
        updateMigrationState(operation, await readUpdateStartupReport(dataDir))
      ).toBe('unknown')
    }

    await fs.writeFile(reportPath, JSON.stringify(initialReport))
    const unchanged = await createUpdateStartupReporter(config)
    await unchanged.databaseOpening()
    await unchanged.databaseOpened({
      migrationState: 'unchanged',
      snapshotPaths: []
    })
    expect(
      updateMigrationState(operation, await readUpdateStartupReport(dataDir))
    ).toBe('unchanged')
    expect(
      updateMigrationState(
        { ...operation, migrationState: 'advanced' },
        await readUpdateStartupReport(dataDir)
      )
    ).toBe('advanced')
    expect(
      updateMigrationState(
        { ...operation, phase: 'activate', migrationState: 'not_started' },
        null
      )
    ).toBe('not_started')
  })
})
