import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess, spawn } from 'node:child_process'
import type {
  LocalUpdateInstallation,
  LocalUpdateProgress,
  TreeportRelease
} from '../cli/update'
import type { AppConfig } from './core'
import { testAccess } from './test-access'
import { createApplicationUpdateManager } from './application-update'

function config(dataDir: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 8733,
    databasePath: path.join(dataDir, 'treeport.db'),
    dataDir,
    cacheDir: path.join(dataDir, 'cache'),
    runtimeDir: path.join(dataDir, 'runtime'),
    shell: '/bin/zsh',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1:8733',
    daemonLifecycle: 'treeport',
    appVersion: '0.4.0',
    installationMethod: 'npm',
    webDevelopment: false
  }
}

const release: TreeportRelease = {
  name: '@treeport/treeport',
  version: '0.5.0',
  dist: {
    tarball: 'https://registry.example/treeport-0.5.0.tgz',
    integrity: 'sha512-test'
  }
}

function installation(dataDir: string): LocalUpdateInstallation {
  return {
    prefix: dataDir,
    packageDirectory: path.join(dataDir, 'package'),
    entrypoint: path.join(dataDir, 'bin', 'treeport'),
    version: '0.4.0',
    managedRoot: path.join(dataDir, 'managed'),
    currentLink: path.join(dataDir, 'managed', 'current'),
    versionsDirectory: path.join(dataDir, 'managed', 'versions'),
    managed: true
  }
}

function idleProgress(): LocalUpdateProgress {
  return {
    active: false,
    operationId: null,
    phase: null,
    fromVersion: null,
    toVersion: null,
    recoveryAction: null,
    migrationState: null
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('application update manager', () => {
  it('keeps release state, starts one detached update, and reports its durable result', async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-application-update-')
    )
    let progress = idleProgress()
    let releaseFailure = false
    const operationId = crypto.randomUUID()
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)
    const unref = vi.fn()
    const spawnProcess = vi.fn(() => {
      const child = testAccess<ChildProcess>(
        Object.assign(new EventEmitter(), {
          unref
        })
      )
      queueMicrotask(() => {
        progress = {
          active: true,
          operationId,
          phase: 'inspect',
          fromVersion: '0.4.0',
          toVersion: '0.5.0',
          recoveryAction: null,
          migrationState: 'not_started'
        }
        child.emit('spawn')
      })
      return child
    })
    const manager = createApplicationUpdateManager(config(dataDir), {
      environment: {
        TREEPORT_CLI_ENTRYPOINT: installation(dataDir).entrypoint
      },
      resolveRelease: async () => {
        if (releaseFailure) {
          throw new Error('registry unavailable')
        }

        return release
      },
      inspectInstallation: async () => installation(dataDir),
      readProgress: async () => progress,
      spawnProcess: testAccess<typeof spawn>(spawnProcess)
    })

    await manager.check()
    const available = await manager.status()
    expect(available).toMatchObject({
      currentVersion: '0.4.0',
      latestVersion: '0.5.0',
      updateAvailable: true,
      canUpdate: true,
      phase: 'idle'
    })
    expect(available.checkedAt).not.toBeNull()

    releaseFailure = true
    await manager.check()
    expect(await manager.status()).toMatchObject({
      latestVersion: '0.5.0',
      checkedAt: available.checkedAt
    })
    expect(warning).toHaveBeenCalledWith(
      '[Treeport] Application update check failed:',
      'registry unavailable'
    )

    const starts = await Promise.allSettled([manager.start(), manager.start()])
    const fulfilled = starts.filter((result) => result.status === 'fulfilled')
    const rejected = starts.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(fulfilled[0]).toMatchObject({
      value: {
        phase: 'inspect',
        operationId,
        targetVersion: '0.5.0'
      }
    })
    expect(rejected[0]).toMatchObject({
      reason: {
        code: 'APPLICATION_UPDATE_IN_PROGRESS',
        status: 409
      }
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      installation(dataDir).entrypoint,
      ['update', '--json'],
      expect.objectContaining({ detached: true, shell: false })
    )
    expect(unref).toHaveBeenCalledOnce()

    progress = {
      ...progress,
      active: false,
      phase: 'complete'
    }
    await fs.writeFile(
      path.join(dataDir, 'updates', 'web-update-result.json'),
      JSON.stringify({
        schemaVersion: 1,
        operationId,
        status: 'updated',
        phase: 'complete',
        fromVersion: '0.4.0',
        toVersion: '0.5.0'
      })
    )
    expect(await manager.status()).toMatchObject({
      phase: 'complete',
      operationId,
      targetVersion: '0.5.0',
      error: null
    })

    const secondOperationId = crypto.randomUUID()
    progress = idleProgress()
    spawnProcess.mockImplementationOnce(() => {
      const child = testAccess<ChildProcess>(
        Object.assign(new EventEmitter(), {
          unref
        })
      )
      queueMicrotask(() => {
        progress = {
          active: true,
          operationId: secondOperationId,
          phase: 'resolve',
          fromVersion: '0.4.0',
          toVersion: '0.5.0',
          recoveryAction: null,
          migrationState: 'not_started'
        }
        child.emit('spawn')
      })
      return child
    })
    await manager.start()
    progress = {
      ...progress,
      active: false
    }
    await fs.writeFile(
      path.join(dataDir, 'updates', 'web-update-error.json'),
      JSON.stringify({
        error: {
          code: 'UPDATE_RELEASE_RESOLUTION_FAILED',
          message: 'npm could not resolve the release.',
          details: {
            operationId: secondOperationId,
            recovery: 'Retry the update.'
          }
        }
      })
    )
    expect(await manager.status()).toMatchObject({
      phase: 'failed',
      operationId: secondOperationId,
      error: 'npm could not resolve the release. Retry the update.'
    })

    manager.dispose()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('checks immediately, repeats on its schedule, and stops after disposal', async () => {
    vi.useFakeTimers()
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-application-update-polling-')
    )
    const resolveRelease = vi.fn(async () => release)
    const manager = createApplicationUpdateManager(config(dataDir), {
      resolveRelease,
      inspectInstallation: async () => installation(dataDir),
      readProgress: async () => idleProgress(),
      pollIntervalMs: 100,
      pollJitterMs: 0
    })

    const polling = Effect.runFork(manager.polling)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveRelease).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(resolveRelease).toHaveBeenCalledTimes(2)

    manager.dispose()
    await vi.advanceTimersByTimeAsync(100)
    await Effect.runPromise(Fiber.await(polling))
    expect(resolveRelease).toHaveBeenCalledTimes(2)
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('does not poll or start updates for an externally managed daemon', async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-application-update-external-')
    )
    const externalConfig = config(dataDir)
    externalConfig.daemonLifecycle = 'external'
    const resolveRelease = vi.fn(async () => release)
    const manager = createApplicationUpdateManager(externalConfig, {
      resolveRelease,
      readProgress: async () => idleProgress(),
      pollIntervalMs: 1,
      pollJitterMs: 0
    })

    await Effect.runPromise(manager.polling)
    expect(resolveRelease).not.toHaveBeenCalled()
    expect(await manager.status()).toMatchObject({
      updateAvailable: false,
      canUpdate: false,
      blockedReason:
        'This Treeport daemon is managed by another process. Update it on the host.'
    })
    await expect(manager.start()).rejects.toMatchObject({
      code: 'APPLICATION_UPDATE_NOT_AVAILABLE',
      status: 409
    })

    manager.dispose()

    const nonWritable = createApplicationUpdateManager(config(dataDir), {
      resolveRelease: async () => release,
      inspectInstallation: async () => {
        throw new Error('The global npm installation is not writable.')
      },
      readProgress: async () => idleProgress()
    })
    await nonWritable.check()
    expect(await nonWritable.status()).toMatchObject({
      updateAvailable: true,
      canUpdate: false,
      blockedReason: 'The global npm installation is not writable.'
    })
    await expect(nonWritable.start()).rejects.toMatchObject({
      code: 'APPLICATION_UPDATE_BLOCKED',
      status: 409
    })

    nonWritable.dispose()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
})
