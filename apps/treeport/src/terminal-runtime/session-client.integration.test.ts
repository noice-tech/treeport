import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSessionKeeperPayload,
  withSessionRecovery
} from '@treeport/session-keeper'
import { PersistentSession } from './session-client.ts'
import { sessionStatusSchema } from './session-protocol.ts'

const roots: string[] = []
const handles: PersistentSession[] = []
const pids = new Set<number>()
const sockets = new Set<string>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (cause) {
    // SAFETY: Node signaling errors expose errno codes.
    if ((cause as NodeJS.ErrnoException).code === 'ESRCH') {
      return false
    }

    throw cause
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + 8000

  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error('Session fixture did not reach its expected state')
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function fixture(argv: string[]) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-session-review-')
  )

  roots.push(root)
  const directory = path.join(root, 'session')

  const session = await PersistentSession.create({
    directory,
    executable: getSessionKeeperPayload(),
    argv,
    cwd: root,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    cols: 80,
    rows: 24,
    metadata: '{}'
  })

  handles.push(session)
  sockets.add(session.manifest.socketPath)
  let output = ''
  session.onData((data) => {
    output += data
  })
  await session.connect()
  await session.ready
  await session.activate()

  const status = sessionStatusSchema.parse(
    JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'))
  )

  pids.add(status.ownerPid)
  pids.add(status.pid)

  return { root, directory, session, status, output: () => output }
}

afterEach(async () => {
  vi.unstubAllEnvs()

  for (const handle of handles.splice(0)) {
    handle.dispose()
  }

  for (const pid of [...pids].reverse()) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }

  await waitFor(() => [...pids].every((pid) => !alive(pid)))
  pids.clear()
  await Promise.all(
    [...sockets].map((socket) => fs.rm(socket, { force: true }))
  )
  sockets.clear()
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('Rust persistent session control and cleanup', () => {
  it('launches through a user scope when available, excludes duplicate admission, and serializes archive cleanup', async () => {
    const commands = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-scope-'))
    roots.push(commands)
    const invocation = path.join(commands, 'invocation.json')

    if (process.platform === 'linux') {
      await fs.writeFile(
        path.join(commands, 'systemctl'),
        '#!/bin/sh\nexit 0\n',
        { mode: 0o700 }
      )
      await fs.writeFile(
        path.join(commands, 'systemd-run'),
        `#!${process.execPath}
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === '--help') { console.log('--expand-environment'); process.exit(0) }
fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify(args))
const command = args.slice(args.indexOf('--') + 1)
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' })
process.exit(result.status ?? 1)
`,
        { mode: 0o700 }
      )
      vi.stubEnv('PATH', `${commands}:${process.env.PATH}`)
    }

    const value = await fixture([
      process.execPath,
      '-e',
      "console.log('READY'); setInterval(()=>{},1000)"
    ])

    await waitFor(() => value.output().includes('READY'))

    if (process.platform === 'linux') {
      expect(JSON.parse(await fs.readFile(invocation, 'utf8'))).toEqual([
        '--user',
        '--scope',
        '--quiet',
        '--expand-environment=no',
        '--',
        getSessionKeeperPayload(),
        '--detach',
        value.directory,
        'treeport-session'
      ])
    }

    const socket = value.session.manifest.socketPath
    await fs.rename(socket, socket + '.hidden')
    sockets.add(socket + '.hidden')
    await expect(
      withSessionRecovery(value.directory, async () => undefined)
    ).rejects.toThrow('ownership is held')
    await expect(value.session.terminate()).rejects.toThrow('ownership is held')
    await expect(
      promisify(execFile)(getSessionKeeperPayload(), [value.directory])
    ).rejects.toThrow('ownership is held')
    expect(alive(value.status.pid)).toBe(true)
    await fs.rename(socket + '.hidden', socket)
    process.kill(value.status.pid, 'SIGKILL')
    process.kill(value.status.ownerPid, 'SIGKILL')
    await waitFor(
      () => !alive(value.status.pid) && !alive(value.status.ownerPid)
    )
    value.session.dispose()
    await expect(
      promisify(execFile)(getSessionKeeperPayload(), [value.directory])
    ).rejects.toThrow('already admitted')
    const archive = await PersistentSession.open(value.directory)
    handles.push(archive)
    await archive.connect()
    await archive.ready
    await withSessionRecovery(value.directory, async () => {
      await expect(archive.terminate()).rejects.toThrow('ownership is held')
      await fs.access(path.join(value.directory, 'manifest.json'))
    })
    const lock = path.join(value.root, '.ownership', 'session')
    const before = await fs.stat(lock)
    await archive.terminate()
    await expect(fs.access(value.directory)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect((await fs.stat(lock)).ino).toBe(before.ino)
  })

  it('does not manufacture ownership evidence for a legacy retained session', async () => {
    const value = await fixture([
      process.execPath,
      '-e',
      'setInterval(()=>{},1000)'
    ])

    await value.session.terminate()
    const legacy = path.join(value.root, 'legacy')
    await fs.mkdir(legacy, { mode: 0o700 })
    const { ownership: _ownership, ...manifest } = value.session.manifest
    await fs.writeFile(
      path.join(legacy, 'manifest.json'),
      JSON.stringify(manifest)
    )
    await expect(
      withSessionRecovery(legacy, async () => undefined)
    ).rejects.toThrow('predates ownership leases')
    await expect(
      promisify(execFile)(getSessionKeeperPayload(), [legacy])
    ).rejects.toThrow('predates ownership leases')
    await fs.access(path.join(legacy, 'manifest.json'))
  })

  it('preserves in-flight and new requests across output pauses exceeding their timeout', async () => {
    const value = await fixture([
      process.execPath,
      '-e',
      "process.stdin.setEncoding('utf8'); process.stdin.on('data',data=>console.log('INPUT:'+data)); setInterval(()=>console.log('OUTPUT'),10)"
    ])

    await waitFor(() => value.output().includes('OUTPUT'))
    const processed = value.session.flushRequests(value.session.sequence)
    value.session.pause()
    const status = value.session.refreshStatus()
    const pending = Promise.all([processed, status])
    let failure: Error | null = null
    void pending.catch((error) => {
      failure = error
    })
    await new Promise((resolve) => setTimeout(resolve, 11000))
    expect(failure).toBeNull()
    expect(value.session.fault).toBeNull()
    value.session.resume()
    await pending
    await value.session.refreshStatus()
    value.session.write('AFTER_PAUSE\n')
    await waitFor(() => value.output().includes('INPUT:AFTER_PAUSE'))
    expect(value.session.fault).toBeNull()
    await Promise.all([value.session.terminate(), value.session.terminate()])
  }, 25000)

  it('retains dead-keeper evidence while its command or orphaned children survive', async () => {
    const child =
      "process.on('SIGHUP',()=>{}); console.log('CHILD:'+process.pid); setInterval(()=>{},1000)"

    const value = await fixture([
      process.execPath,
      '-e',
      `process.on('SIGHUP',()=>{}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio:'inherit'}); setInterval(()=>{},1000)`
    ])

    await waitFor(() => /CHILD:\d+/u.test(value.output()))
    const childPid = Number(/CHILD:(\d+)/u.exec(value.output())![1])
    pids.add(childPid)
    process.kill(value.status.ownerPid, 'SIGKILL')
    await waitFor(() => !alive(value.status.ownerPid))
    value.session.dispose()
    expect(alive(value.status.pid)).toBe(true)
    const statusPath = path.join(value.directory, 'status.json')
    await fs.writeFile(
      statusPath,
      JSON.stringify({ ...value.status, ownerPid: process.pid })
    )
    const archive = await PersistentSession.open(value.directory)
    handles.push(archive)
    await archive.connect()
    await archive.ready
    expect(archive.archived).toBe(true)
    await expect(archive.terminate()).rejects.toThrow()
    await fs.access(path.join(value.directory, 'manifest.json'))
    await fs.access(path.join(value.directory, 'status.json'))
    await fs.access(path.join(value.directory, 'journal.jsonl'))
    expect(alive(value.status.pid)).toBe(true)
    process.kill(value.status.pid, 'SIGKILL')
    await waitFor(() => !alive(value.status.pid))
    expect(alive(childPid)).toBe(true)
    await expect(archive.terminate()).rejects.toThrow(
      'session still has processes'
    )
    await fs.access(path.join(value.directory, 'journal.jsonl'))
    process.kill(childPid, 'SIGKILL')
    await waitFor(() => !alive(childPid))
    await archive.terminate()
  })
})
