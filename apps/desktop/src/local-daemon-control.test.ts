import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalControlAssociation } from './desktop-contract'
import {
  inspectLocalDaemonControl,
  runLocalDaemonCommand
} from './local-daemon-control'

const roots: string[] = []
const origin = 'http://127.0.0.1:8733'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-control-'))
  roots.push(root)
  const runtimeDir = path.join(root, 'runtime')
  const dataDir = path.join(root, 'data')
  const recordPath = path.join(runtimeDir, 'daemon.json')
  await fs.mkdir(runtimeDir, { recursive: true })
  const record = {
    pid: process.pid,
    instanceId: 'instance',
    version: '1.0.0',
    apiUrl: origin,
    dataDir,
    runtimeDir,
    cliEntrypoint: process.execPath,
    runtimeExecutable: process.execPath,
    startedAt: new Date().toISOString(),
    installationMethod: 'npm',
    daemonLifecycle: 'treeport' as const
  }
  await fs.writeFile(recordPath, JSON.stringify(record), { mode: 0o600 })
  const association: LocalControlAssociation = {
    origin,
    dataDir,
    runtimeDir,
    recordPath,
    cliEntrypoint: process.execPath,
    runtimeExecutable: process.execPath,
    daemonLifecycle: 'treeport'
  }
  return { association, record, recordPath }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true }))
  )
})

describe('local daemon control inspection', () => {
  it('verifies a running installation only when health matches its private record', async () => {
    const value = await fixture()
    const verified = await inspectLocalDaemonControl({
      origin,
      remembered: value.association,
      health: {
        ok: true,
        version: '1.0.0',
        pid: process.pid,
        instanceId: 'instance',
        daemonLifecycle: 'treeport'
      }
    })
    expect(verified).toEqual({
      details: {
        state: 'running',
        reason: null,
        canStart: false,
        canStop: true,
        canRestart: true
      },
      association: value.association
    })

    const mismatch = await inspectLocalDaemonControl({
      origin,
      remembered: value.association,
      health: {
        ok: true,
        version: '1.0.0',
        pid: process.pid,
        instanceId: 'other',
        daemonLifecycle: 'treeport'
      }
    })
    expect(mismatch.details.state).toBe('unverified')
    expect(mismatch.association).toBeNull()
  })

  it('distinguishes a verified stopped installation from an unhealthy record', async () => {
    const value = await fixture()
    const unhealthy = await inspectLocalDaemonControl({
      origin,
      remembered: value.association,
      health: null
    })
    expect(unhealthy.details.state).toBe('unhealthy')
    expect(unhealthy.details.canStart).toBe(false)

    await fs.rm(value.recordPath)
    const stopped = await inspectLocalDaemonControl({
      origin,
      remembered: value.association,
      health: null
    })
    expect(stopped.details).toMatchObject({
      state: 'stopped',
      canStart: true,
      canStop: false,
      canRestart: false
    })
  })

  it.each(['npm', 'managed'] as const)(
    'runs the exact verified %s CLI without inherited Treeport targeting',
    async (installation) => {
      const value = await fixture()
      const cli = path.join(path.dirname(value.recordPath), 'treeport.mjs')
      const capture = path.join(path.dirname(value.recordPath), 'capture.json')
      await fs.writeFile(
        cli,
        `#!/usr/bin/env node\nimport fs from 'node:fs'; fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2), apiUrl: process.env.TREEPORT_API_URL, host: process.env.TREEPORT_HOST, port: process.env.TREEPORT_PORT, dataDir: process.env.TREEPORT_DATA_DIR, projectId: process.env.TREEPORT_PROJECT_ID }));`,
        { mode: 0o700 }
      )
      const launcher = path.join(path.dirname(value.recordPath), 'treeport')
      await fs.writeFile(
        launcher,
        `#!/bin/sh\nset -eu\nexec "$TEST_NODE" "$TEST_CLI" "$@"\n`,
        { mode: 0o700 }
      )
      const association = {
        ...value.association,
        cliEntrypoint: installation === 'managed' ? launcher : cli
      }
      vi.stubEnv('PATH', '/usr/bin:/bin')
      vi.stubEnv('TEST_NODE', process.execPath)
      vi.stubEnv('TEST_CLI', cli)
      vi.stubEnv('CAPTURE_PATH', capture)
      vi.stubEnv('TREEPORT_PROJECT_ID', 'wrong-project')
      vi.stubEnv('TREEPORT_API_URL', 'http://127.0.0.1:9999')

      expect(await runLocalDaemonCommand(association, 'start')).toEqual({
        ok: true,
        error: null
      })
      expect(JSON.parse(await fs.readFile(capture, 'utf8'))).toEqual({
        args: ['start', '--json'],
        apiUrl: origin,
        host: '127.0.0.1',
        port: '8733',
        dataDir: association.dataDir
      })
    }
  )

  it('never grants local capabilities to remote or external daemons', async () => {
    const remote = await inspectLocalDaemonControl({
      origin: 'https://treeport.example.test',
      remembered: null,
      health: { ok: true, version: '1.0.0', daemonLifecycle: 'treeport' }
    })
    expect(remote.details.state).toBe('remote')
    expect(remote.details.canRestart).toBe(false)

    const external = await inspectLocalDaemonControl({
      origin,
      remembered: null,
      health: { ok: true, version: '1.0.0', daemonLifecycle: 'external' }
    })
    expect(external.details.state).toBe('external')
    expect(external.details.canStop).toBe(false)
  })
})
