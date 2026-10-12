import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getSessionKeeperPayload } from '@treeport/session-keeper'
import { PersistentSession } from './session-client'
import { sessionStatusSchema } from './session-protocol'

const roots: string[] = []
const handles: PersistentSession[] = []
const pids = new Set<number>()
const sockets = new Set<string>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // ESRCH is the expected result for a departed fixture, not an I/O fallback.
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
  for (const handle of handles.splice(0)) {
    handle.dispose()
  }
  // These are exclusively fixture PIDs captured at creation, never discovery
  // data belonging to a user instance. Stop commands before their keepers.
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
    // Observe failure without an unhandled rejection while deliberately paused.
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

  it('retains dead-keeper evidence while an unverified command survives', async () => {
    const value = await fixture([
      process.execPath,
      '-e',
      "process.on('SIGHUP',()=>{}); console.log('READY'); setInterval(()=>{},1000)"
    ])
    await waitFor(() => value.output().includes('READY'))
    process.kill(value.status.ownerPid, 'SIGKILL')
    await waitFor(() => !alive(value.status.ownerPid))
    value.session.dispose()
    expect(alive(value.status.pid)).toBe(true)
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
    await archive.terminate()
  })
})
