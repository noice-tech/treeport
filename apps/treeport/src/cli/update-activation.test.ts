import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runLocalUpdate } from './update'
import { updateFixture } from './update.test-support'

describe('update activation and rollback', () => {
  it.each([false, true])(
    'stages, verifies, stops, switches and restarts with preserved inventory (service=%s)',
    async (service) => {
      const fixture = await updateFixture({ running: true, service })
      const result = await runLocalUpdate({
        environment: fixture.environment,
        yes: true
      })
      expect(result).toMatchObject({
        status: 'updated',
        fromVersion: '1.2.3',
        toVersion: '1.2.4',
        daemon: {
          wasRunning: true,
          lifecycle: service ? 'service' : 'treeport',
          restarted: true,
          healthy: true,
          version: '1.2.4'
        },
        terminals: { before: 1, after: 1, preserved: true },
        rollback: { attempted: false }
      })
      const events = await fixture.events()
      const managedRoot = path.join(fixture.prefix, 'lib/treeport')
      const download = path.join(managedRoot, `.download-${result.operationId}`)
      const staging = path.join(
        managedRoot,
        `.staging-1.2.4-${result.operationId}`
      )
      expect(events.slice(0, 4)).toEqual([
        { command: 'npm', args: ['prefix', '--global'] },
        {
          command: 'npm',
          args: ['view', '@treeport/treeport@latest', '--json']
        },
        {
          command: 'npm',
          args: [
            'pack',
            '@treeport/treeport@1.2.4',
            '--json',
            '--ignore-scripts',
            '--pack-destination',
            download
          ]
        },
        {
          command: 'npm',
          args: [
            'install',
            '--global',
            '--prefix',
            staging,
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            path.join(download, 'release.tgz')
          ]
        }
      ])
      expect(events.map((event) => event.command)).toEqual([
        'npm',
        'npm',
        'npm',
        'npm',
        'version',
        'stop',
        'start'
      ])
      expect(events[4]).toMatchObject({
        command: 'version',
        args: ['version', '--json'],
        phase: 'verify',
        current: null,
        entrypoint: path.join(staging, 'bin/treeport'),
        apiUrl: ''
      })
      expect(events[4].dataDir).not.toBe(fixture.dataDir)
      expect(path.dirname(events[4].dataDir)).toBe(
        path.dirname(events[4].runtimeDir)
      )
      await expect(
        fs.access(path.dirname(events[4].dataDir))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(events[5]).toMatchObject({
        command: 'stop',
        phase: 'stop',
        current: null
      })
      expect(events[6]).toMatchObject({
        command: 'start',
        args: ['start', '--json'],
        phase: 'restart',
        current: await fs.realpath(fixture.target),
        version: '1.2.4',
        entrypoint: fixture.entrypoint,
        dataDir: fixture.dataDir
      })
      expect(await fs.realpath(fixture.current)).toBe(
        await fs.realpath(fixture.target)
      )
      expect((await fs.lstat(fixture.entrypoint)).isSymbolicLink()).toBe(false)
      expect((await fs.stat(fixture.entrypoint)).mode & 0o111).toBe(0o111)
      expect(await fs.readFile(fixture.entrypoint, 'utf8')).toContain(
        'TREEPORT_MANAGED_LAUNCHER=1'
      )
      expect(await fixture.operation()).toMatchObject({
        phase: 'complete',
        activated: true,
        terminalIds: ['terminal'],
        migrationState: 'unchanged'
      })
      expect(fixture.inventory).toHaveBeenCalledTimes(2)
      // daemonDown/serviceStop are the non-destructive stop boundaries; no terminate command is issued.
      expect(
        service ? fixture.serviceStop : fixture.down
      ).toHaveBeenCalledExactlyOnceWith()
      expect(
        service ? fixture.down : fixture.serviceStop
      ).not.toHaveBeenCalled()
      if (service) {
        expect(fixture.serviceStatus).toHaveBeenCalledTimes(3)
      }

      await expect(fs.access(download)).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await expect(fs.access(staging)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('switches a stopped installation without starting a daemon, then resolves the managed current version', async () => {
    const fixture = await updateFixture()
    expect(
      await runLocalUpdate({ environment: fixture.environment })
    ).toMatchObject({
      status: 'updated',
      daemon: { wasRunning: false, restarted: false }
    })
    expect(
      await runLocalUpdate({ environment: fixture.environment })
    ).toMatchObject({
      status: 'current',
      fromVersion: '1.2.4',
      daemon: { restarted: false }
    })
    expect(fixture.down).not.toHaveBeenCalled()
    expect(
      (await fixture.events()).filter((event) => event.command === 'start')
    ).toEqual([])
    const version = await promisify(execFile)(
      fixture.entrypoint,
      ['version', '--json'],
      { env: fixture.environment }
    )
    expect(JSON.parse(version.stdout)).toEqual({ cli: '1.2.4', daemon: null })
  })

  it.each(['not_started', 'unchanged'])(
    'rolls back a failed start only with matching safe %s evidence',
    async (evidence) => {
      const fixture = await updateFixture({
        running: true,
        startFailure: true,
        evidence
      })
      await expect(
        runLocalUpdate({ environment: fixture.environment, yes: true })
      ).rejects.toMatchObject({
        code: 'UPDATE_ROLLED_BACK',
        details: {
          phase: 'restart',
          migrationState: evidence,
          rollback: { attempted: true, safe: true, succeeded: true }
        }
      })
      expect(await fs.realpath(fixture.current)).toBe(
        await fs.realpath(fixture.prefix)
      )
      const events = (await fixture.events()).filter((event) =>
        ['stop', 'start'].includes(event.command)
      )
      expect(events.map((event) => [event.command, event.phase])).toEqual([
        ['stop', 'stop'],
        ['start', 'restart'],
        ['stop', 'restart'],
        ['start', 'rollback']
      ])
      expect(events.at(-1)).toMatchObject({
        version: '1.2.3',
        entrypoint: fixture.entrypoint
      })
      await expect(
        fs.access(path.join(fixture.updateDirectory, 'pending-startup.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fixture.operation()).toMatchObject({
        phase: 'rollback',
        rollbackAttempted: true,
        rollbackSucceeded: true
      })
    }
  )

  it.each([
    'advanced',
    'unknown',
    'missing',
    'malformed',
    'wrong-operation',
    'wrong-target',
    'stop-failure'
  ])(
    'keeps the new binary and refuses rollback without safe evidence: %s',
    async (evidence) => {
      const fixture = await updateFixture({
        running: true,
        startFailure: true,
        evidence: evidence === 'stop-failure' ? 'unchanged' : evidence,
        stopFailure: evidence === 'stop-failure'
      })
      await expect(
        runLocalUpdate({ environment: fixture.environment, yes: true })
      ).rejects.toMatchObject({
        code: 'UPDATE_RECOVERY_REQUIRED',
        details: {
          rollback: { attempted: false, safe: false, succeeded: false },
          migrationState:
            evidence === 'advanced'
              ? 'advanced'
              : evidence === 'stop-failure'
                ? 'unchanged'
                : 'unknown'
        }
      })
      expect(await fs.realpath(fixture.current)).toBe(
        await fs.realpath(fixture.target)
      )
      expect(
        (await fixture.events())
          .filter((event) => event.command === 'start')
          .map((event) => event.version)
      ).toEqual(['1.2.4'])
      expect(fixture.down).toHaveBeenCalledTimes(2)
      expect(await fixture.operation()).toMatchObject({
        phase: 'recovery_required',
        rollbackAttempted: false
      })
      await expect(
        fs.access(path.join(fixture.updateDirectory, 'update.lock'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('does not report a successful rollback when terminal recovery fails', async () => {
    const fixture = await updateFixture({
      running: true,
      startFailure: true,
      missingTerminal: true
    })
    await expect(
      runLocalUpdate({ environment: fixture.environment, yes: true })
    ).rejects.toMatchObject({
      code: 'UPDATE_ROLLBACK_FAILED',
      details: { rollback: { attempted: true, safe: true, succeeded: false } }
    })
    expect(await fixture.operation()).toMatchObject({
      phase: 'recovery_required',
      rollbackSucceeded: false
    })
  })

  it('does not report terminal preservation when a session is missing after restart', async () => {
    const fixture = await updateFixture({
      running: true,
      missingTerminal: true,
      evidence: 'advanced'
    })
    await expect(
      runLocalUpdate({ environment: fixture.environment, yes: true })
    ).rejects.toMatchObject({
      code: 'UPDATE_RECOVERY_REQUIRED',
      details: {
        phase: 'health_check',
        migrationState: 'advanced',
        cause:
          'Treeport restarted, but one or more terminal sessions were not recovered.'
      }
    })
    expect(await fs.realpath(fixture.current)).toBe(
      await fs.realpath(fixture.target)
    )
  })
})
