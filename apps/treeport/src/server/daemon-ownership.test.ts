import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from './core/config'
import { acquireDaemonOwnership } from './daemon-ownership'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

async function fixture(instanceId: string | undefined = 'instance-a') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-owner-'))
  temporary.push(root)
  const dataDir = path.join(root, 'data')
  const runtimeDir = path.join(root, 'runtime')
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 8733,
    databasePath: path.join(dataDir, 'treeport.db'),
    dataDir,
    cacheDir: path.join(root, 'cache'),
    runtimeDir,
    shell: '/bin/sh',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1:8733',
    daemonLifecycle: 'treeport',
    appVersion: 'test',
    installationMethod: 'test',
    webDevelopment: false
  }
  if (instanceId !== undefined) {
    config.instanceId = instanceId
  }

  return { root, dataDir, runtimeDir, config }
}

const record = (instanceId: string, pid = process.pid) =>
  `${JSON.stringify({ pid, instanceId })}\n`

describe('daemon ownership', () => {
  it('does not mutate the filesystem without an instance id', async () => {
    const { root, config } = await fixture()
    delete config.instanceId
    const error = await Effect.runPromise(
      Effect.flip(Effect.scoped(acquireDaemonOwnership(config)))
    )
    expect(error.message).toContain('TREEPORT_INSTANCE_ID')
    expect(await fs.readdir(root)).toEqual([])
  })

  it('publishes atomically and releases files with its scope', async () => {
    const { dataDir, runtimeDir, config } = await fixture()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ownership = yield* acquireDaemonOwnership(config)
          yield* ownership.publish()
          const state = yield* Effect.tryPromise(() =>
            fs.readFile(path.join(runtimeDir, 'daemon.json'), 'utf8')
          )
          expect(JSON.parse(state)).toMatchObject({
            pid: process.pid,
            instanceId: 'instance-a',
            apiUrl: config.apiUrl
          })
          expect(
            (yield* Effect.tryPromise(() => fs.readdir(runtimeDir))).some(
              (name) => name.endsWith('.tmp')
            )
          ).toBe(false)
        })
      )
    )
    await expect(fs.access(path.join(dataDir, 'daemon.lock'))).rejects.toThrow()
    await expect(
      fs.access(path.join(runtimeDir, 'daemon.json'))
    ).rejects.toThrow()
  })

  it('rejects a live owner and replaces a stale owner', async () => {
    const { dataDir, config } = await fixture()
    await fs.mkdir(dataDir, { recursive: true })
    const lockPath = path.join(dataDir, 'daemon.lock')
    await fs.writeFile(lockPath, record('live'))
    const liveError = await Effect.runPromise(
      Effect.flip(Effect.scoped(acquireDaemonOwnership(config)))
    )
    expect(liveError.message).toContain('already running')

    await fs.writeFile(lockPath, record('stale', 999_999_999))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireDaemonOwnership(config)
          expect(
            JSON.parse(
              yield* Effect.tryPromise(() => fs.readFile(lockPath, 'utf8'))
            )
          ).toMatchObject({ instanceId: 'instance-a' })
        })
      )
    )
  })

  it('does not remove ownership replaced by another instance', async () => {
    const { dataDir, config } = await fixture()
    const lockPath = path.join(dataDir, 'daemon.lock')
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireDaemonOwnership(config)
          yield* Effect.tryPromise(() =>
            fs.writeFile(lockPath, record('instance-b'))
          )
        })
      )
    )
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      instanceId: 'instance-b'
    })
  })
})
