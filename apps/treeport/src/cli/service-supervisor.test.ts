import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { serviceSupervisorSource } from './service-supervisor.js'
import { assertServiceDirectory } from './service.js'

async function fixture() {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-supervisor-'))
  )
  const children: ChildProcess[] = []
  onTestFinished(async () => {
    for (const child of children) {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return resolve()
        }

        child.once('exit', () => resolve())
      })
    }
    await fs.rm(directory, { recursive: true, force: true })
  })
  const recordPath = path.join(directory, 'service.json')
  const outputPath = path.join(directory, 'starts')
  const cliEntrypoint = path.join(directory, 'treeport')
  const supervisorPath = path.join(directory, 'supervisor.mjs')
  await fs.writeFile(supervisorPath, serviceSupervisorSource())
  for (const release of ['old', 'new']) {
    await fs.writeFile(
      path.join(directory, release),
      `#!${process.execPath}
import fs from 'node:fs'
fs.appendFileSync(${JSON.stringify(outputPath)}, '${release}:' + process.pid + '\\n')
setInterval(() => {}, 1000)
`,
      { mode: 0o700 }
    )
  }
  // Node treats extensionless files as ESM here because they contain imports.
  await fs.symlink(path.join(directory, 'old'), cliEntrypoint)
  const record = {
    supervisorVersion: 1,
    supervisorRequestId: crypto.randomUUID(),
    uid: process.getuid!(),
    cliEntrypoint,
    logPath: path.join(directory, 'daemon.log'),
    requestedState: 'stopped',
    updatedAt: 'initial',
    environment: { PATH: '/usr/bin:/bin', TREEPORT_SERVICE_RECORD: recordPath }
  }
  async function save(requestedState: string) {
    record.requestedState = requestedState
    record.updatedAt = new Date().toISOString()
    record.supervisorRequestId = crypto.randomUUID()
    await fs.writeFile(recordPath + '.tmp', JSON.stringify(record), {
      mode: 0o600
    })
    await fs.rename(recordPath + '.tmp', recordPath)
  }

  await save('stopped')
  function start(uid = record.uid) {
    const child = spawn(
      process.execPath,
      [supervisorPath, recordPath, String(uid)],
      { stdio: 'pipe', env: {} }
    )
    children.push(child)
    return child
  }

  async function state() {
    return fs
      .readFile(path.join(directory, 'supervisor.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null)
  }

  async function starts() {
    return fs
      .readFile(outputPath, 'utf8')
      .then((value) => value.trim().split('\n'))
      .catch(() => [])
  }

  return {
    directory,
    recordPath,
    cliEntrypoint,
    record,
    save,
    start,
    state,
    starts
  }
}

describe('installed user-owned headless supervisor', () => {
  it('persists stop across supervisor restarts and resolves the new release on unprivileged start', async () => {
    const f = await fixture()
    const first = f.start()
    await expect
      .poll(async () => (await f.state())?.requestedState)
      .toBe('stopped')
    expect(await f.starts()).toEqual([])
    await f.save('running')
    await expect.poll(async () => (await f.starts()).length).toBe(1)
    await f.save('stopped')
    await expect
      .poll(async () => await f.state())
      .toMatchObject({
        childPid: null,
        requestedState: 'stopped',
        requestId: f.record.supervisorRequestId
      })
    first.kill('SIGTERM')
    await new Promise((resolve) => first.once('exit', resolve))
    const second = f.start()
    await expect.poll(async () => (await f.state())?.pid).toBe(second.pid)
    expect(await f.starts()).toHaveLength(1)
    await fs.symlink(path.join(f.directory, 'new'), f.cliEntrypoint + '.tmp')
    await fs.rename(f.cliEntrypoint + '.tmp', f.cliEntrypoint)
    await f.save('running')
    await expect.poll(async () => (await f.starts()).length).toBe(2)
    expect((await f.starts())[1]).toMatch(/^new:/)
    // Unexpected exits recover without a launchctl call or privileged signal.
    process.kill((await f.state()).childPid, 'SIGKILL')
    await expect
      .poll(async () => (await f.starts()).length, { timeout: 5000 })
      .toBe(3)
  })

  it('does not override a stopped request when an executable is missing', async () => {
    const f = await fixture()
    await fs.unlink(f.cliEntrypoint)
    const child = f.start()
    let error = ''
    child.stderr!.on('data', (chunk) => {
      error += chunk
    })
    await f.save('running')
    await expect.poll(() => error).toContain('ENOENT')
    await f.save('stopped')
    await expect
      .poll(async () => (await f.state())?.requestId)
      .toBe(f.record.supervisorRequestId)
    await fs.symlink(path.join(f.directory, 'new'), f.cliEntrypoint)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(await f.starts()).toEqual([])
  })

  it('refuses another UID, root, shared directories and symlinked intent', async () => {
    const f = await fixture()
    for (const uid of [0, process.getuid!() + 1]) {
      const child = f.start(uid)
      const code = await new Promise((resolve) => child.once('exit', resolve))
      expect(code).not.toBe(0)
    }
    await f.save('running')
    await fs.chmod(f.directory, 0o777)
    await expect(
      assertServiceDirectory(f.directory, process.getuid!())
    ).rejects.toThrow('Unsafe')
    const unsafe = f.start()
    let unsafeError = ''
    unsafe.stderr!.on('data', (chunk) => {
      unsafeError += chunk
    })
    await expect
      .poll(() => unsafeError)
      .toContain('Unsafe Treeport service directory')
    unsafe.kill('SIGTERM')
    await new Promise((resolve) => unsafe.once('exit', resolve))
    expect(await f.starts()).toEqual([])
    await fs.chmod(f.directory, 0o700)
    await fs.chmod(f.recordPath, 0o644)
    const readable = f.start()
    let readableError = ''
    readable.stderr!.on('data', (chunk) => {
      readableError += chunk
    })
    await expect
      .poll(() => readableError)
      .toContain('Unsafe Treeport service record')
    readable.kill('SIGTERM')
    await new Promise((resolve) => readable.once('exit', resolve))
    expect(await f.starts()).toEqual([])
    await fs.chmod(f.recordPath, 0o600)
    await fs.rename(f.recordPath, f.recordPath + '.real')
    await fs.symlink(f.recordPath + '.real', f.recordPath)
    const child = f.start()
    let error = ''
    child.stderr!.on('data', (chunk) => {
      error += chunk
    })
    await expect.poll(() => error).toMatch(/ELOOP/)
    expect(await f.starts()).toEqual([])
  })
})
