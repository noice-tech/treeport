import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import {
  confirmLocalUpdate,
  readLocalUpdateProgress,
  runLocalUpdate
} from './update'
import * as lifecycle from './lifecycle'
import * as service from './service'
import { runCliApplication } from './application'

// These contracts run the updater and all of its filesystem operations. Only npm,
// package discovery, daemon/service control and inventory responses are controlled.
// They do not prove clean npm dependency installation or end-to-end update wiring.
async function updateFixture(
  options: {
    latest?: string
    running?: boolean
    service?: boolean
    serviceMode?: 'user' | 'headless'
    requestedState?: 'running' | 'stopped'
    packFailure?: boolean
    badIntegrity?: boolean
    installFailure?: boolean
    manifestVersion?: string
    missingFile?: string
    verification?: 'exit' | 'invalid-json' | 'wrong-version'
    startFailure?: boolean
    evidence?: string
    stopFailure?: boolean
    missingTerminal?: boolean
  } = {}
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "treeport update's contract-")
  )
  onTestFinished(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })
  const prefix = path.join(root, 'prefix')
  const entrypoint = path.join(prefix, 'bin/treeport')
  const packageDirectory = path.join(
    prefix,
    'lib/node_modules/@treeport/treeport'
  )
  const current = path.join(prefix, 'lib/treeport/current')
  const target = path.join(prefix, 'lib/treeport/versions/1.2.4')
  const dataDir = path.join(root, 'data')
  const updateDirectory = path.join(dataDir, 'updates')
  const eventsPath = path.join(root, 'events.jsonl')
  const config = { latest: '1.2.4', evidence: 'unchanged', ...options }
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config))
  await fs.writeFile(eventsPath, '')
  await fs.mkdir(path.dirname(entrypoint), { recursive: true })
  await fs.mkdir(path.join(root, 'home'))
  const environment = {
    HOME: path.join(root, 'home'),
    PATH: `${path.dirname(entrypoint)}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    UPDATE_CONTRACT_ROOT: root,
    TREEPORT_API_URL: '',
    TREEPORT_DAEMON_LIFECYCLE: 'treeport',
    TREEPORT_CLI_ENTRYPOINT: entrypoint,
    TREEPORT_DATA_DIR: dataDir,
    TREEPORT_RUNTIME_DIR: path.join(root, 'runtime')
  }
  // Copy the real package bin shim; the generated stable launcher must execute it.
  const bin = await fs.readFile(
    new URL('../../bin/treeport.mjs', import.meta.url)
  )
  const cli = await fs.readFile(
    new URL('./fixtures/update/cli.mjs', import.meta.url)
  )
  for (const [directory, version] of [
    [packageDirectory, '1.2.3'],
    [path.join(root, 'candidate'), options.manifestVersion ?? '1.2.4']
  ] as const) {
    for (const file of [
      'bin/treeport.mjs',
      'dist/node/cli/index.js',
      'dist/node/server/index.js',
      'dist/web/index.html',
      'drizzle/meta/_journal.json',
      'skills/treeport/SKILL.md'
    ]) {
      if (directory !== packageDirectory && file === options.missingFile) {
        continue
      }

      await fs.mkdir(path.dirname(path.join(directory, file)), {
        recursive: true
      })
      await fs.writeFile(
        path.join(directory, file),
        file === 'bin/treeport.mjs'
          ? bin
          : file === 'dist/node/cli/index.js'
            ? cli
            : 'fixture',
        { mode: 0o755 }
      )
    }
    await fs.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: '@treeport/treeport', version, type: 'module' })
    )
  }
  await fs.symlink(path.join(packageDirectory, 'bin/treeport.mjs'), entrypoint)
  await fs.writeFile(
    path.join(prefix, 'bin/npm'),
    `#!/usr/bin/env node\n${await fs.readFile(new URL('./fixtures/update/npm.mjs', import.meta.url), 'utf8')}`,
    { mode: 0o755 }
  )
  vi.spyOn(lifecycle, 'resolvePackagePath').mockImplementation(
    async (...parts) =>
      path.join(
        await fs.realpath(current).catch(() => prefix),
        'lib/node_modules/@treeport/treeport',
        ...parts
      )
  )
  const events = async () =>
    (await fs.readFile(eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  const operation = async () =>
    JSON.parse(
      await fs.readFile(path.join(updateDirectory, 'operation.json'), 'utf8')
    )
  const daemonLifecycle = options.service ? 'service' : 'treeport'
  let stopped = !options.running
  const status = vi
    .spyOn(lifecycle, 'daemonStatus')
    .mockImplementation(async () => {
      const started = await fs
        .readFile(path.join(root, 'started'), 'utf8')
        .catch(() => null)
      if (stopped && !started) {
        return { running: false, state: null, health: null, verified: false }
      }

      const version = started ?? '1.2.3'
      return {
        running: true,
        verified: true,
        state: {
          pid: process.pid,
          instanceId: 'contract-instance',
          version,
          apiUrl: 'http://127.0.0.1:1',
          dataDir,
          startedAt: new Date().toISOString(),
          installationMethod: 'npm',
          daemonLifecycle
        },
        health: {
          ok: true,
          version,
          protocolVersion: 1,
          hostname: 'contract',
          pid: process.pid,
          instanceId: 'contract-instance',
          installationMethod: 'npm',
          daemonLifecycle,
          url: 'http://127.0.0.1:1'
        }
      }
    })
  const stop = async () => {
    const observed = await operation()
    await fs.appendFile(
      eventsPath,
      `${JSON.stringify({ command: 'stop', phase: observed.phase, current: await fs.realpath(current).catch(() => null), migrationState: observed.migrationState })}\n`
    )
    if (options.stopFailure && observed.phase === 'restart') {
      throw new Error('controlled stop failure')
    }

    stopped = true
    await fs.rm(path.join(root, 'started'), { force: true })
    return { wasRunning: true }
  }
  const down = vi.spyOn(lifecycle, 'daemonDown').mockImplementation(stop)
  vi.spyOn(service, 'serviceInstalled').mockResolvedValue(
    Boolean(options.service)
  )
  const serviceState: service.ServiceStatus = {
    supported: true,
    manager: 'launchd',
    mode: options.serviceMode ?? 'user',
    state: options.running
      ? 'healthy'
      : options.requestedState === 'stopped'
        ? 'stopped'
        : 'unhealthy',
    installed: true,
    enabledAtBoot: false,
    active: true,
    healthy: true,
    rebootReady: false,
    definitionMatches: true,
    environmentMatches: true,
    entrypointMatches: true,
    requestedState: options.requestedState ?? 'running',
    definitionPath: path.join(root, 'service.plist'),
    entrypoint,
    daemon: null,
    issues: [],
    recoveryCommands: [],
    administratorCommand: null
  }
  const serviceStatus = vi
    .spyOn(service, 'serviceStatus')
    .mockResolvedValue(serviceState)
  const serviceStop = vi
    .spyOn(service, 'serviceStop')
    .mockImplementation(async () => {
      await stop()
      return { status: serviceState, changed: true, administratorCommand: null }
    })
  const inventory = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url) => {
      expect(url).toBe('http://127.0.0.1:1/api/projects')
      const started = await fs
        .readFile(path.join(root, 'started'), 'utf8')
        .catch(() => null)
      const timestamp = '2026-03-20T12:00:00.000Z'
      return Response.json({
        projects: [
          {
            id: 'project',
            name: 'contract',
            kind: 'repository',
            rootPath: root,
            repositoryPath: root,
            mainWorktreePath: root,
            defaultBranch: 'main',
            color: null,
            availability: { state: 'available', message: null },
            createdAt: timestamp,
            updatedAt: timestamp,
            worktrees: [
              {
                id: 'worktree',
                projectId: 'project',
                name: 'main',
                path: root,
                head: 'abc',
                branch: 'main',
                detached: false,
                locked: false,
                lockReason: null,
                prunable: false,
                kind: 'main',
                managedWrapperPath: null,
                pr: {
                  state: 'no_pr',
                  number: null,
                  url: null,
                  baseBranch: null,
                  headBranch: null,
                  mergedAt: null,
                  refreshedAt: null
                },
                dirty: null,
                panels: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                terminals:
                  options.missingTerminal && started
                    ? []
                    : [
                        {
                          id: 'terminal',
                          worktreeId: 'worktree',
                          name: 'shell',
                          argv: ['/bin/sh'],
                          shellCommand: null,
                          interactiveShell: false,
                          status: 'running',
                          exitCode: null,
                          createdAt: timestamp,
                          updatedAt: timestamp
                        }
                      ]
              }
            ]
          }
        ]
      })
    })
  const unchanged = async () => {
    expect(await fs.readlink(entrypoint)).toBe(
      path.join(packageDirectory, 'bin/treeport.mjs')
    )
    expect(
      JSON.parse(
        await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')
      ).version
    ).toBe('1.2.3')
    await expect(fs.lstat(current)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(path.join(prefix, 'lib/treeport'))).toEqual([
      'versions'
    ])
    expect(down).not.toHaveBeenCalled()
    expect(serviceStop).not.toHaveBeenCalled()
    expect(
      (await events()).filter((event) => event.command === 'start')
    ).toEqual([])
    await expect(
      fs.access(path.join(updateDirectory, 'update.lock'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  }
  return {
    root,
    prefix,
    entrypoint,
    packageDirectory,
    current,
    target,
    dataDir,
    updateDirectory,
    environment,
    events,
    operation,
    status,
    down,
    serviceStop,
    serviceStatus,
    inventory,
    unchanged
  }
}

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
        args,
        environment: fixture.environment,
        stdout: () => undefined,
        stderr: (value) => {
          stderr += value
        }
      })
      expect(code).toBe(5)
      if (args.includes('--json')) {
        expect(JSON.parse(stderr)).toMatchObject({
          error: {
            code: 'UPDATE_CONFIRMATION_REQUIRED',
            details: { fromVersion: '1.2.3', toVersion: '1.2.4' }
          }
        })
      } else {
        expect(stderr).toContain('Re-run with --yes')
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
    const code = await runCliApplication({
      args: ['update', '--yes', '--start', '--json'],
      environment: fixture.environment,
      stdout: (value) => {
        stdout += value
      },
      stderr: () => undefined
    })
    expect(code).toBe(0)
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

  it('requires explicit non-interactive consent before any disruption', async () => {
    const fixture = await updateFixture({ running: true })
    await expect(
      runLocalUpdate({ environment: fixture.environment })
    ).rejects.toMatchObject({
      code: 'UPDATE_CONFIRMATION_REQUIRED',
      exitCode: 5,
      details: { fromVersion: '1.2.3', toVersion: '1.2.4' }
    })
    await fixture.unchanged()
  })

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

  it('is a current-version no-op: no install, activation or daemon restart', async () => {
    const fixture = await updateFixture({ latest: '1.2.3', running: true })
    expect(
      await runLocalUpdate({ environment: fixture.environment })
    ).toMatchObject({
      status: 'current',
      fromVersion: '1.2.3',
      toVersion: '1.2.3',
      daemon: { restarted: false, healthy: true },
      terminals: { before: 1, after: 1, preserved: true }
    })
    expect(await fixture.events()).toEqual([
      { command: 'npm', args: ['prefix', '--global'] },
      { command: 'npm', args: ['view', '@treeport/treeport@latest', '--json'] }
    ])
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
    ...[
      'bin/treeport.mjs',
      'dist/node/cli/index.js',
      'dist/node/server/index.js',
      'dist/web/index.html',
      'drizzle/meta/_journal.json',
      'skills/treeport/SKILL.md'
    ].map((missingFile) => ({ missingFile })),
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

describe('local update progress', () => {
  it('requires consent for interrupted recovery and verifies the restored daemon and terminals', async () => {
    const fixture = await updateFixture()
    await runLocalUpdate({ environment: fixture.environment })
    const interrupted = {
      ...(await fixture.operation()),
      phase: 'activate',
      daemonWasRunning: true,
      terminalIds: ['terminal']
    }
    const operationPath = path.join(fixture.updateDirectory, 'operation.json')
    await fs.writeFile(operationPath, JSON.stringify(interrupted))
    const before = await fs.readFile(operationPath, 'utf8')
    await expect(
      runLocalUpdate({
        environment: fixture.environment,
        confirm: async () => false
      })
    ).rejects.toMatchObject({ code: 'UPDATE_CANCELLED' })
    expect(await fs.readFile(operationPath, 'utf8')).toBe(before)
    expect(await fs.realpath(fixture.current)).toBe(
      await fs.realpath(fixture.target)
    )
    expect(fixture.down).not.toHaveBeenCalled()
    await expect(
      runLocalUpdate({ environment: fixture.environment, yes: true })
    ).rejects.toMatchObject({
      code: 'UPDATE_ROLLED_BACK',
      details: { rollback: { succeeded: true } }
    })
    expect(await fixture.status()).toMatchObject({
      verified: true,
      health: { version: '1.2.3' }
    })
    expect(fixture.inventory).toHaveBeenCalledOnce()
    expect(await fixture.operation()).toMatchObject({
      phase: 'complete',
      rollbackSucceeded: true
    })
  })

  it('rechecks migration evidence after stopping an interrupted service before rollback', async () => {
    const fixture = await updateFixture({
      service: true,
      requestedState: 'stopped'
    })
    await runLocalUpdate({ environment: fixture.environment })
    const interrupted = {
      ...(await fixture.operation()),
      phase: 'activate',
      daemonWasRunning: true
    }
    await fs.writeFile(
      path.join(fixture.updateDirectory, 'operation.json'),
      JSON.stringify(interrupted)
    )
    const confirm = async () => {
      await fs.writeFile(
        path.join(fixture.updateDirectory, 'startup-report.json'),
        JSON.stringify({
          schemaVersion: 1,
          operationId: interrupted.operationId,
          targetVersion: interrupted.toVersion,
          instanceId: null,
          migrationState: 'advanced',
          ready: false,
          error: null,
          logPath: '/controlled/log',
          snapshotPaths: [],
          updatedAt: new Date().toISOString()
        })
      )
      return true
    }
    await expect(
      runLocalUpdate({ environment: fixture.environment, confirm })
    ).rejects.toMatchObject({
      code: 'UPDATE_RECOVERY_REQUIRED',
      details: { migrationState: 'advanced' }
    })
    // Both the initial stopped-service update and interrupted recovery quiesce it.
    expect(fixture.serviceStop).toHaveBeenCalledTimes(2)
    expect(await fs.realpath(fixture.current)).toBe(
      await fs.realpath(fixture.target)
    )
    expect(
      (await fixture.events()).filter((event) => event.command === 'start')
    ).toEqual([])
    expect(await fixture.operation()).toMatchObject({
      phase: 'recovery_required',
      migrationState: 'advanced'
    })
  })

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
      expect(stop).not.toHaveBeenCalled()
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
