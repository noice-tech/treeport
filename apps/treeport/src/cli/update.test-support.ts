import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, onTestFinished, vi } from 'vitest'
import * as lifecycle from './lifecycle'
import * as service from './service'

// These contracts run the updater and all of its filesystem operations. Only npm,
// package discovery, daemon/service control and inventory responses are controlled.
// They do not prove clean npm dependency installation or end-to-end update wiring.
export async function updateFixture(
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
