import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { confirmLocalUpdate, runLocalUpdate } from './update'
import * as lifecycle from './lifecycle'
import { runCliApplication } from './application'
import { updateFixture } from './update.test-support'

describe('update confirmation prompt', () => {
  it.each(['yes', 'no', 'eof', 'abort'] as const)(
    'handles %s without hanging',
    async (answer) => {
      const input = new PassThrough()
      const output = new PassThrough()
      let text = ''
      output.on('data', (chunk) => {
        text += chunk.toString()
      })
      const controller = new AbortController()
      const result = confirmLocalUpdate(
        {
          fromVersion: '1.2.3',
          toVersion: '1.2.4',
          daemonWasRunning: true,
          startRequested: false,
          recovery: false
        },
        controller.signal,
        input,
        output
      )
      if (answer === 'abort') {
        controller.abort()
      } else if (answer === 'eof') {
        input.end()
      } else {
        input.write(`${answer}\n`)
      }

      expect(await result).toBe(answer === 'yes')
      expect(text).toContain('1.2.3 -> 1.2.4')
      expect(text).toContain(
        'Clients can briefly disconnect. Terminal sessions are preserved.'
      )
      input.destroy()
      output.destroy()
    }
  )
})

describe('update CLI wiring', () => {
  it.each([{ args: ['update', '--json'] }, { args: ['update'] }])(
    'requires consent without prompting: %j',
    async ({ args }) => {
      const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true
      })
      onTestFinished(() => {
        if (tty) {
          Object.defineProperty(process.stdin, 'isTTY', tty)
        } else {
          Reflect.deleteProperty(process.stdin, 'isTTY')
        }
      })
      const fixture = await updateFixture({ running: true })
      vi.spyOn(lifecycle, 'resolveLocalApiUrl').mockResolvedValue(
        'http://127.0.0.1:1'
      )
      let stderr = ''
      const code = await runCliApplication({
        args: [...args],
        environment: {
          ...fixture.environment,
          FORCE_COLOR: '1',
          NO_COLOR: undefined
        },
        stdout: () => undefined,
        stderr: (value) => {
          stderr += value
        }
      })
      expect(code).toBe(5)
      if (args.includes('--json')) {
        expect(stderr).not.toContain('\u001b')
        expect(JSON.parse(stderr)).toMatchObject({
          error: {
            code: 'UPDATE_CONFIRMATION_REQUIRED',
            details: { fromVersion: '1.2.3', toVersion: '1.2.4' }
          }
        })
      } else {
        expect(stderr).toContain('treeport update --yes')
      }

      await fixture.unchanged()
    }
  )

  it('wires --yes and --start to a verified self-update in JSON mode', async () => {
    const fixture = await updateFixture()
    vi.spyOn(lifecycle, 'resolveLocalApiUrl').mockResolvedValue(
      'http://127.0.0.1:1'
    )
    let stdout = ''
    let stderr = ''
    const code = await runCliApplication({
      args: ['update', '--yes', '--start', '--json'],
      environment: {
        ...fixture.environment,
        FORCE_COLOR: '1',
        NO_COLOR: undefined
      },
      stdout: (value) => {
        stdout += value
      },
      stderr: (value) => {
        stderr += value
      }
    })
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).not.toContain('\u001b')
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'updated',
      daemon: { wasRunning: false, restarted: true, healthy: true }
    })
  })

  it.each([
    { flags: ['--packages', '--start'] },
    { flags: ['npm:example', '--yes'] }
  ])(
    'rejects self-update flags with package updates: %j',
    async ({ flags }) => {
      const fixture = await updateFixture()
      vi.spyOn(lifecycle, 'resolveLocalApiUrl').mockResolvedValue(
        'http://127.0.0.1:1'
      )
      const code = await runCliApplication({
        args: ['update', ...flags],
        environment: fixture.environment,
        stdout: () => undefined,
        stderr: () => undefined
      })
      expect(code).toBe(2)
      expect(fixture.inventory).not.toHaveBeenCalled()
      expect(await fixture.events()).toEqual([])
    }
  )
})

describe('local update contracts', () => {
  it.each(['decline', 'interrupt'] as const)(
    'leaves daemon and installed version unchanged on confirmation %s',
    async (decision) => {
      const fixture = await updateFixture({ running: true })
      const confirm = vi.fn(async (preview, signal: AbortSignal) => {
        expect(preview).toMatchObject({
          fromVersion: '1.2.3',
          toVersion: '1.2.4',
          daemonWasRunning: true
        })
        expect(fixture.down).not.toHaveBeenCalled()
        if (decision === 'interrupt') {
          process.emit('SIGINT')
          expect(signal.aborted).toBe(true)
          return true
        }

        return false
      })
      await expect(
        runLocalUpdate({ environment: fixture.environment, confirm })
      ).rejects.toMatchObject({ code: 'UPDATE_CANCELLED', exitCode: 130 })
      expect(confirm).toHaveBeenCalledOnce()
      await fixture.unchanged()
    }
  )

  it('cancels during staging without changing the daemon or installation', async () => {
    const fixture = await updateFixture({ running: true })
    await expect(
      runLocalUpdate({
        environment: fixture.environment,
        yes: true,
        progress: (message) => {
          if (message.startsWith('Downloading')) {
            process.emit('SIGTERM')
          }
        }
      })
    ).rejects.toMatchObject({ code: 'UPDATE_INTERRUPTED' })
    await fixture.unchanged()
  })

  it('accepts interactive consent and verifies before stopping', async () => {
    const fixture = await updateFixture({ running: true })
    const confirm = vi.fn(async () => true)
    expect(
      await runLocalUpdate({ environment: fixture.environment, confirm })
    ).toMatchObject({ status: 'updated', daemon: { healthy: true } })
    expect(confirm).toHaveBeenCalledOnce()
    const commands = (await fixture.events()).map((event) => event.command)
    expect(commands.indexOf('version')).toBeLessThan(commands.indexOf('stop'))
  })

  it('does not prompt for the current version, even with --start', async () => {
    const fixture = await updateFixture({ latest: '1.2.3' })
    const confirm = vi.fn(async () => false)
    expect(
      await runLocalUpdate({
        environment: fixture.environment,
        confirm,
        start: true
      })
    ).toMatchObject({ status: 'current', daemon: { restarted: false } })
    expect(confirm).not.toHaveBeenCalled()
    await fixture.unchanged()
  })

  it.each(['user', 'headless'] as const)(
    'restarts an intended-running unhealthy %s service without administrator action',
    async (serviceMode) => {
      const fixture = await updateFixture({ service: true, serviceMode })
      expect(
        await runLocalUpdate({ environment: fixture.environment, yes: true })
      ).toMatchObject({
        daemon: {
          wasRunning: true,
          restarted: true,
          healthy: true,
          lifecycle: 'service'
        }
      })
      expect(fixture.serviceStop).toHaveBeenCalledOnce()
      expect(fixture.down).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'awaits stopped-service shutdown acknowledgement before activation, with --start=%s',
    async (start) => {
      const fixture = await updateFixture({
        service: true,
        requestedState: 'stopped'
      })
      const stop = fixture.serviceStop.getMockImplementation()!
      let enter!: () => void
      let acknowledge!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const acknowledgement = new Promise<void>((resolve) => {
        acknowledge = resolve
      })
      fixture.serviceStop.mockImplementationOnce(async () => {
        // serviceStop must drain a launch that was already
        // in flight, even when requestedState and daemonStatus say stopped.
        await fs.writeFile(path.join(fixture.root, 'started'), '1.2.3')
        enter()
        await acknowledgement
        return stop()
      })
      const updating = runLocalUpdate({
        environment: fixture.environment,
        yes: true,
        start
      })
      try {
        await Promise.race([
          entered,
          updating.then(() => {
            throw new Error(
              'Update completed without supervisor acknowledgement'
            )
          })
        ])
        expect(await fixture.operation()).toMatchObject({
          phase: 'stop',
          activated: false
        })
        await expect(fs.lstat(fixture.current)).rejects.toMatchObject({
          code: 'ENOENT'
        })
        expect(await fs.readlink(fixture.entrypoint)).toBe(
          path.join(fixture.packageDirectory, 'bin/treeport.mjs')
        )
        expect(await fixture.status()).toMatchObject({
          running: true,
          health: { version: '1.2.3' }
        })
        const events = await fixture.events()
        expect(events.at(-1)).toMatchObject({
          command: 'version',
          phase: 'verify'
        })
        expect(events.some((event) => event.command === 'start')).toBe(false)
      } finally {
        acknowledge()
        await updating
      }
      expect(await updating).toMatchObject({
        daemon: { wasRunning: false, restarted: start, healthy: start }
      })
      expect(await fixture.status()).toMatchObject({ running: start })
      expect(fixture.serviceStop).toHaveBeenCalledExactlyOnceWith()
      expect(fixture.down).not.toHaveBeenCalled()
      expect(
        (await fixture.events()).filter((event) => event.command === 'start')
      ).toHaveLength(start ? 1 : 0)
    }
  )

  it('refuses activation or rollback without a stopped-service shutdown acknowledgement', async () => {
    const fixture = await updateFixture({
      service: true,
      requestedState: 'stopped'
    })
    fixture.serviceStop.mockRejectedValue(
      new Error('Supervisor shutdown was not acknowledged')
    )
    await expect(
      runLocalUpdate({ environment: fixture.environment, yes: true })
    ).rejects.toMatchObject({
      code: 'UPDATE_RECOVERY_REQUIRED',
      details: {
        phase: 'stop',
        rollback: { attempted: false, safe: false, succeeded: false }
      }
    })
    expect(fixture.serviceStop).toHaveBeenCalledTimes(2)
    expect(fixture.down).not.toHaveBeenCalled()
    await expect(fs.lstat(fixture.current)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await fs.readlink(fixture.entrypoint)).toBe(
      path.join(fixture.packageDirectory, 'bin/treeport.mjs')
    )
    expect(
      (await fixture.events()).filter((event) => event.command === 'start')
    ).toEqual([])
  })

  it('restores the intentionally stopped state if an explicit start fails safely', async () => {
    const fixture = await updateFixture({ startFailure: true })
    await expect(
      runLocalUpdate({
        environment: fixture.environment,
        yes: true,
        start: true
      })
    ).rejects.toMatchObject({
      code: 'UPDATE_ROLLED_BACK',
      details: { rollback: { succeeded: true } }
    })
    expect(
      (await fixture.events()).filter((event) => event.command === 'start')
    ).toHaveLength(1)
    expect(await fixture.status()).toMatchObject({ running: false })
    expect(await fs.realpath(fixture.current)).toBe(
      await fs.realpath(fixture.prefix)
    )
  })

  it('surfaces legacy service migration instructions before staging or stopping', async () => {
    const fixture = await updateFixture({
      running: true,
      service: true,
      serviceMode: 'headless'
    })
    const before = await fixture.serviceStatus()
    fixture.serviceStatus.mockResolvedValue({
      ...before,
      administratorCommand: 'controlled migration command'
    })
    await expect(
      runLocalUpdate({ environment: fixture.environment, yes: true })
    ).rejects.toMatchObject({
      code: 'UPDATE_SERVICE_ADMINISTRATOR_ACTION_REQUIRED',
      details: { recovery: 'controlled migration command' }
    })
    await fixture.unchanged()
  })

  it('refuses a service intention change during staging', async () => {
    const fixture = await updateFixture({ running: true, service: true })
    const before = await fixture.serviceStatus()
    fixture.serviceStatus
      .mockResolvedValueOnce(before)
      .mockResolvedValue({ ...before, requestedState: 'stopped' })
    await expect(
      runLocalUpdate({ environment: fixture.environment, yes: true })
    ).rejects.toMatchObject({ code: 'UPDATE_SERVICE_NOT_READY' })
    await fixture.unchanged()
  })

  it('rejects a concurrent updater without changing the live lock or operation', async () => {
    const fixture = await updateFixture({ latest: '1.2.3' })
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    fixture.status.mockImplementationOnce(async () => {
      entered()
      await barrier
      return { running: false, state: null, health: null, verified: false }
    })
    const first = runLocalUpdate({ environment: fixture.environment })
    try {
      await Promise.race([waiting, first])
      const lockPath = path.join(fixture.updateDirectory, 'update.lock')
      const lock = await fs.readFile(lockPath, 'utf8')
      const operation = await fixture.operation()
      await expect(
        runLocalUpdate({ environment: fixture.environment })
      ).rejects.toMatchObject({
        code: 'UPDATE_IN_PROGRESS',
        details: { operationId: JSON.parse(lock).operationId }
      })
      expect(await fs.readFile(lockPath, 'utf8')).toBe(lock)
      expect(await fixture.operation()).toEqual(operation)
    } finally {
      release()
      await first
    }
    await fixture.unchanged()
  })

  it.each([
    { packFailure: true },
    { badIntegrity: true },
    { installFailure: true }
  ])(
    'leaves the active installation intact on npm staging failure: %j',
    async (failure) => {
      const fixture = await updateFixture({ running: true, ...failure })
      await expect(
        runLocalUpdate({ environment: fixture.environment, yes: true })
      ).rejects.toMatchObject({
        code: 'UPDATE_STAGING_FAILED',
        details: { phase: 'stage' }
      })
      await fixture.unchanged()
      expect(
        (await fixture.events()).some((event) => event.command === 'version')
      ).toBe(false)
      if (!failure.installFailure) {
        expect(
          (await fixture.events()).some((event) => event.args[0] === 'install')
        ).toBe(false)
      }
    }
  )

  it.each([
    { manifestVersion: '1.2.5' },
    { missingFile: 'dist/node/cli/index.js' },
    ...(['exit', 'invalid-json', 'wrong-version'] as const).map(
      (verification) => ({ verification })
    )
  ])(
    'validates the staged package before stopping or activating: %j',
    async (failure) => {
      const fixture = await updateFixture({ running: true, ...failure })
      await expect(
        runLocalUpdate({ environment: fixture.environment, yes: true })
      ).rejects.toMatchObject({
        code: 'UPDATE_VERIFICATION_FAILED',
        details: { phase: 'verify' }
      })
      await fixture.unchanged()
    }
  )
})
