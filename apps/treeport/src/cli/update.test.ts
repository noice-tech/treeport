import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLocalUpdateProgress } from './update'

describe('local update progress', () => {
  it('reports a live durable operation without changing its recovery state', async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-update-progress-')
    )
    const updateDirectory = path.join(dataDir, 'updates')
    await fs.mkdir(updateDirectory)
    const operationId = crypto.randomUUID()
    const operation = {
      schemaVersion: 1,
      operationId,
      phase: 'health_check',
      fromVersion: '0.4.0',
      toVersion: '0.5.0',
      npmPrefix: '/npm',
      activeTarget: '/npm/lib/treeport/versions/0.5.0',
      stagedTarget: '/npm/lib/treeport/versions/0.5.0',
      previousTarget: '/npm',
      daemonWasRunning: true,
      daemonLifecycle: 'treeport',
      serviceMode: null,
      terminalIds: ['term_1'],
      activated: true,
      migrationState: 'unchanged',
      rollbackAttempted: false,
      rollbackSucceeded: false,
      recoveryAction: 'Keep this recovery action.',
      updatedAt: '2026-03-20T12:00:00.000Z'
    }
    const operationContents = `${JSON.stringify(operation)}\n`
    await fs.writeFile(
      path.join(updateDirectory, 'operation.json'),
      operationContents
    )
    await fs.writeFile(
      path.join(updateDirectory, 'update.lock'),
      JSON.stringify({
        operationId,
        pid: process.pid,
        fromVersion: '0.4.0',
        startedAt: '2026-03-20T11:59:00.000Z'
      })
    )

    expect(await readLocalUpdateProgress(dataDir)).toEqual({
      active: true,
      operationId,
      phase: 'health_check',
      fromVersion: '0.4.0',
      toVersion: '0.5.0',
      recoveryAction: 'Keep this recovery action.',
      migrationState: 'unchanged'
    })
    expect(
      await fs.readFile(path.join(updateDirectory, 'operation.json'), 'utf8')
    ).toBe(operationContents)

    await fs.rm(path.join(updateDirectory, 'update.lock'))
    expect(await readLocalUpdateProgress(dataDir)).toMatchObject({
      active: false,
      operationId,
      phase: 'health_check'
    })

    await fs.writeFile(path.join(updateDirectory, 'operation.json'), '{bad')
    expect(await readLocalUpdateProgress(dataDir)).toEqual({
      active: false,
      operationId: null,
      phase: null,
      fromVersion: null,
      toVersion: null,
      recoveryAction: null,
      migrationState: null
    })

    await fs.rm(dataDir, { recursive: true, force: true })
  })
})
