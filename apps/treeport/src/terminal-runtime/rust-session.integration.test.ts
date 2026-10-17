import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { getSessionKeeperPayload } from '@treeport/session-keeper'
import { afterEach, describe, expect, it } from 'vitest'
import { PersistentSession } from './session-client'
import { SessionJournal } from './session-journal'
import {
  SESSION_MAX_FRAME_BYTES,
  sessionFrameSchema,
  sessionStatusSchema,
  type SessionFrame
} from './session-protocol'

const binary = getSessionKeeperPayload()
const execute = promisify(execFile)
const volumes: string[] = []
const roots: string[] = []
const sessions: PersistentSession[] = []
const pids = new Set<number>()
const keepers = new Map<
  string,
  { token: string; ownerPid: number; pid: number }
>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // SAFETY: Node signaling errors carry errno codes; only ESRCH proves absence.
    if ((cause as NodeJS.ErrnoException).code === 'ESRCH') {
      return false
    }

    throw cause
  }
}

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error('Rust session fixture timed out')
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function fixture(
  source: string,
  limit?: number,
  argv?: string[],
  parent = os.tmpdir(),
  launch: { executable: string; arguments: string[] } | null = null,
  metadata = '{}',
  terminalId = `term_${crypto.randomUUID().replaceAll('-', '')}`
) {
  const root = await fs.mkdtemp(path.join(parent, 'tp-rust-session-'))
  roots.push(root)
  const directory = path.join(root, 'session')
  const executable = launch === null ? binary : path.join(root, 'launch-keeper')
  if (launch !== null) {
    await fs.writeFile(
      executable,
      `#!${launch.executable}
import os,sys
os.execv(${JSON.stringify(launch.executable)}, ${JSON.stringify([launch.executable, ...launch.arguments])} + sys.argv[1:])
`,
      { mode: 0o700 }
    )
  }

  const session = await PersistentSession.create({
    directory,
    executable,
    terminalId,
    argv: argv ?? [process.execPath, '-e', source],
    cwd: root,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    cols: 80,
    rows: 24,
    metadata,
    journalLimitBytes: limit
  })
  sessions.push(session)
  const status = sessionStatusSchema.parse(
    JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'))
  )
  keepers.set(session.manifest.socketPath, {
    token: session.manifest.token,
    ownerPid: status.ownerPid,
    pid: status.pid
  })
  pids.add(status.ownerPid)
  pids.add(status.pid)
  let output = ''
  session.onData((data) => {
    output += data
  })
  await session.connect()
  await session.ready
  await session.activate()
  return { root, directory, session, status, terminalId, output: () => output }
}

async function bundledJournalUrl() {
  const dist = path.resolve(import.meta.dirname, '../../dist')
  const entry = path.join(dist, 'session-journal.js')
  await fs.access(entry)
  return pathToFileURL(entry).href
}

async function* frames(socket: net.Socket) {
  socket.setEncoding('utf8')
  socket.setTimeout(5000, () => {
    socket.destroy(new Error('Raw fixture peer timed out'))
  })
  let buffer = ''
  // setEncoding keeps incremental UTF-8 decoding in Node's readable stream.
  for await (const chunk of socket) {
    buffer += String(chunk)
    let boundary: number
    while ((boundary = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 1)
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(
        SESSION_MAX_FRAME_BYTES
      )
      yield sessionFrameSchema.parse(JSON.parse(line))
    }
    expect(Buffer.byteLength(buffer)).toBeLessThanOrEqual(
      SESSION_MAX_FRAME_BYTES
    )
  }
}

async function control(
  socketPath: string,
  input: Record<string, string | number>
) {
  const socket = net.createConnection(socketPath)
  socket.write(`${JSON.stringify(input)}\n`)
  for await (const frame of frames(socket)) {
    return frame
  }
  throw new Error('Raw fixture control disconnected before its response')
}

afterEach(async () => {
  // Detach this test's cleanup state before any fallible work. A retained
  // failed fixture is evidence, not a cleanup dependency of subsequent tests.
  const retained = {
    keepers: [...keepers],
    pids: [...pids],
    roots: roots.splice(0),
    volumes: volumes.splice(0)
  }
  keepers.clear()
  pids.clear()
  for (const session of sessions.splice(0)) {
    session.dispose()
  }
  // Authentication, not a cached PID, authorizes fixture cleanup. If ownership
  // cannot be established, retain the fixture/evidence instead of signaling a
  // potentially reused PID or hiding a keeper lifecycle regression.
  const cleanup = await Promise.allSettled(
    retained.keepers.map(async ([socket, keeper]) => {
      const socketStat = await fs.lstat(socket).catch((cause) => {
        // SAFETY: Node filesystem errors expose errno codes; only ENOENT means
        // authenticated close already removed this fixture's control endpoint.
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw cause
        }

        return null
      })
      if (socketStat !== null) {
        const inspected = await control(socket, {
          method: 'inspect',
          id: 'fixture-cleanup-inspect',
          token: keeper.token
        })
        expect(inspected).toMatchObject({
          type: 'response',
          status: { ownerPid: keeper.ownerPid, pid: keeper.pid },
          error: null
        })
        const closed = await control(socket, {
          method: 'terminate',
          id: 'fixture-cleanup-close',
          token: keeper.token
        })
        expect(closed).toMatchObject({ type: 'response', error: null })
      }

      await until(() => !alive(keeper.ownerPid) && !alive(keeper.pid))
    })
  )
  const failures = cleanup.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length) {
    throw new AggregateError(
      failures,
      `Authenticated fixture cleanup failed; retained evidence: ${retained.roots.join(', ')}`
    )
  }

  await until(() => retained.pids.every((pid) => !alive(pid)))
  await Promise.all(
    retained.keepers.map(([socket]) => fs.rm(socket, { force: true }))
  )
  // Only our unique image mountpoints, and only after authenticated cleanup
  // proves every fixture process exited. Never force-unmount a live keeper.
  for (const mount of retained.volumes) {
    await execute('hdiutil', ['detach', mount])
  }
  await Promise.all(
    retained.roots.map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('Rust keeper with the production TypeScript client and journal', () => {
  it.each([SESSION_MAX_FRAME_BYTES + 128, 1024 ** 4])(
    'bounds sparse retained-tail recovery in an isolated 64 MiB heap (%s bytes)',
    async (size) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'tp-journal-sparse-')
      )
      roots.push(root)
      const file = path.join(root, 'journal.jsonl')
      const descriptor = await fs.open(file, 'wx', 0o600)
      try {
        await descriptor.write(
          JSON.stringify({
            type: 'marker',
            at: 1,
            sequence: 1,
            data: 'committed🌲'
          }) + '\n{"type":"marker","at":2,"sequence":2,"data":"'
        )
        await descriptor.truncate(size)
      } finally {
        await descriptor.close()
      }
      const before = await fs.stat(file)
      const module = await bundledJournalUrl()
      const result = await execute(
        process.execPath,
        [
          '--max-old-space-size=64',
          '--input-type=module',
          '-e',
          `const module = await import(process.argv[1]);
         const Journal = Object.values(module).find(value => typeof value === 'function' && typeof value.readRetained === 'function');
         let count = 0;
         await (async () => {
           for await (const record of Journal.readRetained(process.argv[2])) {
             if (record.sequence !== 1 || record.data !== 'committed🌲') throw Error('Wrong committed prefix');
             count++;
           }
           throw Error('Oversized partial tail was accepted');
         })().catch(error => {
           if (!/record exceeds the frame limit/.test(error.message) || count !== 1) throw error;
           console.log('bounded after one complete record');
         });`,
          module,
          root
        ],
        { timeout: 3000, maxBuffer: 2048 }
      )
      expect(result.stdout.trim()).toBe('bounded after one complete record')
      const after = await fs.stat(file)
      expect([after.ino, after.size, after.mtimeMs]).toEqual([
        before.ino,
        before.size,
        before.mtimeMs
      ])
    }
  )

  it.each(['active', 'checkpoint'] as const)(
    'refuses a FIFO %s recovery source in a deadline-bounded child',
    async (kind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-journal-fifo-'))
      roots.push(root)
      const file = path.join(
        root,
        kind === 'active' ? 'journal.jsonl' : 'checkpoint-0000000001.gz'
      )
      await execute('mkfifo', [file])
      const module = await bundledJournalUrl()
      // A regression can block open/read in libuv. Only this owned launcher is
      // subject to the deadline, never the Pi session or a keeper process.
      const result = await execute(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const module = await import(process.argv[1]);
         const Journal = Object.values(module).find(value => typeof value === 'function' && typeof value.readRetained === 'function');
         await (async () => {
           for await (const record of Journal.readRetained(process.argv[2])) throw Error('FIFO content was read');
           throw Error('FIFO was accepted');
         })().catch(error => {
           if (!/not a regular file/.test(error.message)) throw error;
           console.log('refused');
         });`,
          module,
          root
        ],
        { timeout: 2000, maxBuffer: 1024 }
      )
      expect(result.stdout.trim()).toBe('refused')
      expect((await fs.lstat(file)).isFIFO()).toBe(true)
      expect(await fs.readdir(root)).toEqual([path.basename(file)])
    }
  )

  it
    .runIf(process.platform === 'darwin')
    .each(['descendant', 'exit', 'signal'])(
    'discovers reparented descendants and reaps the leader without spare descriptors (%s)',
    async (kind) => {
      const python = (await execute('which', ['python3'])).stdout.trim()
      const value = await fixture(
        '',
        undefined,
        [
          python,
          '-c',
          `
import os,time,tty,signal
# Same session, separate process group; self-expiry is only a teardown backstop.
tty.setraw(0)
child=0
if ${kind === 'descendant' ? 'True' : 'False'}:
 child=os.fork()
 if child==0:
  os.setpgid(0,0)
  time.sleep(20)
  os._exit(0)
os.write(1,('DESCENDANT:%d\\nREADY\\n'%child).encode())
os.read(0,1)
os.write(1,'FINAL🌲\\n'.encode())
if ${kind === 'signal' ? 'True' : 'False'}: os.kill(os.getpid(),signal.SIGTERM)
os._exit(7)
`
        ],
        os.tmpdir(),
        {
          executable: python,
          arguments: [
            '-c',
            'import os,resource,sys;resource.setrlimit(resource.RLIMIT_NOFILE,(45,45));os.execv(sys.argv[1],sys.argv[1:])',
            binary
          ]
        }
      )
      await until(() => value.output().includes('READY'))
      const descendant =
        kind === 'descendant'
          ? Number(/DESCENDANT:(\d+)/.exec(value.output())?.[1])
          : null
      if (descendant !== null) {
        expect(Number.isSafeInteger(descendant)).toBe(true)
        pids.add(descendant)
      }

      const peers: net.Socket[] = []
      try {
        // Leave these admitted peers unauthenticated. Only this fixture's
        // inherited RLIMIT is reduced; never alter another process's limits.
        for (let index = 0; index < 31; index++) {
          const peer = net.createConnection(value.session.manifest.socketPath)
          peers.push(peer)
          peer.on('error', () => {})
          await once(peer, 'connect')
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
        value.session.write('exit')
        // Native enumeration needs neither a spawned /bin/ps nor pipe FDs.
        // Reaping proves exit-time discovery completed under this pressure;
        // the previous subprocess path retained a zombie after EMFILE instead.
        await until(() => !alive(value.status.pid))
        const evidence = await fs.readFile(
          path.join(value.directory, 'owner.log'),
          'utf8'
        )
        expect(evidence).not.toContain(
          'Cannot retain exited session descendants:'
        )
        if (descendant !== null) {
          expect(alive(descendant)).toBe(true)
          expect(value.session.exitCode).toBeNull()
        }
      } finally {
        // A local destroy does not prove the keeper released its admission
        // slots. Finish the half-close handshake before opening a control
        // connection, so teardown cannot race the deliberately full peer pool.
        await Promise.all(
          peers.map(
            (peer) =>
              new Promise<void>((resolve) => {
                if (peer.destroyed) {
                  resolve()
                  return
                }

                peer.once('close', () => resolve())
                peer.resume()
                peer.end()
              })
          )
        )
      }
      // Resource pressure has gone. Without descendants, verify the natural
      // exit code and output fence via a fresh production-client replay first.
      let session = value.session
      if (descendant === null) {
        value.session.dispose()
        let output = ''
        // Local socket disposal is not a remote lease-release acknowledgement,
        // especially with the peer/descriptor backlog from this fixture. Wait
        // for that existing v1 lease to drain; never force-replace the owner.
        await until(async () => {
          const candidate = await PersistentSession.open(value.directory)
          sessions.push(candidate)
          expect(candidate.manifest.token).toBe(value.session.manifest.token)
          output = ''
          candidate.onData((data) => {
            output += data
          })
          const failure = await candidate.connect().then(
            () => null,
            (cause: unknown) => cause
          )
          if (failure !== null) {
            candidate.dispose()
            if (
              !(failure instanceof Error) ||
              failure.message !==
                'Session authentication failed or another engine is attached'
            ) {
              throw failure
            }

            return false
          }

          session = candidate
          return true
        })
        await session.ready
        await session.activate()
        const code = kind === 'signal' ? 0 : 7
        await until(() => session.exitCode === code)
        expect(output).toBe('DESCENDANT:0\nREADY\nFINAL🌲\n')
        const records = []
        for await (const record of SessionJournal.readRetained(
          value.directory
        )) {
          records.push(record)
        }
        expect(records.at(-1)).toMatchObject({ type: 'exit', exitCode: code })
      }

      // Discovery retained the separate group's birth identity before reaping
      // its leader. The 20-second self-expiry cannot masquerade as cleanup.
      const start = performance.now()
      for (let attempt = 0; ; attempt++) {
        const failure = await session.terminate().then(
          () => null,
          (cause: unknown) => cause
        )
        if (failure === null) {
          break
        }

        // Under descriptor/fsync pressure, the bounded drain may deliberately
        // refuse an ACK while its SAME admitted write is still pending. Qualify
        // that explicit retry contract, not an unlimited generic close retry.
        if (
          attempt >= 2 ||
          !(failure instanceof Error) ||
          !failure.message.includes(
            'Session processes stopped, but storage is still in flight; authenticated close must retry after it completes'
          )
        ) {
          throw failure
        }

        expect(alive(value.status.pid)).toBe(false)
        if (descendant !== null) {
          expect(alive(descendant)).toBe(false)
        }

        const inspected = await control(session.manifest.socketPath, {
          method: 'inspect',
          id: 'pressure-close-retained-operation',
          token: session.manifest.token
        })
        expect(inspected).toMatchObject({
          type: 'response',
          error: null,
          status: {
            ownerPid: value.status.ownerPid,
            pid: value.status.pid,
            incomplete: true
          }
        })
      }
      await until(
        () =>
          !alive(value.status.ownerPid) &&
          !alive(value.status.pid) &&
          (descendant === null || !alive(descendant))
      )
      expect(performance.now() - start).toBeLessThan(4000)
    }
  )

  it('round-trips opaque UTF-16 IDs and ignores valid extensions with the Rust owner', async () => {
    const terminalId = 'quote"line\nnul\0🌲\ud800' + 'long'.repeat(1000)
    const value = await fixture(
      `
        process.stdin.setRawMode(true);
        console.log('READY');
        process.stdin.on('data',()=>console.log('AFTER_IDS🌲'));
        setInterval(()=>{},1000);
      `,
      undefined,
      undefined,
      os.tmpdir(),
      null,
      '{}',
      terminalId
    )
    await until(() => value.output().includes('READY'))
    const listing = await execute('ps', [
      '-ww',
      '-p',
      String(value.status.ownerPid),
      '-o',
      'args='
    ])
    const identity = crypto
      .createHash('sha256')
      .update(terminalId)
      .digest('hex')
      .slice(0, 32)
    expect(
      listing.stdout.trim().startsWith(`treeport-session term_${identity} `)
    ).toBe(true)
    expect(listing.stdout).not.toContain('quote"line')
    expect(listing.stdout).not.toContain(value.session.manifest.token)
    const ids = ['\ud800', '\udfff', '\ud800X\udc00', 'quote"line\nnul\0🌲']
    for (const id of ids) {
      const request = JSON.stringify({
        method: 'inspect',
        id,
        token: value.session.manifest.token
      })
      // These are valid JSON/Zod extensions, not decoded command arguments:
      // an unpaired property name, unpaired string, overflow number and deep
      // unused field must not change authentication or the attached lease.
      const extensions =
        String.raw`,"data":"\ud800","extra":{"\ud800":"\udfff","number":1e400},"\ud800":"ignored","metadata":` +
        '['.repeat(1000) +
        '0' +
        ']'.repeat(1000)
      const socket = net.createConnection(value.session.manifest.socketPath)
      socket.write(`${request.slice(0, -1)}${extensions}}\n`)
      const received = []
      for await (const frame of frames(socket)) {
        received.push(frame)
      }
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        type: 'response',
        id,
        error: null,
        status: {
          ownerPid: value.status.ownerPid,
          pid: value.status.pid,
          error: null
        }
      })
    }
    value.session.write('continue')
    await until(() => value.output().includes('AFTER_IDS🌲'))
    expect(value.session.fault).toBeNull()
    value.session.dispose()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const socket = net.createConnection(value.session.manifest.socketPath)
    const incoming = frames(socket)
    try {
      socket.write(
        `${JSON.stringify({ method: 'attach', id: ids[0], token: value.session.manifest.token })}\n`
      )
      while (true) {
        const next = await incoming.next()
        expect(next.done).toBe(false)
        const frame = next.value!
        if (frame.type === 'response') {
          expect(frame).toMatchObject({ id: ids[0], error: null })
        }

        if (frame.type === 'ready') {
          break
        }
      }
      socket.write(
        `${JSON.stringify({ method: 'marker', id: ids[1], data: 'opaque-id-fence' })}\n`
      )
      let marker = false
      while (true) {
        const next = await incoming.next()
        expect(next.done).toBe(false)
        const frame = next.value!
        if (frame.type === 'marker') {
          marker = frame.data === 'opaque-id-fence'
        }

        if (frame.type === 'response') {
          expect(frame).toMatchObject({ id: ids[1], error: null })
          expect(marker).toBe(true)
          break
        }
      }
      expect(
        await control(value.session.manifest.socketPath, {
          method: 'terminate',
          id: ids[2]!,
          token: value.session.manifest.token
        })
      ).toMatchObject({ type: 'response', id: ids[2], error: null })
    } finally {
      socket.destroy()
      await incoming.return()
    }
  })

  it('retains opaque UTF-16 markers and metadata through gzip replay with the Rust owner', async () => {
    const initial = 'initial\ud800'
    const value = await fixture(
      `console.log('READY'); setInterval(()=>{},1000);`,
      undefined,
      undefined,
      os.tmpdir(),
      null,
      initial
    )
    await until(() => value.output().includes('READY'))
    const units = Array.from({ length: 65536 }, (_, unit) =>
      String.fromCharCode(unit)
    ).join('')
    const expected = [
      '\ud800',
      '\udfff',
      '\ud800X\udc00',
      'quote"slash\\line\ncr\rnul\0🌲',
      units,
      'z'.repeat(1024 * 1024),
      'after-checkpoint\ud800🌲\udfff'
    ]
    const captured: string[] = []
    value.session.onMarker((data) => captured.push(data))
    for (const data of expected) {
      await value.session.recordMarker(data)
      await value.session.setMetadata(data)
      const manifest = JSON.parse(
        await fs.readFile(path.join(value.directory, 'manifest.json'), 'utf8')
      )
      expect(manifest.metadata).toBe(data)
    }
    expect(captured).toEqual(expected)
    expect(
      (await fs.readdir(value.directory)).some((name) => name.endsWith('.gz'))
    ).toBe(true)
    const retained = []
    for await (const record of SessionJournal.readRetained(value.directory)) {
      if (record.type === 'marker') {
        retained.push(record.data)
      }
    }
    expect(retained).toEqual(expected)
    value.session.dispose()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const resumed = await PersistentSession.open(value.directory)
    sessions.push(resumed)
    const replay: string[] = []
    resumed.onMarker((data) => replay.push(data))
    expect(resumed.manifest.metadata).toBe(expected.at(-1))
    await resumed.connect()
    await resumed.ready
    expect(replay).toEqual(expected)
    await resumed.activate()
    await resumed.recordMarker(initial)
    expect(replay).toEqual([...expected, initial])
    await resumed.terminate()
  })

  it('rejects an oversized marker without retaining an impossible capture retry', async () => {
    const value = await fixture(`
      process.stdin.setRawMode(true);
      console.log('READY');
      process.stdin.on('data',()=>console.log('AFTER_REJECTION🌲'));
      setInterval(()=>{},1000);
    `)
    await until(() => value.output().includes('READY'))
    value.session.dispose()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const socket = net.createConnection(value.session.manifest.socketPath)
    const incoming = frames(socket)
    socket.write(
      `${JSON.stringify({
        method: 'attach',
        id: 'marker-budget-attach',
        token: value.session.manifest.token
      })}\n`
    )
    let sequence = 0
    while (true) {
      const next = await incoming.next()
      expect(next.done).toBe(false)
      const frame = next.value!
      if (frame.type === 'response') {
        expect(frame.error).toBeNull()
      }

      if (frame.type === 'ready') {
        sequence = frame.sequence
        break
      }
    }
    const pathToJournal = path.join(value.directory, 'journal.jsonl')
    const committed = await fs.readFile(pathToJournal)
    // The v1 protocol permits an empty ID. Its smaller request envelope can
    // fit the limit even though timestamp/sequence make the journal line larger.
    const request = { method: 'marker', id: '', data: '' }
    request.data = 'x'.repeat(
      SESSION_MAX_FRAME_BYTES - Buffer.byteLength(JSON.stringify(request)) - 1
    )
    const encoded = `${JSON.stringify(request)}\n`
    expect(Buffer.byteLength(encoded)).toBe(SESSION_MAX_FRAME_BYTES)
    socket.write(encoded)
    const received = []
    for await (const frame of incoming) {
      received.push(frame)
    }
    expect(await fs.readFile(pathToJournal)).toEqual(committed)
    expect(
      await control(value.session.manifest.socketPath, {
        method: 'inspect',
        id: 'after-marker-rejection',
        token: value.session.manifest.token
      })
    ).toMatchObject({
      type: 'response',
      error: null,
      status: {
        sequence,
        ownerPid: value.status.ownerPid,
        pid: value.status.pid,
        error: null,
        incomplete: false
      }
    })
    expect(received).toHaveLength(1)
    expect(received[0]?.type === 'fault' && received[0].message).toMatch(
      /frame.*limit/
    )
    const reconnect = await PersistentSession.open(value.directory)
    sessions.push(reconnect)
    let output = ''
    const markers: string[] = []
    reconnect.onData((data) => {
      output += data
    })
    reconnect.onMarker((data) => {
      markers.push(data)
    })
    await reconnect.connect()
    await reconnect.ready
    await reconnect.activate()
    await reconnect.recordMarker('after-rejection')
    reconnect.write('continue')
    await until(() => output.includes('AFTER_REJECTION🌲'))
    expect(markers).toEqual(['after-rejection'])
    expect(reconnect.fault).toBeNull()
    expect(reconnect.sequence).toBeGreaterThan(sequence)
    await reconnect.terminate()
  })

  it('rejects an oversized status reply before publishing bytes and preserves the attached owner', async () => {
    const value = await fixture(`
      process.stdin.setRawMode(true);
      console.log('READY');
      process.stdin.on('data',()=>console.log('AFTER_LIMIT🌲'));
      setInterval(()=>{},1000);
    `)
    await until(() => value.output().includes('READY'))
    const request = {
      method: 'inspect',
      id: '',
      token: value.session.manifest.token
    }
    // A legal, exactly bounded request has less envelope overhead than its
    // status response. The original attached engine must not lose its lease.
    request.id = 'x'.repeat(
      SESSION_MAX_FRAME_BYTES - Buffer.byteLength(JSON.stringify(request)) - 1
    )
    const encoded = `${JSON.stringify(request)}\n`
    expect(Buffer.byteLength(encoded)).toBe(SESSION_MAX_FRAME_BYTES)
    const socket = net.createConnection(value.session.manifest.socketPath)
    socket.write(encoded)
    const received = []
    for await (const frame of frames(socket)) {
      received.push(frame)
    }
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'fault' })
    expect(received[0]?.type === 'fault' && received[0].message).toMatch(
      /frame.*limit/
    )
    const inspected = await control(value.session.manifest.socketPath, {
      method: 'inspect',
      id: 'after-oversized-reply',
      token: value.session.manifest.token
    })
    expect(inspected).toMatchObject({
      type: 'response',
      error: null,
      status: {
        ownerPid: value.status.ownerPid,
        pid: value.status.pid,
        error: null,
        incomplete: false
      }
    })
    value.session.write('continue')
    await until(() => value.output().includes('AFTER_LIMIT🌲'))
    expect(value.session.fault).toBeNull()
    await value.session.terminate()
  })

  it('reconnects to detached capture, restores controls, and commits final output before exit', async () => {
    const value = await fixture(`
      process.stdout.write(Buffer.from([0xf0]));
      setTimeout(()=>process.stdout.write(Buffer.from([0x9f,0x8c,0xb2])),20);
      process.stdin.once('data',()=>{
        clearInterval(ticker);
        process.stdout.write('x'.repeat(2*1024*1024),()=>{
          process.stdout.write('FINAL🌲',()=>process.exit(7));
        });
      });
      const ticker=setInterval(()=>console.log('TICK'),50);
    `)
    await until(() => value.output().includes('🌲'))
    expect(value.output()).not.toContain('\ufffd')
    const listing = await execute('ps', [
      '-ww',
      '-p',
      String(value.status.ownerPid),
      '-o',
      'args='
    ])
    expect(
      listing.stdout.trim().startsWith(`treeport-session ${value.terminalId} `)
    ).toBe(true)
    await value.session.pauseOwner(true)
    const markers: string[] = []
    value.session.onMarker((data) => markers.push(data))
    const sizes: number[][] = []
    value.session.onResize((cols, rows) => sizes.push([cols, rows]))
    await value.session.resizeAndWait(101, 37)
    await value.session.recordMarker('opaque-marker')
    expect(sizes).toEqual([[101, 37]])
    expect(markers).toEqual(['opaque-marker'])
    await value.session.setMetadata('{"native":true}')
    const acknowledged = value.session.sequence
    await value.session.flushRequests(acknowledged)
    value.session.dispose()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const reconnect = await PersistentSession.open(value.directory)
    sessions.push(reconnect)
    let replay = ''
    const replayMarkers: string[] = []
    const replaySizes: number[][] = []
    reconnect.onData((data) => {
      replay += data
    })
    reconnect.onMarker((data) => replayMarkers.push(data))
    reconnect.onResize((cols, rows) => replaySizes.push([cols, rows]))
    await reconnect.connect()
    await reconnect.ready
    expect(replay.slice(0, value.output().length)).toBe(value.output())
    expect(replay.slice(value.output().length)).toMatch(/^(?:TICK\r\n)+$/)
    expect(replayMarkers).toEqual(['opaque-marker'])
    expect(replaySizes).toEqual([[101, 37]])
    expect(reconnect.manifest.metadata).toBe('{"native":true}')
    expect(
      (
        await execute('ps', [
          '-ww',
          '-p',
          String(value.status.ownerPid),
          '-o',
          'args='
        ])
      ).stdout
    ).toBe(listing.stdout)
    expect(reconnect.processedSequence).toBe(acknowledged)
    await reconnect.activate()
    reconnect.write('FINISH\n')
    await until(() => reconnect.exitCode === 7)
    expect(replay).toContain('x'.repeat(2 * 1024 * 1024) + 'FINAL🌲')
    const fence = reconnect.sequence
    for (let sequence = 1; sequence <= fence; sequence++) {
      reconnect.markProcessed(sequence)
    }
    await reconnect.flushRequests(fence)
    expect(
      await control(reconnect.manifest.socketPath, {
        method: 'inspect',
        id: 'parser-fence',
        token: reconnect.manifest.token
      })
    ).toMatchObject({ status: { processedSequence: fence } })
    const records = []
    for await (const record of SessionJournal.readRetained(value.directory)) {
      records.push(record)
    }
    expect(records.at(-1)).toMatchObject({ type: 'exit', exitCode: 7 })
    expect(
      records
        .filter((record) => record.type === 'output')
        .map((record) => record.data)
        .join('')
    ).toBe(replay)
    expect(
      (await fs.readdir(value.directory)).some((name) => name.endsWith('.gz'))
    ).toBe(true)
    await reconnect.terminate()
    await until(() => !alive(value.status.ownerPid) && !alive(value.status.pid))
    await expect(fs.access(value.directory)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('captures a command that exits immediately after exec', async () => {
    // Signoff covers both commands once; the explicit stress gate repeats the races.
    const attempts = process.env.SESSION_KEEPER_STRESS === '1' ? 10 : 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = await fixture('', undefined, ['/usr/bin/true'])
      await until(() => value.session.exitCode === 0)
      expect(value.output()).toBe('')
      await value.session.terminate()
      await until(() => !alive(value.status.ownerPid))
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = await fixture('', undefined, [
        '/bin/sh',
        '-c',
        'printf IMMEDIATE; exit 9'
      ])
      await until(() => value.session.exitCode === 9)
      expect(value.output()).toBe('IMMEDIATE')
      await value.session.terminate()
      await until(() => !alive(value.status.ownerPid))
    }
  })

  it('preserves the version-1 signalled-exit code and its output fence', async () => {
    const value = await fixture(`
      console.log('READY');
      setInterval(()=>{},1000);
    `)
    await until(() => value.output().includes('READY'))
    value.session.kill('SIGTERM')
    await until(() => value.session.exitCode === 0)
    const records = []
    for await (const record of SessionJournal.readRetained(value.directory)) {
      records.push(record)
    }
    expect(records.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 })
    expect(
      records
        .filter((record) => record.type === 'output')
        .map((record) => record.data)
        .join('')
    ).toBe('READY\r\n')
    await value.session.terminate()
  })

  it('authenticates independent close even while an engine is paused and rejects malformed requests', async () => {
    const value = await fixture(
      "console.log('READY'); setInterval(()=>console.log('OUTPUT'),1)"
    )
    await until(() => value.output().includes('READY'))
    const rejected = await control(value.session.manifest.socketPath, {
      method: 'inspect',
      id: 'bad',
      token: 'wrong'
    })
    expect(rejected).toMatchObject({ type: 'response', status: null })
    const duplicate = await control(value.session.manifest.socketPath, {
      method: 'attach',
      id: 'second',
      token: value.session.manifest.token
    })
    expect(duplicate).toMatchObject({ type: 'response', status: null })
    const malformed: Record<string, string | number>[] = [
      { method: 'resize', cols: -1, rows: 24 },
      { method: 'pause', paused: 0 },
      { method: 'write', data: 'x', encoding: 'hex' },
      { method: 'signal', signal: 'SIGSTOP' },
      { method: 'processed', sequence: Number.MAX_SAFE_INTEGER + 1 },
      {
        method: 'attach',
        token: value.session.manifest.token,
        journalLimitBytes: 0
      },
      { method: 'metadata' },
      { method: 'unknown' }
    ]
    for (const request of malformed) {
      expect(
        await control(value.session.manifest.socketPath, {
          id: 'invalid-request',
          ...request
        })
      ).toMatchObject({ type: 'fault' })
    }
    expect(alive(value.status.pid)).toBe(true)
    value.session.pause()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await Promise.all([value.session.terminate(), value.session.terminate()])
    await until(() => !alive(value.status.ownerPid) && !alive(value.status.pid))
  })

  it('acknowledges attached close after replay before shutting down the owner', async () => {
    const attempts = process.env.SESSION_KEEPER_STRESS === '1' ? 3 : 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = await fixture(`
        process.stdout.write('r'.repeat(2*1024*1024));
        console.log('READY');
        setInterval(()=>console.log('LIVE'),10);
      `)
      await until(() => value.output().includes('READY'))
      value.session.dispose()
      await new Promise((resolve) => setTimeout(resolve, 150))
      const socket = net.createConnection(value.session.manifest.socketPath)
      socket.write(
        `${JSON.stringify({
          method: 'attach',
          id: 'raw-attach',
          token: value.session.manifest.token
        })}\n`
      )
      let status: ReturnType<typeof sessionStatusSchema.parse> | null = null
      for await (const frame of frames(socket)) {
        expect(frame.type).not.toBe('fault')
        if (frame.type === 'response') {
          expect(frame.error).toBeNull()
        }

        if (frame.type === 'ready') {
          socket.write(
            `${JSON.stringify({ method: 'pause', id: 'raw-live', paused: false })}\n`
          )
          socket.write(
            `${JSON.stringify({ method: 'terminate', id: 'raw-close' })}\n`
          )
        }

        if (frame.type === 'response' && frame.id === 'raw-close') {
          status = frame.status
          break
        }
      }
      expect(status).toMatchObject({
        ownerPid: value.status.ownerPid,
        pid: value.status.pid
      })
      await until(
        () => !alive(value.status.ownerPid) && !alive(value.status.pid)
      )
      await expect(fs.access(value.directory)).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  })

  it('lets an admitted authenticated close replace a backpressured close after cleanup', async () => {
    const value = await fixture("console.log('READY');setInterval(()=>{},1000)")
    await until(() => value.output().includes('READY'))
    value.session.dispose()
    await new Promise((resolve) => setTimeout(resolve, 150))
    // Admit the replacement BEFORE cleanup unlinks the socket; authenticate it
    // AFTER cleanup. The first close's huge valid id backpressures its reply.
    const replacement = net.createConnection(value.session.manifest.socketPath)
    await once(replacement, 'connect')
    const engine = net.createConnection(value.session.manifest.socketPath)
    const reader = frames(engine)
    try {
      engine.write(
        `${JSON.stringify({
          method: 'attach',
          id: 'raw-attach',
          token: value.session.manifest.token
        })}\n`
      )
      for (;;) {
        const next = await reader.next()
        expect(next.done).toBe(false)
        if (next.done) {
          throw new Error('Raw engine disconnected before ready')
        }

        expect(next.value.type).not.toBe('fault')
        if (next.value.type === 'response') {
          expect(next.value.error).toBeNull()
        }

        if (next.value.type === 'ready') {
          break
        }
      }
      engine.pause()
      engine.write(
        `${JSON.stringify({ method: 'terminate', id: 't'.repeat(2 * 1024 * 1024) })}\n`
      )
      await until(async () => {
        const retained = await fs.lstat(value.directory).catch((cause) => {
          // SAFETY: Node filesystem errors expose errno codes.
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw cause
          }

          return null
        })
        return retained === null
      })
      replacement.write(
        `${JSON.stringify({
          method: 'terminate',
          id: 'replacement-close',
          token: value.session.manifest.token
        })}\n`
      )
      let acknowledged = false
      for await (const frame of frames(replacement)) {
        expect(frame).toMatchObject({
          type: 'response',
          id: 'replacement-close',
          error: null,
          status: { ownerPid: value.status.ownerPid, pid: value.status.pid }
        })
        acknowledged = true
        break
      }
      expect(acknowledged).toBe(true)
      await until(
        () => !alive(value.status.ownerPid) && !alive(value.status.pid)
      )
    } finally {
      engine.destroy()
      replacement.destroy()
      await reader.return(undefined)
    }
  })

  it('retains live group members after leader exit and excludes independent daemon sessions', async () => {
    // Descendants must not hold the PTY open: exitCode follows captured EOF,
    // not just leader exit. Keep the process alive without retaining its stdio.
    const value = await fixture(`
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('background.pid',String(process.pid));process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>{child.disconnect();child.unref();process.exit(0)});
    `)
    await until(async () =>
      (await fs.readdir(value.root)).includes('background.pid')
    )
    const background = Number(
      await fs.readFile(path.join(value.root, 'background.pid'), 'utf8')
    )
    pids.add(background)
    await until(() => value.session.exitCode === 0)
    expect(alive(background)).toBe(true)
    await value.session.terminate()
    await until(() => !alive(background))
    await expect(fs.access(value.directory)).rejects.toMatchObject({
      code: 'ENOENT'
    })

    const separate = await fixture(`
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('detached.pid',String(process.pid));setTimeout(()=>process.exit(0),4000)"],{detached:true,stdio:'ignore'});
      child.unref();setInterval(()=>{},1000);
    `)
    await until(async () =>
      (await fs.readdir(separate.root)).includes('detached.pid')
    )
    const detached = Number(
      await fs.readFile(path.join(separate.root, 'detached.pid'), 'utf8')
    )
    pids.add(detached)
    await separate.session.terminate()
    expect(alive(detached)).toBe(true)
    // This deliberately independent fixture self-expires; no cached-PID kill.
    await until(() => !alive(detached))
  })

  it('cleans reparented separate groups in the original terminal session', async () => {
    // The background group survives the leader without delaying captured EOF.
    const value = await fixture('', undefined, [
      '/bin/bash',
      '-c',
      'set -m; "$1" -e "$2" </dev/null >/dev/null 2>&1 & while [ ! -f separate-group.pid ]; do sleep 0.01; done; exit 0',
      'fixture',
      process.execPath,
      "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('separate-group.pid',String(process.pid));setTimeout(()=>process.exit(0),8000)"
    ])
    await until(async () =>
      (await fs.readdir(value.root)).includes('separate-group.pid')
    )
    const background = Number(
      await fs.readFile(path.join(value.root, 'separate-group.pid'), 'utf8')
    )
    pids.add(background)
    await until(() => value.session.exitCode === 0)
    expect(alive(background)).toBe(true)
    const started = Date.now()
    await value.session.terminate()
    await until(() => !alive(background))
    // Waiting for the self-expiry must not masquerade as verified cleanup.
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('matches Buffer encodings for opaque UTF-16 input with the Rust owner', async () => {
    const units = Array.from({ length: 65536 }, (_, unit) => unit)
    const allCodeUnits = String.fromCharCode(...units)
    // Padding ends Node's decode early. Omit its low-byte aliases from this
    // corpus so base64 conversion also exercises units after the first page.
    const allBase64CodeUnits = String.fromCharCode(
      ...units.filter((unit) => (unit & 0xff) !== 0x3d)
    )
    const cases = [
      ...[
        '\ud800Z',
        '\udfffZ',
        '\ud800X\udc00',
        '\ud800\ud800\udc00\udfff',
        '🌲Ł\u0000"\\\r\n',
        allCodeUnits
      ].map((data) => ({ data, encoding: 'utf8' as const })),
      ...[
        'aGVs bG8!',
        'aGVsbG8=ignored',
        '\u0141Q==',
        '\ud841Q==',
        '\ud800\ud841Q==\udfff',
        'AQ\u013dignored',
        '🌲AQ',
        allBase64CodeUnits
      ].map((data) => ({ data, encoding: 'base64' as const }))
    ].map((value) => ({
      ...value,
      bytes: Buffer.from(value.data, value.encoding)
    }))
    const value = await fixture(
      `
        process.stdin.setRawMode(true);
        const lengths=${JSON.stringify(cases.map((value) => value.bytes.length))};
        let index=0, input=Buffer.alloc(0);
        console.log('READY');
        process.stdin.on('data',chunk=>{
          input=Buffer.concat([input,chunk]);
          while(index<lengths.length && input.length>=lengths[index]) {
            const length=lengths[index];
            console.log('HEX:'+index+':'+input.subarray(0,length).toString('hex'));
            input=input.subarray(length); index++;
          }
        });
      `,
      undefined,
      undefined,
      os.tmpdir(),
      null
    )
    await until(() => value.output().includes('READY'))
    value.session.dispose()
    const socket = net.createConnection(value.session.manifest.socketPath)
    const iterator = frames(socket)
    let output = ''
    async function receiveUntil(done: (frame: SessionFrame) => boolean) {
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          throw new Error('Input fixture disconnected before its fence')
        }

        const frame = next.value
        if (frame.type === 'output') {
          output += frame.data
        }

        if (frame.type === 'fault') {
          throw new Error(frame.message)
        }

        if (frame.type === 'response') {
          expect(frame.error).toBeNull()
        }

        if (done(frame)) {
          return
        }
      }
    }

    try {
      socket.write(
        `${JSON.stringify({ method: 'attach', id: 'input-attach', token: value.session.manifest.token })}\n`
      )
      await receiveUntil((frame) => frame.type === 'ready')
      socket.write(
        `${JSON.stringify({ method: 'pause', id: 'input-live', paused: false })}\n`
      )
      await receiveUntil(
        (frame) => frame.type === 'response' && frame.id === 'input-live'
      )
      for (const [index, input] of cases.entries()) {
        const id = `input-${index}`
        const expected = `HEX:${index}:${input.bytes.toString('hex')}\n`
        socket.write(
          `${JSON.stringify({ method: 'write', id, data: input.data, encoding: input.encoding })}\n`
        )
        let replied = false
        await receiveUntil((frame) => {
          if (frame.type === 'response' && frame.id === id) {
            replied = true
          }

          return replied && output.replaceAll('\r\n', '\n').includes(expected)
        })
      }
      await value.session.terminate()
    } finally {
      await iterator.return(undefined)
      socket.destroy()
    }
  })

  it('forwards all binary input bytes through the v1 base64 write encoding', async () => {
    const value = await fixture(`
      process.stdin.setRawMode(true);
      let bytes=Buffer.alloc(0);
      process.stdin.on('data',data=>{
        bytes=Buffer.concat([bytes,data]);
        if(bytes.length===256) console.log('HEX:'+bytes.toString('hex'));
      });
      console.log('READY');
    `)
    await until(() => value.output().includes('READY'))
    const input = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
    value.session.write(input)
    await until(() => value.output().includes(`HEX:${input.toString('hex')}`))
    expect(value.session.fault).toBeNull()
    await value.session.terminate()
  })

  it('does not publish natural exit ahead of a quota-blocked capture tail', async () => {
    const value = await fixture(
      `
      console.log('BOOT');
      setTimeout(()=>process.stdout.write('r'.repeat(512*1024),()=>{
        process.stdout.write('TAIL🌲',()=>process.exit(7));
      }),100);
    `,
      1024
    )
    await until(() => value.session.fault !== null)
    expect(value.output()).not.toContain('TAIL🌲')
    expect(
      await control(value.session.manifest.socketPath, {
        method: 'inspect',
        id: 'quota-blocked-exit',
        token: value.session.manifest.token
      })
    ).toMatchObject({ status: { exitCode: null } })
    value.session.dispose()
    const resumed = await PersistentSession.open(
      value.directory,
      2 * 1024 * 1024
    )
    sessions.push(resumed)
    let output = ''
    resumed.onData((data) => {
      output += data
    })
    await resumed.connect()
    await resumed.ready
    await resumed.activate()
    await until(async () => {
      const inspected = await control(resumed.manifest.socketPath, {
        method: 'inspect',
        id: 'exit-fence',
        token: resumed.manifest.token
      })
      return inspected.type === 'response' && inspected.status?.exitCode === 7
    })
    const records = []
    for await (const record of SessionJournal.readRetained(value.directory)) {
      records.push(record)
    }
    expect(records.at(-1)).toMatchObject({ type: 'exit', exitCode: 7 })
    expect(
      records
        .filter((record) => record.type === 'output')
        .map((record) => record.data)
        .join('')
    ).toBe(`BOOT\r\n${'r'.repeat(512 * 1024)}TAIL🌲`)
    await until(() => resumed.exitCode === 7)
    expect(output).toBe(`BOOT\r\n${'r'.repeat(512 * 1024)}TAIL🌲`)
    await resumed.terminate()
  })

  it('applies a quota-blocked resize when its retained fence commits on reattach', async () => {
    const value = await fixture(
      `
      process.stdin.setRawMode(true);
      console.log('READY');
      process.stdin.on('data',()=>console.log('WINDOW='+require('node:child_process').execFileSync('/bin/stty',['size'],{stdio:[0,'pipe',2]}).toString().trim()));
    `,
      120
    )
    await until(() => value.output().includes('READY'))
    await expect(value.session.resizeAndWait(101, 37)).rejects.toThrow()
    const before = await control(value.session.manifest.socketPath, {
      method: 'inspect',
      id: 'uncommitted-resize',
      token: value.session.manifest.token
    })
    expect(before).toMatchObject({
      type: 'response',
      status: { cols: 80, rows: 24 }
    })
    value.session.dispose()
    const resumed = await PersistentSession.open(value.directory, 100000)
    sessions.push(resumed)
    const sizes: number[][] = []
    let output = ''
    resumed.onResize((cols, rows) => sizes.push([cols, rows]))
    resumed.onData((data) => {
      output += data
    })
    await resumed.connect()
    await resumed.ready
    await resumed.activate()
    expect(sizes).toEqual([[101, 37]])
    const after = await control(resumed.manifest.socketPath, {
      method: 'inspect',
      id: 'committed-resize',
      token: resumed.manifest.token
    })
    expect(after).toMatchObject({
      type: 'response',
      status: { cols: 101, rows: 37, error: null, incomplete: false }
    })
    resumed.write('size')
    await until(() => output.includes('WINDOW='))
    expect(output).toContain('WINDOW=37 101')
    await resumed.terminate()
  })

  // Root bypasses mode-bit permissions; do not count that as EACCES coverage.
  it.each(
    process.getuid?.() === 0
      ? ['directory', 'fifo']
      : ['directory', 'fifo', 'readonly-file']
  )(
    'recovers losslessly from a filesystem checkpoint failure on reattach (%s)',
    async (kind) => {
      const value = await fixture(`
      process.stdin.setRawMode(true);
      console.log('READY');
      process.stdin.once('data',()=>process.stdout.write('f'.repeat(2*1024*1024),()=>{
        process.stdout.write('STORAGE_RECOVERED🌲',()=>process.exit(7));
      }));
    `)
      await until(() => value.output().includes('READY'))
      const obstruction = path.join(
        value.directory,
        'checkpoint-0000000001.gz.tmp'
      )
      if (kind === 'directory') {
        await fs.mkdir(obstruction)
      } else if (kind === 'fifo') {
        await execute('mkfifo', [obstruction])
      } else {
        await fs.writeFile(obstruction, 'unchanged', { mode: 0o400 })
      }

      value.session.write('GO')
      await until(() => value.session.fault !== null)
      expect(value.output()).not.toContain('STORAGE_RECOVERED')
      const inspected = await control(value.session.manifest.socketPath, {
        method: 'inspect',
        id: 'storage-fault',
        token: value.session.manifest.token
      })
      expect(inspected).toMatchObject({
        type: 'response',
        status: { incomplete: false, exitCode: null }
      })
      if (kind === 'fifo' || kind === 'directory') {
        expect(
          inspected.type === 'response' && inspected.status?.error
        ).toMatch(/not a regular file/)
      }

      if (kind === 'readonly-file') {
        expect(
          inspected.type === 'response' && inspected.status?.error
        ).toMatch(/Permission denied|os error 13/)
        expect(await fs.readFile(obstruction, 'utf8')).toBe('unchanged')
        const committed =
          inspected.type === 'response' ? inspected.status?.sequence : null
        const before = await fs.stat(
          path.join(value.directory, 'journal.jsonl')
        )
        await new Promise((resolve) => setTimeout(resolve, 250))
        const after = await fs.stat(path.join(value.directory, 'journal.jsonl'))
        expect(after.size).toBe(before.size)
        expect(after.mtimeMs).toBe(before.mtimeMs)
        const stable = await control(value.session.manifest.socketPath, {
          method: 'inspect',
          id: 'permission-stable-fence',
          token: value.session.manifest.token
        })
        expect(stable).toMatchObject({
          type: 'response',
          status: { sequence: committed, incomplete: false, exitCode: null }
        })
      }

      value.session.dispose()
      await fs.rm(obstruction, { recursive: kind === 'directory' })
      const resumed = await PersistentSession.open(value.directory)
      sessions.push(resumed)
      let output = ''
      resumed.onData((data) => {
        output += data
      })
      await resumed.connect()
      await resumed.ready
      await resumed.activate()
      await until(() => resumed.exitCode === 7)
      expect(resumed.fault).toBeNull()
      expect(output).toBe(
        `READY\r\n${'f'.repeat(2 * 1024 * 1024)}STORAGE_RECOVERED🌲`
      )
      const records = []
      for await (const record of SessionJournal.readRetained(value.directory)) {
        records.push(record)
      }
      expect(records.at(-1)).toMatchObject({ type: 'exit', exitCode: 7 })
      expect(
        records
          .filter((record) => record.type === 'output')
          .map((record) => record.data)
          .join('')
      ).toBe(output)
      await resumed.terminate()
    }
  )

  it('refuses a second bootstrap without changing the running owner or its journal', async () => {
    const value = await fixture(`
      process.stdin.setRawMode(true);
      console.log('READY');
      process.stdin.on('data',()=>console.log('ORIGINAL_OWNER'));
      setInterval(()=>{},1000);
    `)
    await until(() => value.output().includes('READY'))
    const manifest = await fs.readFile(
      path.join(value.directory, 'manifest.json'),
      'utf8'
    )
    const journal = await fs.readFile(
      path.join(value.directory, 'journal.jsonl'),
      'utf8'
    )
    await expect(
      PersistentSession.create({
        directory: value.directory,
        executable: binary,
        argv: ['/usr/bin/true'],
        cwd: value.root,
        env: {},
        cols: 80,
        rows: 24,
        metadata: '{}'
      })
    ).rejects.toThrow()
    await expect(
      execute(binary, [value.directory], { timeout: 2000 })
    ).rejects.toThrow(/not fresh/)
    expect(
      await fs.readFile(path.join(value.directory, 'manifest.json'), 'utf8')
    ).toBe(manifest)
    expect(
      await fs.readFile(path.join(value.directory, 'journal.jsonl'), 'utf8')
    ).toBe(journal)
    const inspected = await control(value.session.manifest.socketPath, {
      method: 'inspect',
      id: 'original-owner-after-refused-bootstrap',
      token: value.session.manifest.token
    })
    expect(inspected).toMatchObject({
      type: 'response',
      error: null,
      status: {
        ownerPid: value.status.ownerPid,
        pid: value.status.pid,
        exitCode: null
      }
    })
    value.session.write('CHECK')
    await until(() => value.output().includes('ORIGINAL_OWNER'))
    await value.session.terminate()
  })

  it.each([2 * SESSION_MAX_FRAME_BYTES + 1, 1024 ** 4])(
    'rejects an oversized sparse manifest before parsing or creating session resources (%s bytes)',
    async (size) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-rust-session-'))
      roots.push(root)
      const file = path.join(root, 'manifest.json')
      const descriptor = await fs.open(file, 'wx', 0o600)
      try {
        // Sparse invalid JSON: no implementation can launch a real child from
        // this fixture, including the pre-fix reference used for the red run.
        await descriptor.write('{')
        await descriptor.truncate(size)
      } finally {
        await descriptor.close()
      }
      const before = await fs.stat(file)
      await expect(execute(binary, [root], { timeout: 2000 })).rejects.toThrow(
        /Session manifest exceeds the byte limit/
      )
      const after = await fs.stat(file)
      expect(after.ino).toBe(before.ino)
      expect(after.size).toBe(size)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(await fs.readdir(root)).toEqual(['manifest.json'])
    }
  )

  it('rejects a FIFO manifest before creating a journal or command', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-rust-session-'))
    roots.push(root)
    await execute('mkfifo', [path.join(root, 'manifest.json')])
    await expect(execute(binary, [root], { timeout: 2000 })).rejects.toThrow(
      /not a regular file/
    )
    expect(await fs.readdir(root)).toEqual(['manifest.json'])
  })

  it.each(['fifo', 'symlink'] as const)(
    'rejects unsafe metadata storage without leaking credentials and keeps independent close responsive (%s)',
    async (kind) => {
      const value = await fixture(
        "console.log('READY');setInterval(()=>{},1000)"
      )
      await until(() => value.output().includes('READY'))
      const original = await fs.readFile(
        path.join(value.directory, 'manifest.json'),
        'utf8'
      )
      const obstruction = path.join(value.directory, 'manifest.json.tmp')
      const outside = path.join(value.root, 'outside')
      if (kind === 'fifo') {
        await execute('mkfifo', [obstruction])
      } else {
        await fs.writeFile(outside, 'untouched')
        await fs.symlink(outside, obstruction)
      }

      const reader =
        kind === 'fifo'
          ? await fs.open(
              obstruction,
              constants.O_RDONLY | constants.O_NONBLOCK
            )
          : null
      try {
        await expect(
          value.session.setMetadata('{"retry":true}')
        ).rejects.toThrow(/not a regular file|Too many levels|os error 40/)
        expect(
          await fs.readFile(path.join(value.directory, 'manifest.json'), 'utf8')
        ).toBe(original)
        if (reader !== null) {
          expect((await reader.read(Buffer.alloc(1024))).bytesRead).toBe(0)
        } else {
          expect(await fs.readFile(outside, 'utf8')).toBe('untouched')
        }

        const inspected = await control(value.session.manifest.socketPath, {
          method: 'inspect',
          id: 'fifo-metadata-inspect',
          token: value.session.manifest.token
        })
        expect(inspected).toMatchObject({
          type: 'response',
          error: null,
          status: {
            ownerPid: value.status.ownerPid,
            pid: value.status.pid,
            exitCode: null
          }
        })
        // Do not repair the obstruction before exercising independently
        // authenticated close: a failed metadata operation must not strand it.
        const closed = await control(value.session.manifest.socketPath, {
          method: 'terminate',
          id: 'fifo-metadata-close',
          token: value.session.manifest.token
        })
        expect(closed).toMatchObject({ type: 'response', error: null })
        await until(
          () => !alive(value.status.ownerPid) && !alive(value.status.pid)
        )
        if (kind === 'symlink') {
          expect(await fs.readFile(outside, 'utf8')).toBe('untouched')
        }
      } finally {
        await reader?.close()
      }
    }
  )

  it.runIf(process.getuid?.() !== 0)(
    'preserves manifest credentials after a permission-denied metadata update and retries safely',
    async () => {
      const value = await fixture(
        "console.log('READY');setInterval(()=>{},1000)"
      )
      await until(() => value.output().includes('READY'))
      const original = await fs.readFile(
        path.join(value.directory, 'manifest.json'),
        'utf8'
      )
      const obstruction = path.join(value.directory, 'manifest.json.tmp')
      await fs.writeFile(obstruction, 'unchanged', { mode: 0o400 })
      await expect(value.session.setMetadata('{"retry":true}')).rejects.toThrow(
        /Permission denied|os error 13/
      )
      expect(
        await fs.readFile(path.join(value.directory, 'manifest.json'), 'utf8')
      ).toBe(original)
      expect(await fs.readFile(obstruction, 'utf8')).toBe('unchanged')
      const inspected = await control(value.session.manifest.socketPath, {
        method: 'inspect',
        id: 'metadata-denied',
        token: value.session.manifest.token
      })
      expect(inspected).toMatchObject({
        type: 'response',
        error: null,
        status: {
          ownerPid: value.status.ownerPid,
          pid: value.status.pid,
          incomplete: false,
          exitCode: null
        }
      })
      value.session.dispose()
      await fs.chmod(obstruction, 0o600)
      const resumed = await PersistentSession.open(value.directory)
      sessions.push(resumed)
      expect(resumed.manifest.token).toBe(value.session.manifest.token)
      await resumed.connect()
      await resumed.ready
      await resumed.activate()
      await resumed.setMetadata('{"retry":true}')
      const retained = await PersistentSession.open(value.directory)
      sessions.push(retained)
      expect(retained.manifest.metadata).toBe('{"retry":true}')
      expect(retained.manifest.token).toBe(value.session.manifest.token)
      expect(alive(value.status.pid)).toBe(true)
      expect(resumed.fault).toBeNull()
      await resumed.terminate()
    }
  )

  it.runIf(process.getuid?.() !== 0)(
    'retains final capture and authenticated close authority after deletion is permission-denied',
    async () => {
      const value = await fixture(
        "console.log('READY');setInterval(()=>{},1000)"
      )
      await until(() => value.output().includes('READY'))
      const original = await fs.readFile(
        path.join(value.directory, 'manifest.json'),
        'utf8'
      )
      await fs.chmod(value.directory, 0o500)
      try {
        await expect(value.session.terminate()).rejects.toThrow(
          /Permission denied|os error 13/
        )
        // Close already verified descendant cleanup, but failed to delete any
        // files. The owner must retain discovery and journal commit authority.
        await until(() => !alive(value.status.pid))
        expect(alive(value.status.ownerPid)).toBe(true)
        expect(
          await fs.readFile(path.join(value.directory, 'manifest.json'), 'utf8')
        ).toBe(original)
        await until(async () => {
          const inspected = await control(value.session.manifest.socketPath, {
            method: 'inspect',
            id: 'failed-close-exit-fence',
            token: value.session.manifest.token
          })
          expect(inspected).toMatchObject({
            type: 'response',
            error: null,
            status: {
              ownerPid: value.status.ownerPid,
              pid: value.status.pid,
              incomplete: false
            }
          })
          return (
            inspected.type === 'response' && inspected.status?.exitCode === 0
          )
        })
        const records = []
        for await (const record of SessionJournal.readRetained(
          value.directory
        )) {
          records.push(record)
        }
        expect(records.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 })
        expect(
          records
            .filter((record) => record.type === 'output')
            .map((record) => record.data)
            .join('')
        ).toBe('READY\r\n')
      } finally {
        // Restore only this fixture so teardown can retry authenticated close
        // even if an assertion fails. Never delete a live owner's evidence.
        await fs.chmod(value.directory, 0o700)
      }
      value.session.dispose()
      const resumed = await PersistentSession.open(value.directory)
      sessions.push(resumed)
      let output = ''
      resumed.onData((data) => {
        output += data
      })
      await resumed.connect()
      await resumed.ready
      await resumed.activate()
      await until(() => resumed.exitCode === 0)
      expect(output).toBe('READY\r\n')
      expect(resumed.fault).toBeNull()
      await resumed.terminate()
      await until(() => !alive(value.status.ownerPid))
    }
  )

  it('refuses unexpected subtrees before deleting payload and permits authenticated retry after repair', async () => {
    const value = await fixture("console.log('READY');setInterval(()=>{},1000)")
    await until(() => value.output().includes('READY'))
    const blocked = path.join(value.directory, 'unexpected')
    await fs.mkdir(blocked)
    await fs.writeFile(path.join(blocked, 'sentinel'), 'not keeper payload')
    const manifest = await fs.readFile(
      path.join(value.directory, 'manifest.json'),
      'utf8'
    )
    const bootstrap = await fs.readFile(
      path.join(value.directory, 'owner.log'),
      'utf8'
    )
    try {
      await expect(value.session.terminate()).rejects.toThrow(
        /unexpected directory/
      )
      await until(() => !alive(value.status.pid))
      expect(alive(value.status.ownerPid)).toBe(true)
      expect(await fs.readFile(path.join(blocked, 'sentinel'), 'utf8')).toBe(
        'not keeper payload'
      )
      expect(
        await fs.readFile(path.join(value.directory, 'manifest.json'), 'utf8')
      ).toBe(manifest)
      expect(
        await fs.readFile(path.join(value.directory, 'owner.log'), 'utf8')
      ).toBe(bootstrap)
      const inspected = await control(value.session.manifest.socketPath, {
        method: 'inspect',
        id: 'unexpected-subtree-inspect',
        token: value.session.manifest.token
      })
      expect(inspected).toMatchObject({
        type: 'response',
        error: null,
        status: { ownerPid: value.status.ownerPid, incomplete: false }
      })
      const records = []
      for await (const record of SessionJournal.readRetained(value.directory)) {
        records.push(record)
      }
      expect(
        records
          .filter((record) => record.type === 'output')
          .map((record) => record.data)
          .join('')
      ).toBe('READY\r\n')
    } finally {
      // Repair only the injected fixture subtree before authenticated teardown;
      // the keeper itself never receives recursive deletion authority.
      await fs.rm(blocked, { recursive: true })
    }
    await value.session.terminate()
    await until(() => !alive(value.status.ownerPid))
  })

  // Root bypasses the mode-bit faults; do not count it as EACCES coverage.
  it.runIf(process.getuid?.() !== 0).each(['discovery', 'parent'])(
    'retains independent authenticated close after partial deletion (%s)',
    async (kind) => {
      const value = await fixture(
        "console.log('READY');setInterval(()=>{},1000)"
      )
      await until(() => value.output().includes('READY'))
      const original = JSON.parse(
        await fs.readFile(path.join(value.directory, 'manifest.json'), 'utf8')
      )
      const blocked =
        kind === 'discovery'
          ? path.join(value.directory, 'status.json')
          : value.root
      if (kind === 'discovery') {
        // Payload deletion succeeds before unlink of this discovery path fails.
        // Close must retain the token and never recurse into the replacement.
        await fs.rm(blocked)
        await fs.mkdir(blocked)
        await fs.writeFile(path.join(blocked, 'retained'), 'blocked data')
      }

      await fs.chmod(blocked, 0o500)
      try {
        await expect(value.session.terminate()).rejects.toThrow(
          kind === 'discovery'
            ? /Is a directory|Operation not permitted|os error (?:1|21)\b/
            : /Permission denied|os error 13/
        )
        await until(() => !alive(value.status.pid))
        expect(alive(value.status.ownerPid)).toBe(true)
        // The bootstrap log is deterministically deleted before this fault.
        expect(await fs.readdir(value.directory)).not.toContain('owner.log')
        expect(
          JSON.parse(
            await fs.readFile(
              path.join(value.directory, 'manifest.json'),
              'utf8'
            )
          )
        ).toEqual(original)
        const inspected = await control(value.session.manifest.socketPath, {
          method: 'inspect',
          id: 'partial-close-inspect',
          token: value.session.manifest.token
        })
        expect(inspected).toMatchObject({
          type: 'response',
          error: null,
          status: {
            ownerPid: value.status.ownerPid,
            pid: value.status.pid,
            incomplete: true
          }
        })
        expect(
          inspected.type === 'response' && inspected.status?.error
        ).toMatch(/close partially removed storage/)
        const sequence =
          inspected.type === 'response' ? inspected.status?.sequence : null
        await new Promise((resolve) => setTimeout(resolve, 250))
        const stable = await control(value.session.manifest.socketPath, {
          method: 'inspect',
          id: 'partial-close-stable-fence',
          token: value.session.manifest.token
        })
        expect(stable).toMatchObject({
          type: 'response',
          status: { sequence, incomplete: true }
        })
        if (kind === 'discovery') {
          expect(
            await fs.readFile(path.join(blocked, 'retained'), 'utf8')
          ).toBe('blocked data')
        } else {
          await until(async () => {
            const source = await fs
              .readFile(path.join(value.directory, 'status.json'), 'utf8')
              .catch((cause) => {
                // SAFETY: Only an absent publication may wait for the status worker.
                if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
                  throw cause
                }

                return null
              })
            return source !== null && JSON.parse(source).incomplete === true
          })
        }

        // Even if the active journal was already unlinked, retained failed-close
        // discovery cannot authorize a replacement native command.
        await expect(
          execute(binary, [value.directory], { timeout: 2000 })
        ).rejects.toThrow(/not fresh/)
      } finally {
        // Only this private fixture's blocked path, so authenticated teardown
        // remains possible after a failed assertion. No cached-PID signaling.
        await fs.chmod(blocked, 0o700)
        if (kind === 'discovery') {
          await fs.rm(blocked, { recursive: true })
        }
      }
      value.session.dispose()
      const resumed = await PersistentSession.open(value.directory)
      sessions.push(resumed)
      expect(resumed.manifest.token).toBe(value.session.manifest.token)
      // Do not attach or replay potentially removed data. Fresh discovery is
      // sufficient for the independent authenticated close transaction.
      await resumed.terminate()
      await until(() => !alive(value.status.ownerPid))
    }
  )

  // Disk-image attachment is explicitly opt-in; ordinary CI must not mount
  // volumes. Run with SESSION_KEEPER_DISK_FAULTS=1 on macOS to qualify ENOSPC.
  // Integration config strips all TREEPORT_* variables for instance isolation.
  it.runIf(
    process.platform === 'darwin' &&
      process.env.SESSION_KEEPER_DISK_FAULTS === '1'
  )(
    'recovers actual ENOSPC without losing output and closes independently while storage is full',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-keeper-disk-'))
      roots.push(root)
      const mount = path.join(root, 'mount')
      const image = path.join(root, 'fault.dmg')
      await fs.mkdir(mount)
      await execute('hdiutil', [
        'create',
        '-size',
        '24m',
        '-fs',
        'HFS+',
        '-volname',
        'TreeportKeeperFault',
        '-type',
        'UDIF',
        image
      ])
      await execute('hdiutil', [
        'attach',
        '-nobrowse',
        '-noautoopen',
        '-mountpoint',
        mount,
        image
      ])
      volumes.push(mount)
      const value = await fixture(
        `
        process.stdin.setRawMode(true);
        console.log('READY');
        process.stdin.once('data',()=>process.stdout.write('d'.repeat(2*1024*1024),()=>{
          process.stdout.write('DISK_RECOVERED🌲',()=>process.exit(7));
        }));
      `,
        undefined,
        undefined,
        mount
      )
      const independent = await fixture(
        "console.log('CLOSE_READY');setInterval(()=>{},1000)",
        undefined,
        undefined,
        mount
      )
      await until(
        () =>
          value.output().includes('READY') &&
          independent.output().includes('CLOSE_READY')
      )
      const fillerPath = path.join(mount, 'filler')
      const filler = await fs.open(fillerPath, 'wx', 0o600)
      let failureCode: string | null = null
      let written = 0
      const block = Buffer.alloc(64 * 1024, 0x61)
      // Even a misconfigured mount cannot exhaust the host: never write more
      // than 48 MiB to this unique fixture, and require a real ENOSPC result.
      while (written < 48 * 1024 * 1024) {
        const result = await filler.write(block).catch((cause: unknown) => {
          // SAFETY: Node filesystem write errors expose errno codes.
          failureCode = (cause as NodeJS.ErrnoException).code ?? null
          return null
        })
        if (result === null || result.bytesWritten === 0) {
          break
        }

        written += result.bytesWritten
      }
      await filler.close()
      expect(failureCode).toBe('ENOSPC')
      value.session.write('GO')
      await until(() => value.session.fault !== null)
      expect(value.output()).not.toContain('DISK_RECOVERED')
      const started = Date.now()
      const inspected = await control(value.session.manifest.socketPath, {
        method: 'inspect',
        id: 'disk-full',
        token: value.session.manifest.token
      })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(inspected).toMatchObject({
        type: 'response',
        status: { incomplete: false, exitCode: null }
      })
      expect(inspected.type === 'response' && inspected.status?.error).toMatch(
        /No space left on device|os error 28/
      )
      const stopped = await fs.stat(path.join(value.directory, 'journal.jsonl'))
      await new Promise((resolve) => setTimeout(resolve, 250))
      const idle = await fs.stat(path.join(value.directory, 'journal.jsonl'))
      expect(idle.size).toBe(stopped.size)
      expect(idle.mtimeMs).toBe(stopped.mtimeMs)
      await independent.session.terminate()
      await until(
        () =>
          !alive(independent.status.ownerPid) && !alive(independent.status.pid)
      )
      expect(alive(value.status.ownerPid)).toBe(true)
      value.session.dispose()
      await fs.rm(fillerPath)
      const resumed = await PersistentSession.open(value.directory)
      sessions.push(resumed)
      let output = ''
      resumed.onData((data) => {
        output += data
      })
      await resumed.connect()
      await resumed.ready
      await resumed.activate()
      await until(() => resumed.exitCode === 7)
      expect(resumed.fault).toBeNull()
      expect(output).toBe(
        `READY\r\n${'d'.repeat(2 * 1024 * 1024)}DISK_RECOVERED🌲`
      )
      const records = []
      for await (const record of SessionJournal.readRetained(value.directory)) {
        records.push(record)
      }
      expect(records.at(-1)).toMatchObject({ type: 'exit', exitCode: 7 })
      expect(
        records
          .filter((record) => record.type === 'output')
          .map((record) => record.data)
          .join('')
      ).toBe(output)
      await resumed.terminate()
    },
    60000
  )
})
