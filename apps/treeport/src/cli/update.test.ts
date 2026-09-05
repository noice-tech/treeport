import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readLocalUpdateProgress, runLocalUpdate } from './update'
import * as lifecycle from './lifecycle'
import * as service from './service'

describe('local update progress', () => {
  it('refuses an interrupted rollback without startup evidence and leaves the active package intact', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-interrupted-update-')
    )
    const prefix = path.join(root, 'prefix')
    const dataDir = path.join(root, 'data')
    const packageDirectory = path.join(
      prefix,
      'lib/node_modules/@treeport/treeport'
    )
    const entrypoint = path.join(prefix, 'bin/treeport')
    const updateDirectory = path.join(dataDir, 'updates')
    const environment = {
      ...process.env,
      TREEPORT_API_URL: '',
      TREEPORT_DAEMON_LIFECYCLE: 'treeport',
      TREEPORT_CLI_ENTRYPOINT: entrypoint,
      TREEPORT_DATA_DIR: dataDir,
      TREEPORT_RUNTIME_DIR: path.join(root, 'runtime'),
      PATH: `${path.join(prefix, 'bin')}:${process.env.PATH}`
    }
    try {
      await fs.mkdir(packageDirectory, { recursive: true })
      await fs.mkdir(path.dirname(entrypoint), { recursive: true })
      await fs.mkdir(updateDirectory, { recursive: true })
      const manifestPath = path.join(packageDirectory, 'package.json')
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ name: '@treeport/treeport', version: '1.2.3' })
      )
      await fs.writeFile(entrypoint, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
      await fs.writeFile(
        path.join(prefix, 'bin/npm'),
        `#!/bin/sh\nif [ "$1" = prefix ]; then printf '%s\\n' '${prefix}'; else printf '%s' '{"name":"@treeport/treeport","version":"1.2.3","dist":{"tarball":"https://registry.example/treeport.tgz","integrity":"sha512-test"}}'; fi\n`,
        { mode: 0o755 }
      )
      vi.spyOn(lifecycle, 'resolvePackagePath').mockResolvedValue(manifestPath)
      vi.spyOn(lifecycle, 'daemonStatus').mockResolvedValue({
        running: false,
        state: null,
        health: null,
        verified: false
      })
      const stop = vi
        .spyOn(lifecycle, 'daemonDown')
        .mockResolvedValue({ wasRunning: false })
      vi.spyOn(service, 'serviceInstalled').mockResolvedValue(false)
      const operationId = crypto.randomUUID()
      const operation = {
        schemaVersion: 1,
        operationId,
        phase: 'restart',
        fromVersion: '1.2.2',
        toVersion: '1.2.3',
        npmPrefix: prefix,
        activeTarget: prefix,
        stagedTarget: prefix,
        previousTarget: path.join(root, 'older'),
        daemonWasRunning: true,
        daemonLifecycle: 'treeport',
        serviceMode: null,
        terminalIds: [],
        activated: true,
        migrationState: 'not_started',
        rollbackAttempted: false,
        rollbackSucceeded: false,
        recoveryAction: null,
        updatedAt: new Date().toISOString()
      }
      for (const report of [
        null,
        '{broken',
        JSON.stringify({
          schemaVersion: 1,
          operationId: crypto.randomUUID(),
          targetVersion: '1.2.3',
          instanceId: null,
          migrationState: 'unchanged',
          ready: false,
          error: null,
          logPath: '/logs',
          snapshotPaths: [],
          updatedAt: new Date().toISOString()
        })
      ]) {
        await fs.writeFile(
          path.join(updateDirectory, 'operation.json'),
          JSON.stringify(operation)
        )
        if (report !== null) {
          await fs.writeFile(
            path.join(updateDirectory, 'startup-report.json'),
            report
          )
        }

        await expect(runLocalUpdate({ environment })).rejects.toMatchObject({
          code: 'UPDATE_RECOVERY_REQUIRED',
          details: { migrationState: 'unknown' }
        })
        await expect(
          fs.readlink(path.join(prefix, 'lib/treeport/current'))
        ).rejects.toMatchObject({ code: 'ENOENT' })
        expect(
          JSON.parse(await fs.readFile(manifestPath, 'utf8')).version
        ).toBe('1.2.3')
      }
      expect(stop).toHaveBeenCalledTimes(3)
    } finally {
      vi.restoreAllMocks()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('does not treat a daemon that is migrating before listening as stopped', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-starting-daemon-')
    )
    vi.stubEnv('TREEPORT_DATA_DIR', root)
    vi.stubEnv('TREEPORT_RUNTIME_DIR', path.join(root, 'runtime'))
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Not listening yet')
    )
    const lock = path.join(root, 'daemon.lock')
    const record = {
      pid: process.pid,
      instanceId: crypto.randomUUID(),
      version: '1.2.3',
      apiUrl: 'http://127.0.0.1:1',
      dataDir: root,
      startedAt: new Date().toISOString(),
      installationMethod: 'npm',
      daemonLifecycle: 'treeport'
    }
    try {
      await fs.writeFile(lock, JSON.stringify(record))
      expect(await lifecycle.daemonStatus()).toMatchObject({
        running: false,
        verified: false,
        state: record
      })
      await expect(lifecycle.daemonDown()).rejects.toThrow(
        'could not verify ownership'
      )
      expect(JSON.parse(await fs.readFile(lock, 'utf8'))).toEqual(record)
      await fs.writeFile(lock, '{broken')
      await expect(lifecycle.daemonDown()).rejects.toThrow(
        'Cannot verify daemon ownership'
      )
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

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
