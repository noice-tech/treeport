import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
)

const results = path.resolve(
  process.argv[2] ??
    path.join(os.tmpdir(), `treeport-keeper-results-${Date.now()}`)
)

await fs.mkdir(results, { recursive: true })

const rustEntry = path.resolve(
  process.env.TREEPORT_KEEPER_RUST_BINARY ??
    path.join(
      root,
      'packages/session-keeper/native/target/release/treeport-session-keeper'
    )
)

const source = path.join(root, 'apps/treeport/src/terminal-runtime')
const journalEntry = path.join(source, 'session-journal.ts')
const protocolEntry = path.join(source, 'session-protocol.ts')

await Promise.all([fs.access(journalEntry), fs.access(protocolEntry)]).catch(
  () => {
    throw new Error(
      'Expected journal and protocol entries from a clean CLI build'
    )
  }
)

const { SessionJournal } = await import(pathToFileURL(journalEntry).href)

const { sessionFrameSchema, sessionManifestSchema } = await import(
  pathToFileURL(protocolEntry).href
)

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-keeper-'))
const fixtures = []
const observations = []

const outputInterval = Number(
  process.env.TREEPORT_KEEPER_OUTPUT_INTERVAL ?? '0.004'
)

assert.ok(Number.isFinite(outputInterval) && outputInterval > 0)

const python = (await exec('which', ['python3'])).stdout.trim()
const orphanProbe = process.env.TREEPORT_KEEPER_ORPHAN_PROBE ?? null

assert.ok(
  orphanProbe === null ||
    orphanProbe === 'independent-session' ||
    orphanProbe === 'same-session'
)

const workload = `
import os,sys,time,tty
sys.stdout.reconfigure(line_buffering=True)
tty.setraw(0)
os.write(1,b'BOOT\\n')
while True:
 c=os.read(0,1)
 if c==b'o':
  block=('output: '+('abcdef0123456789'*256)+' \\U0001f332\\n').encode()
  for i in range(2048):
   os.write(1,block); time.sleep(${outputInterval})
  os.write(1,b'OUTPUT_DONE\\n')
 elif c==b'u':
  for piece in [b'\\xf0',b'\\x9f',b'\\x8c',b'\\xb2']:
   os.write(1,piece); time.sleep(.03)
  os.write(1,b'UTF8_DONE\\n')
 elif c==b'q':
  os.write(1,b'\\x1b[6n')
  reply=b''
  while not reply.endswith(b'R'): reply+=os.read(0,1)
  os.write(1,b'REPLY:'+reply+b'\\n')
 elif c==b's':
  import struct,fcntl,termios
  rows,cols,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8))
  os.write(1,('SIZE:%dx%d\\n'%(cols,rows)).encode())
 elif c==b'e':
  os.write(1,b'FINAL_OUTPUT\\n'); sys.exit(7)
 elif c==b'd':
  import threading
  def detached_output():
   time.sleep(.3); os.write(1,b'DETACHED_OUTPUT\\n')
  threading.Thread(target=detached_output).start()
 elif c==b'b':
  for i in range(4096): os.write(1,b'quota:'+b'x'*4096+b'\\n')
  os.write(1,b'QUOTA_DONE\\n')
 elif c==b'c':
  intermediate=os.fork()
  if intermediate==0:
   orphan=os.fork()
   if orphan==0:
    ${orphanProbe === 'same-session' ? 'os.setpgid(0,0)' : 'os.setsid()'}
    os.write(1,('ORPHAN_PID:%d\\n'%os.getpid()).encode())
    time.sleep(8); os._exit(0)
   os._exit(0)
  os.waitpid(intermediate,0)
  os.write(1,b'ANCESTOR_REAPED\\n')
 else: os.write(1,b'INPUT:'+c+b'\\n')
`

await fs.writeFile(path.join(fixtureRoot, 'workload.py'), workload)

async function waitFor(condition, timeout = 15000) {
  const deadline = Date.now() + timeout

  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Fixture deadline exceeded')
    }

    await delay(20)
  }
}

class Wire {
  frames = []
  pending = new Map()
  output = ''
  sequence = 0
  queryReply = false
  constructor(socket, independentControl = false) {
    this.socket = socket
    let buffered = ''
    socket.setEncoding('utf8')
    socket.on('error', (error) => {
      this.error = error
    })
    socket.on('data', (data) => {
      buffered += data
      let boundary

      while ((boundary = buffered.indexOf('\n')) !== -1) {
        const frame = JSON.parse(buffered.slice(0, boundary))
        buffered = buffered.slice(boundary + 1)
        this.frames.push(frame)

        if (
          frame.type === 'output' ||
          frame.type === 'resize' ||
          frame.type === 'marker' ||
          frame.type === 'exit'
        ) {
          assert.equal(frame.sequence, this.sequence + 1)
          this.sequence = frame.sequence
        }

        if (frame.type === 'output') {
          this.output += frame.data

          if (
            this.queryReply &&
            this.output.includes('\x1b[6n') &&
            !this.replied
          ) {
            this.replied = true
            void this.request('write', { data: '\x1b[1;1R', encoding: 'utf8' })
          }
        }

        if (frame.type === 'response') {
          const pending = this.pending.get(frame.id)
          this.pending.delete(frame.id)
          pending?.resolve(frame)
        } else if (frame.type === 'fault' && independentControl) {
          for (const pending of this.pending.values()) {
            pending.reject(new Error(frame.message))
          }

          this.pending.clear()
        }
      }
    })
  }
  request(method, fields = {}) {
    const id = crypto.randomUUID()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timed out: ${method}`))
      }, 15000)

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.socket.write(`${JSON.stringify({ method, id, ...fields })}\n`)
    })
  }
  async ok(method, fields) {
    const response = await this.request(method, fields)
    assert.equal(response.error, null)

    return response.status
  }
  async write(data) {
    await this.ok('write', { data, encoding: 'utf8' })
  }
  close() {
    this.socket.destroy()
  }
}

async function wire(
  fixture,
  token = fixture.token,
  method = 'attach',
  fields = {},
  duringReplay = false
) {
  const socket = net.createConnection(fixture.socketPath)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const value = new Wire(socket, method !== 'attach')

  if (duringReplay) {
    socket.pause()
  }

  const pending = value.request(method, { token, ...fields })

  if (duringReplay) {
    await delay(500)
    await sample(fixture, 'replay-socket-backpressure')
    socket.resume()
  }

  const response = await pending.catch((error) => {
    value.close()
    throw error
  })

  if (method === 'attach' && response.error === null) {
    await waitFor(() => value.frames.some((frame) => frame.type === 'ready'))
    await value.ok('pause', { paused: false })
  }

  return { value, response }
}

async function fixture(limit = 512 * 1024 * 1024) {
  const kind = 'rust'
  const directory = await fs.mkdtemp(path.join(fixtureRoot, `${kind}-`))
  const home = await fs.mkdtemp(path.join(fixtureRoot, `${kind}-home-`))

  const socketPath = path.join(
    fixtureRoot,
    `${crypto.randomUUID().slice(0, 8)}.sock`
  )

  const token = crypto.randomBytes(32).toString('hex')
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      version: 1,
      ownership: 'lease-v1',
      token,
      socketPath,
      argv: [python, path.join(fixtureRoot, 'workload.py')],
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color' },
      cols: 80,
      rows: 24,
      metadata: '{}',
      journalLimitBytes: limit
    }),
    { mode: 0o600 }
  )

  const bootstrap = spawn(
    rustEntry,
    ['--detach', directory, 'treeport-session'],
    {
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )

  let stderr = ''
  bootstrap.stderr.on('data', (data) => {
    stderr += data
  })

  const fixture = {
    kind,
    directory,
    socketPath,
    token,
    status: null,
    closeAcknowledged: false,
    stderr: () => stderr
  }

  fixtures.push(fixture)
  await waitFor(async () => {
    fixture.status = await fs
      .readFile(path.join(directory, 'status.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null)

    return fixture.status !== null
  })
  await waitFor(() => bootstrap.exitCode === 0)
  assert.equal(stderr, '')
  const { value, response } = await wire(fixture)
  assert.equal(response.error, null)
  await waitFor(() => value.output.includes('BOOT'))
  fixture.engine = value
  fixture.status = await value.ok('status')
  assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600)

  return fixture
}

async function memory(pid, label) {
  const rssBytes =
    Number(
      (await exec('ps', ['-o', 'rss=', '-p', String(pid)])).stdout.trim()
    ) * 1024

  if (process.platform === 'linux') {
    const rollup = await fs.readFile(`/proc/${pid}/smaps_rollup`, 'utf8')

    const field = (name) =>
      Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(rollup)?.[1] ?? 0) *
      1024

    await fs.writeFile(path.join(results, `${label}-${pid}.smaps`), rollup)

    return {
      pid,
      rssBytes,
      privateResidentBytes: field('Private_Clean') + field('Private_Dirty'),
      pssBytes: field('Pss'),
      swapBytes: field('Swap'),
      metric: 'Linux smaps_rollup USS'
    }
  }

  assert.equal(process.platform, 'darwin')

  const map = (
    await exec('vmmap', ['-w', '-pages', String(pid)], {
      maxBuffer: 16 * 1024 * 1024
    })
  ).stdout

  const footprint = (
    await exec('footprint', ['-p', String(pid), '--format', 'bytes', '--wide'])
  ).stdout

  await fs.writeFile(path.join(results, `${label}-${pid}.vmmap`), map)
  await fs.writeFile(path.join(results, `${label}-${pid}.footprint`), footprint)
  let privateResidentLowerBoundBytes = 0
  let privateRegionCount = 0
  const pageSize = Number(/VM page size:\s*(\d+) bytes/.exec(map)?.[1])
  assert.ok(Number.isFinite(pageSize))

  for (const line of map.split('\n')) {
    const match =
      /\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\].*SM=(PRV|COW)/.exec(
        line
      )

    if (!match) {
      continue
    }

    privateRegionCount++
    privateResidentLowerBoundBytes +=
      Math.floor(Number(match[match[5] === 'PRV' ? 2 : 3])) * pageSize
  }

  assert.ok(privateRegionCount > 0)

  const footprintBytes = Number(
    /phys_footprint:\s*(\d+) B/.exec(footprint)?.[1]
  )

  assert.ok(Number.isFinite(footprintBytes))

  return {
    pid,
    rssBytes,
    privateResidentLowerBoundBytes,
    footprintBytes,
    metric:
      'macOS vmmap PRV resident + COW dirty (lower bound); footprint reported separately'
  }
}

async function sample(fixture, phase) {
  const value = await memory(
    fixture.status.ownerPid,
    `${fixture.kind}-${phase}`
  )

  observations.push({ kind: fixture.kind, phase, ...value })
  console.log(JSON.stringify(observations.at(-1)))
}

function alive(pid) {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error
    }

    return false
  }
}

async function stop(fixture) {
  fixture.engine?.close()

  if (!fixture.status) {
    return
  }

  if (fixture.closeAcknowledged) {
    await waitFor(
      () => !alive(fixture.status.ownerPid) && !alive(fixture.status.pid)
    )
    fixture.status = null

    return
  }

  const inspected = await wire(fixture, fixture.token, 'inspect')
  inspected.value.close()
  assert.equal(inspected.response.error, null)
  assert.equal(inspected.response.status.ownerPid, fixture.status.ownerPid)
  assert.equal(inspected.response.status.pid, fixture.status.pid)
  const closed = await wire(fixture, fixture.token, 'terminate')
  closed.value.close()
  assert.equal(closed.response.error, null)
  fixture.closeAcknowledged = true
  await waitFor(
    () => !alive(fixture.status.ownerPid) && !alive(fixture.status.pid)
  )
  fixture.status = null
}

try {
  const kind = 'rust'
  keeperMeasurement: {
    if (orphanProbe !== null) {
      const orphaned = await fixture()
      await orphaned.engine.write('c')
      await waitFor(
        () =>
          orphaned.engine.output.includes('ANCESTOR_REAPED') &&
          orphaned.engine.output.includes('ORPHAN_PID:')
      )
      const pid = Number(/ORPHAN_PID:(\d+)/.exec(orphaned.engine.output)[1])

      const topology = (
        await exec('ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid='])
      ).stdout.trim()

      assert.ok(alive(pid))
      const ownerPid = orphaned.status.ownerPid
      const leaderPid = orphaned.status.pid
      const started = performance.now()
      await stop(orphaned)
      const survived = alive(pid)
      const closeElapsedMs = performance.now() - started
      assert.ok(
        closeElapsedMs < 4000,
        'Self-expiry must not masquerade as cleanup'
      )

      const contractSatisfied =
        orphanProbe === 'same-session' ? !survived : survived

      observations.push({
        kind,
        phase: `pre-orphaned-${orphanProbe}-cleanup`,
        ownershipScope:
          'original terminal session; independent setsid daemons excluded',
        ownerPid,
        leaderPid,
        descendantPid: pid,
        topologyBeforeClose: topology,
        authenticatedCloseAcknowledged: true,
        descendantAliveAfterClose: survived,
        contractSatisfied,
        closeElapsedMs,
        cleanup: 'Descendant self-expires after 8 seconds; no cached-PID signal'
      })
      await waitFor(() => !alive(pid))
      assert.ok(
        contractSatisfied,
        'Rust terminal-session ownership contract failed'
      )

      break keeperMeasurement
    }

    const value = await fixture()
    const bad = await wire(value, 'x'.repeat(64), 'inspect')
    assert.ok(bad.response.error)
    bad.value.close()
    const second = await wire(value)
    assert.ok(second.response.error)
    second.value.close()
    await delay(1500)

    for (let n = 0; n < 3; n++) {
      await sample(value, `idle-${n}`)
    }

    const cpuSeconds = async () => {
      const source = (
        await exec('ps', ['-o', 'time=', '-p', String(value.status.ownerPid)])
      ).stdout.trim()

      const parts = source.split(':').map(Number)

      return parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1]
    }

    const cpuBefore = await cpuSeconds()
    const started = performance.now()
    await delay(5000)
    const cpuAfter = await cpuSeconds()
    const elapsedSeconds = (performance.now() - started) / 1000
    observations.push({
      kind,
      phase: 'idle-cpu',
      cpuSeconds: cpuAfter - cpuBefore,
      elapsedSeconds,
      percentOfOneCore: (100 * (cpuAfter - cpuBefore)) / elapsedSeconds,
      metric: 'ps cumulative CPU delta; coarse timer resolution'
    })
    observations.push({
      kind,
      phase: 'pty-command-idle',
      ...(await memory(value.status.pid, `${kind}-command`))
    })
    await value.engine.write('u')
    await waitFor(() => value.engine.output.includes('UTF8_DONE'))
    assert.ok(value.engine.output.includes('🌲UTF8_DONE'))
    assert.ok(!value.engine.output.includes('�'))
    value.engine.queryReply = true
    await value.engine.write('q')
    await waitFor(() => value.engine.output.includes('REPLY:\x1b[1;1R'))
    await value.engine.ok('resize', { cols: 101, rows: 31 })
    await value.engine.write('s')
    await waitFor(() => value.engine.output.includes('SIZE:101x31'))
    await value.engine.ok('marker', { data: 'opaque-engine-marker' })
    const outputBytesBefore = Buffer.byteLength(value.engine.output)
    const outputCpuBefore = await cpuSeconds()
    const outputStarted = performance.now()
    await value.engine.write('o')

    for (let n = 0; n < 3; n++) {
      await delay(1000)
      await sample(value, `output-${n}`)
    }

    await waitFor(() => value.engine.output.includes('OUTPUT_DONE'), 30000)
    const outputElapsedSeconds = (performance.now() - outputStarted) / 1000
    const outputCpuAfter = await cpuSeconds()

    const outputBytes =
      Buffer.byteLength(value.engine.output) - outputBytesBefore

    assert.equal(outputBytes, 2048 * 4110 + Buffer.byteLength('OUTPUT_DONE\n'))
    observations.push({
      kind,
      phase: 'output-cpu',
      cpuSeconds: outputCpuAfter - outputCpuBefore,
      elapsedSeconds: outputElapsedSeconds,
      percentOfOneCore:
        (100 * (outputCpuAfter - outputCpuBefore)) / outputElapsedSeconds,
      metric: 'Keeper-only ps cumulative CPU delta; coarse timer resolution',
      caveats:
        'Wall interval includes input admission, three suspending memory probes and 20ms completion polling; final CPU query is just after that interval'
    })
    const before = value.engine.output
    await value.engine.write('d')
    value.engine.close()
    await waitFor(async () => {
      let tail = ''

      for await (const record of SessionJournal.readRetained(value.directory)) {
        if (record.type === 'output') {
          tail = (tail + record.data).slice(-'DETACHED_OUTPUT\n'.length)
        }
      }

      return tail === 'DETACHED_OUTPUT\n'
    })
    const afterDetach = `${before}DETACHED_OUTPUT\n`
    const replayStarted = performance.now()
    const attached = await wire(value, value.token, 'attach', {}, true)
    const replayElapsedSeconds = (performance.now() - replayStarted) / 1000
    assert.equal(attached.response.error, null)
    value.engine = attached.value
    assert.equal(value.engine.output, afterDetach)
    observations.push({
      kind,
      phase: 'reconnect-replay',
      bytes: Buffer.byteLength(value.engine.output),
      elapsedSeconds: replayElapsedSeconds,
      metric: 'Authenticated reconnect through replay-ready and unpause fences',
      caveats:
        'Includes deliberate 500ms socket read pause, suspending backpressure memory probe and 20ms readiness polling; not unconstrained replay throughput'
    })

    const resizeIndex = value.engine.frames.findIndex(
      (f) => f.type === 'resize' && f.cols === 101
    )

    const sizeOutputIndex = value.engine.frames.findIndex(
      (f) => f.type === 'output' && f.data.includes('SIZE:101x31')
    )

    assert.ok(resizeIndex >= 0 && sizeOutputIndex > resizeIndex)
    assert.ok(
      value.engine.frames.some(
        (f) => f.type === 'marker' && f.data === 'opaque-engine-marker'
      )
    )
    await sample(value, 'replay-complete')
    await delay(5000)
    await sample(value, 'replay-settled-5s')
    observations.push({
      kind,
      phase: 'output-throughput',
      bytes: outputBytes,
      outputBlocks: 2048,
      outputBlockBytes: 4110,
      targetDurationSeconds: 2048 * outputInterval,
      elapsedSeconds: outputElapsedSeconds,
      bytesPerSecond: outputBytes / outputElapsedSeconds,
      includes: 'Fixed-count sustained output and OUTPUT_DONE delimiter only',
      caveats:
        'Wall interval includes input admission, three suspending memory probes and 20ms completion polling; configured target duration is not measured duration'
    })

    let retained = '',
      sequence = 0

    for await (const record of SessionJournal.readRetained(value.directory)) {
      assert.equal(record.sequence, ++sequence)

      if (record.type === 'output') {
        retained += record.data
      }
    }

    assert.equal(retained, afterDetach)

    for (const frame of value.engine.frames) {
      sessionFrameSchema.parse(frame)
    }

    sessionManifestSchema.parse(
      JSON.parse(
        await fs.readFile(path.join(value.directory, 'manifest.json'), 'utf8')
      )
    )
    await value.engine.ok('pause', { paused: true })
    await value.engine.write('z')
    await delay(300)
    const paused = await value.engine.ok('status')
    assert.ok(paused.sequence > value.engine.sequence)
    await value.engine.ok('marker', { data: 'forced-through-pause' })
    assert.ok(value.engine.output.includes('INPUT:z'))
    await value.engine.ok('pause', { paused: false })
    await value.engine.ok('processed', { sequence: value.engine.sequence })
    await value.engine.ok('metadata', { metadata: '{"updated":true}' })
    assert.equal(
      JSON.parse(
        await fs.readFile(path.join(value.directory, 'manifest.json'), 'utf8')
      ).metadata,
      '{"updated":true}'
    )
    await value.engine.ok('terminate')
    value.closeAcknowledged = true
    await waitFor(
      () => !alive(value.status.pid) && !alive(value.status.ownerPid)
    )
    value.status = null
    value.engine.close()
    console.log(
      `${kind}: authenticated protocol, UTF-8, query reply, resize/marker replay, TS journal recovery, pause, explicit termination passed`
    )

    const quota = await fixture(1024)
    await quota.engine.write('b')
    await waitFor(async () => (await quota.engine.ok('status')).error !== null)
    const quotaSequence = (await quota.engine.ok('status')).sequence
    await delay(500)
    assert.equal((await quota.engine.ok('status')).sequence, quotaSequence)

    const residentBefore = await memory(
      quota.status.ownerPid,
      `${kind}-quota-before`
    )

    await delay(1000)

    const residentAfter = await memory(
      quota.status.ownerPid,
      `${kind}-quota-after`
    )

    observations.push(
      { kind, phase: 'quota-blocked-before', ...residentBefore },
      { kind, phase: 'quota-blocked-after', ...residentAfter }
    )
    quota.engine.close()
    await delay(200)

    const resumed = await wire(quota, quota.token, 'attach', {
      journalLimitBytes: 512 * 1024 * 1024
    })

    assert.equal(resumed.response.error, null)
    quota.engine = resumed.value
    await waitFor(() => quota.engine.output.includes('QUOTA_DONE'), 30000)
    assert.ok(!quota.engine.output.includes('�'))
    await stop(quota)
    console.log(`${kind}: quota backpressure and raise-quota recovery passed`)

    const exiting = await fixture()
    await exiting.engine.write('e')
    await waitFor(() =>
      exiting.engine.frames.some((frame) => frame.type === 'exit')
    )

    const exitFrame = exiting.engine.frames.find(
      (frame) => frame.type === 'exit'
    )

    assert.equal(exitFrame.exitCode, 7)
    assert.ok(exiting.engine.output.endsWith('FINAL_OUTPUT\n'))

    for (const frame of exiting.engine.frames) {
      sessionFrameSchema.parse(frame)
    }

    const records = []

    for await (const record of SessionJournal.readRetained(exiting.directory)) {
      records.push(record)
    }

    assert.equal(records.at(-1).type, 'exit')
    assert.equal(records.at(-1).exitCode, 7)
    assert.ok(
      records
        .filter((record) => record.type === 'output')
        .map((record) => record.data)
        .join('')
        .endsWith('FINAL_OUTPUT\n')
    )
    await stop(exiting)
    console.log(
      `${kind}: natural exit follows final captured output and is TS-recoverable`
    )

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => fixture())
    )

    await delay(1500)

    const group = await Promise.all(
      concurrent.map((value, n) =>
        memory(value.status.ownerPid, `${kind}-concurrent-${n}`)
      )
    )

    observations.push({
      kind,
      phase: '8-concurrent-idle',
      processes: group,
      rssBytes: group.reduce((sum, item) => sum + item.rssBytes, 0),
      privateResidentLowerBoundBytes:
        process.platform === 'darwin'
          ? group.reduce(
              (sum, item) => sum + item.privateResidentLowerBoundBytes,
              0
            )
          : null,
      privateResidentBytes:
        process.platform === 'linux'
          ? group.reduce((sum, item) => sum + item.privateResidentBytes, 0)
          : null,
      footprintBytes:
        process.platform === 'darwin'
          ? group.reduce((sum, item) => sum + item.footprintBytes, 0)
          : null
    })

    for (const value of concurrent) {
      await stop(value)
    }
  }

  for (const [label, name] of [
    ['pi-existing-session', 'TREEPORT_KEEPER_PI_PID'],
    ['command-launcher-existing-session', 'TREEPORT_KEEPER_LAUNCHER_PID']
  ]) {
    if (process.env[name]) {
      const pid = Number(process.env[name])
      assert.ok(Number.isSafeInteger(pid) && pid > 1)

      const command = (
        await exec('ps', ['-o', 'comm=', '-p', String(pid)])
      ).stdout.trim()

      observations.push({
        kind: 'separate-runtime',
        phase: label,
        command,
        ...(await memory(pid, label))
      })
    }
  }

  const environment = {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    date: new Date().toISOString(),
    rustBinary: {
      path: rustEntry,
      sha256: crypto
        .createHash('sha256')
        .update(await fs.readFile(rustEntry))
        .digest('hex')
    },
    cpus: os.cpus()[0]?.model,
    mode:
      orphanProbe !== null
        ? `pre-orphaned-${orphanProbe}-cleanup-audit`
        : 'keeper-memory-and-protocol',
    ownershipScope:
      'original terminal session; independent setsid daemons excluded',
    workload:
      orphanProbe !== null
        ? `Python double-fork + ${orphanProbe === 'same-session' ? 'setpgid' : 'setsid'}; intermediate reaped before authenticated close; descendant self-expires after 8 seconds`
        : `same Python raw PTY; 2048 blocks of 4110 bytes ASCII+UTF8 output at target ${4110 / outputInterval} bytes/s; 8 concurrent idle keepers; release Rust`,
    outputIntervalSeconds: outputInterval,
    caveats:
      'Sequential ps/vmmap/footprint samples are not simultaneous; vmmap/footprint suspend targets; same workload and probe order for both; no forced Node GC; macOS private memory is a conservative resident lower bound, not USS; Pi/launcher are live-session snapshots, not controlled idle measurements',
    privateMetric:
      process.platform === 'darwin'
        ? 'Conservative lower bound, not USS; retained raw vmmap and footprint'
        : 'USS from smaps_rollup'
  }

  await fs.writeFile(
    path.join(results, 'results.json'),
    JSON.stringify({ environment, observations }, null, 2)
  )
  console.log(`Results: ${results}`)
} catch (error) {
  console.error(error)

  for (const value of fixtures) {
    if (!value.status) {
      continue
    }

    console.error(
      value.kind,
      value.stderr(),
      value.engine?.error,
      value.engine?.output.slice(-200)
    )
    console.error(
      await fs
        .readFile(path.join(value.directory, 'status.json'), 'utf8')
        .catch(() => 'status unavailable')
    )

    const retained = await fs.stat(value.directory).catch((cause) => {
      if (cause.code !== 'ENOENT') {
        throw cause
      }

      return null
    })

    await fs.writeFile(
      path.join(results, `${value.kind}-failure.json`),
      JSON.stringify(
        {
          error: String(error),
          fixture: value.directory,
          status: value.status,
          closeAcknowledged: value.closeAcknowledged,
          directoryRetained: retained !== null,
          observations
        },
        null,
        2
      )
    )

    if (retained !== null) {
      await fs.cp(
        value.directory,
        path.join(results, `${value.kind}-failed-fixture`),
        { recursive: true }
      )
    }
  }

  throw error
} finally {
  const cleanup = await Promise.allSettled(fixtures.map(stop))

  const failures = cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)

  if (failures.length) {
    console.error(
      new AggregateError(
        failures,
        `Fixture cleanup failed; evidence retained at ${fixtureRoot}`
      )
    )
    process.exitCode = 1
  } else {
    await fs.rm(fixtureRoot, { recursive: true, force: true })
  }
}
