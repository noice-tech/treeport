import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, it } from 'vitest'

const execute = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const appRoot = path.join(repositoryRoot, 'apps/treeport')
const panelSdkRoot = path.join(repositoryRoot, 'packages/panel-sdk')
let root
let npmCache
let candidateCliA
let candidateCliB
let candidateVersion
let candidateTarball
let candidateIntegrity
let candidatePrefix
const activeRoots = new Set()

async function command(executable, args, options = {}) {
  return execute(executable, args, {
    ...options,
    maxBuffer: 16 * 1024 * 1024
  })
}

async function installTarballs(tarballs, prefix) {
  await command(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...tarballs
    ],
    { env: { ...process.env, NPM_CONFIG_CACHE: npmCache } }
  )
  return path.join(prefix, 'bin/treeport')
}

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address)
  const port = address.port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function fixture(name) {
  const fixtureRoot = path.join(root, name)
  const dataDir = path.join(fixtureRoot, 'data')
  const runtimeDir = path.join(fixtureRoot, 'runtime')
  const home = path.join(fixtureRoot, 'home')
  const repository = path.join(fixtureRoot, 'repository')
  await Promise.all(
    [dataDir, runtimeDir, home, repository].map((directory) =>
      fs.mkdir(directory, { recursive: true })
    )
  )
  await command('git', ['init', '-q', '-b', 'main'], { cwd: repository })
  await command('git', ['config', 'user.email', 'fixture@treeport.test'], {
    cwd: repository
  })
  await command('git', ['config', 'user.name', 'Treeport Fixture'], {
    cwd: repository
  })
  await fs.writeFile(path.join(repository, 'fixture.txt'), 'fixture\n')
  await command('git', ['add', 'fixture.txt'], { cwd: repository })
  await command('git', ['commit', '-qm', 'fixture'], { cwd: repository })
  const port = await availablePort()
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    SHELL: '/bin/sh',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    TREEPORT_DATA_DIR: dataDir,
    TREEPORT_RUNTIME_DIR: runtimeDir,
    TREEPORT_HOST: '127.0.0.1',
    TREEPORT_PORT: String(port),
    TREEPORT_API_URL: `http://127.0.0.1:${port}`,
    TREEPORT_DAEMON_LIFECYCLE: 'treeport',
    TREEPORT_INSTALLATION_METHOD: 'npm'
  }
  activeRoots.add(fixtureRoot)
  return { fixtureRoot, dataDir, runtimeDir, repository, env }
}

async function runCli(cli, env, args) {
  return command(cli, args, {
    env: { ...env, TREEPORT_CLI_ENTRYPOINT: cli }
  })
}

async function readHostRecord(runtimeDir) {
  const name = (await fs.readdir(runtimeDir)).find(
    (entry) => entry.startsWith('terminal-host-') && entry.endsWith('.json')
  )
  assert(name, 'Terminal host record was not created')
  return {
    path: path.join(runtimeDir, name),
    value: JSON.parse(await fs.readFile(path.join(runtimeDir, name), 'utf8'))
  }
}

async function waitForCapture(cli, env, terminalId, marker) {
  const deadline = Date.now() + 10_000
  let content = ''
  while (Date.now() < deadline) {
    const result = await runCli(cli, env, [
      'terminal',
      'capture',
      terminalId,
      '--json'
    ]).catch(() => null)
    if (result) {
      content = JSON.parse(result.stdout).content
      if (content.includes(marker)) {
        return content
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error(`Terminal output did not contain ${marker}: ${content}`)
}

async function fakeNpm(directory, prefix) {
  const executable = path.join(directory, 'npm')
  const realNpm = (
    await command('/bin/sh', ['-c', 'command -v npm'], { env: process.env })
  ).stdout.trim()
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === 'prefix' && args[1] === '--global') {
  process.stdout.write(${JSON.stringify(`${prefix}\n`)})
} else if (args[0] === 'view') {
  process.stdout.write(${JSON.stringify(
    `${JSON.stringify({
      name: '@treeport/treeport',
      version: candidateVersion,
      dist: {
        tarball: `https://treeport.test/treeport-${candidateVersion}.tgz`,
        integrity: '__CANDIDATE_INTEGRITY__'
      }
    })}\n`
  )}.replace('__CANDIDATE_INTEGRITY__', ${JSON.stringify(candidateIntegrity)}))
} else if (args[0] === 'pack') {
  const destination = args[args.indexOf('--pack-destination') + 1]
  const filename = path.basename(${JSON.stringify(candidateTarball)})
  fs.copyFileSync(${JSON.stringify(candidateTarball)}, path.join(destination, filename))
  process.stdout.write(JSON.stringify([{ filename, integrity: ${JSON.stringify(candidateIntegrity)} }]) + '\\n')
} else {
  const result = spawnSync(${JSON.stringify(realNpm)}, args, { stdio: 'inherit', env: process.env })
  process.exit(result.status ?? 1)
}
`,
    { mode: 0o755 }
  )
  return executable
}

async function writeStartupTransaction(dataDir, transactionId) {
  const updateDirectory = path.join(dataDir, 'updates')
  await fs.mkdir(updateDirectory, { recursive: true })
  await fs.writeFile(
    path.join(updateDirectory, 'startup-transaction.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      operationId: transactionId,
      ownerPid: process.pid,
      createdAt: Date.now()
    })}\n`,
    { mode: 0o600, flag: 'wx' }
  )
}

async function terminateFixture(value) {
  for (const recordPath of [
    path.join(value.runtimeDir, 'daemon.json'),
    ...(await fs
      .readdir(value.runtimeDir)
      .then((names) =>
        names
          .filter(
            (name) =>
              name.startsWith('terminal-host-') && name.endsWith('.json')
          )
          .map((name) => path.join(value.runtimeDir, name))
      )
      .catch(() => []))
  ]) {
    const pid = await fs
      .readFile(recordPath, 'utf8')
      .then((source) => JSON.parse(source).pid)
      .catch(() => null)
    if (Number.isInteger(pid) && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // The isolated process already exited.
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  activeRoots.delete(value.fixtureRoot)
  await fs.rm(value.fixtureRoot, { recursive: true, force: true })
}

async function terminalHostSocket(dataDir, record, terminalId, history) {
  const socket = net.createConnection(record.socketPath)
  const pending = new Map()
  const events = []
  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0)
      if (buffered.length < length + 4) {
        break
      }

      const frame = JSON.parse(buffered.subarray(4, length + 4).toString())
      buffered = buffered.subarray(length + 4)
      if (frame.type === 'response') {
        const request = pending.get(frame.id)
        pending.delete(frame.id)
        if (frame.error) {
          request?.reject(new Error(frame.error.message))
        } else {
          request?.resolve(frame.result)
        }
      } else if (frame.type === 'event') {
        events.push(frame)
      }
    }
  })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  let nextId = 0
  const request = (method, input) =>
    new Promise((resolve, reject) => {
      const id = `packaged-api-${++nextId}`
      pending.set(id, { resolve, reject })
      const payload = Buffer.from(
        JSON.stringify({ type: 'request', id, method, input })
      )
      const header = Buffer.alloc(4)
      header.writeUInt32BE(payload.length)
      socket.write(Buffer.concat([header, payload]))
    })
  const token = (
    await fs.readFile(path.join(dataDir, 'terminal-host.token'), 'utf8')
  ).trim()
  await request('handshake', { token, hostKey: record.hostKey })
  const snapshot = await request('attach', { terminalId })
  assert.match(snapshot.data, history)
  await request('resize', { terminalId, cols: 100, rows: 30 })
  const transition = await request('prepareQueryAuthority', { terminalId })
  await request('activateQueryAuthority', {
    terminalId,
    transitionId: transition.transitionId,
    attachmentId: 'packaged-api-gate',
    generation: 1,
    cellSize: null
  })
  return {
    write(data) {
      return request('write', {
        terminalId,
        data,
        encoding: 'utf8',
        authority: { attachmentId: 'packaged-api-gate', generation: 1 }
      })
    },
    async waitForOutput(marker) {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (
          events.some(
            (frame) =>
              frame.event === 'output' && frame.data.output.includes(marker)
          )
        ) {
          return
        }

        await new Promise((resolve) => setTimeout(resolve, 25))
      }

      throw new Error(`Timed out waiting for terminal output: ${marker}`)
    },
    close() {
      socket.destroy()
    }
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-packaged-api-gate-'))
  npmCache = (await command('npm', ['config', 'get', 'cache'])).stdout.trim()
  assert(path.isAbsolute(npmCache), 'npm cache path must be absolute')
  const candidate = path.join(root, 'candidate')
  const candidatePanelSdk = path.join(root, 'candidate-panel-sdk')
  candidateVersion = JSON.parse(
    await fs.readFile(path.join(appRoot, 'package.json'), 'utf8')
  ).version
  await Promise.all(
    [candidate, candidatePanelSdk].map((directory) =>
      fs.mkdir(directory, { recursive: true })
    )
  )
  await Promise.all([
    command(
      'pnpm',
      ['--config.ignore-scripts=true', 'pack', '--pack-destination', candidate],
      { cwd: appRoot, env: process.env }
    ),
    command(
      'pnpm',
      [
        '--config.ignore-scripts=true',
        'pack',
        '--pack-destination',
        candidatePanelSdk
      ],
      { cwd: panelSdkRoot, env: process.env }
    )
  ])
  candidateTarball = path.join(
    candidate,
    (await fs.readdir(candidate)).find((name) => name.endsWith('.tgz'))
  )
  const panelSdkTarball = path.join(
    candidatePanelSdk,
    (await fs.readdir(candidatePanelSdk)).find((name) => name.endsWith('.tgz'))
  )
  candidateIntegrity = `sha512-${crypto
    .createHash('sha512')
    .update(await fs.readFile(candidateTarball))
    .digest('base64')}`
  candidatePrefix = path.join(root, 'candidate-prefix-a')
  candidateCliA = await installTarballs(
    [candidateTarball, panelSdkTarball],
    candidatePrefix
  )
  candidateCliB = await installTarballs(
    [candidateTarball, panelSdkTarball],
    path.join(root, 'candidate-prefix-b')
  )
}, 300_000)

afterAll(async () => {
  for (const fixtureRoot of activeRoots) {
    await terminateFixture({
      fixtureRoot,
      runtimeDir: path.join(fixtureRoot, 'runtime')
    })
  }
  if (root) {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 300_000)

describe('packaged stable terminal API lifecycle', () => {
  it('preserves a live shell and history across packaged daemon replacement', async () => {
    const value = await fixture('live-daemon-replacement')
    try {
      await runCli(candidateCliA, value.env, ['start', '--json'])
      await runCli(candidateCliA, value.env, [
        'project',
        'add',
        value.repository,
        '--json'
      ])
      const created = await runCli(candidateCliA, value.env, [
        'terminal',
        'create',
        '--worktree',
        value.repository,
        '--name',
        'packaged-survivor',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'printf "SHELL_PID=%s STATE=preserved-memory\\n" "$$"; while IFS= read -r line; do printf "STATE=preserved-memory INPUT=%s\\n" "$line"; done'
      ])
      const terminalId = JSON.parse(created.stdout).id
      const before = await waitForCapture(
        candidateCliA,
        value.env,
        terminalId,
        'STATE=preserved-memory'
      )
      const shellPid = /SHELL_PID=(\d+)/.exec(before)?.[1]
      assert(shellPid)
      const hostBefore = (await readHostRecord(value.runtimeDir)).value
      assert.equal('protocolVersion' in hostBefore, false)

      await runCli(candidateCliA, value.env, ['stop', '--json'])
      await runCli(candidateCliB, value.env, ['start', '--json'])
      const hostAfter = (await readHostRecord(value.runtimeDir)).value
      assert.equal(hostAfter.pid, hostBefore.pid)
      const after = await waitForCapture(
        candidateCliB,
        value.env,
        terminalId,
        'STATE=preserved-memory'
      )
      assert.match(after, new RegExp(`SHELL_PID=${shellPid}\\b`))

      const socket = await terminalHostSocket(
        value.dataDir,
        hostAfter,
        terminalId,
        /STATE=preserved-memory/
      )
      await socket.write('AFTER_RESTART\n')
      await socket.waitForOutput('STATE=preserved-memory INPUT=AFTER_RESTART')
      socket.close()

      const next = await runCli(candidateCliB, value.env, [
        'terminal',
        'create',
        '--worktree',
        value.repository,
        '--name',
        'after-replacement',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'echo NEW_TERMINAL_AFTER_REPLACEMENT'
      ])
      await waitForCapture(
        candidateCliB,
        value.env,
        JSON.parse(next.stdout).id,
        'NEW_TERMINAL_AFTER_REPLACEMENT'
      )
    } finally {
      await terminateFixture(value)
    }
  }, 60_000)

  it('adopts an empty packaged host and creates a terminal afterward', async () => {
    const value = await fixture('empty-host')
    try {
      await runCli(candidateCliA, value.env, ['start', '--json'])
      const hostBefore = (await readHostRecord(value.runtimeDir)).value
      await runCli(candidateCliA, value.env, ['stop', '--json'])
      await runCli(candidateCliB, value.env, ['start', '--json'])
      assert.equal(
        (await readHostRecord(value.runtimeDir)).value.pid,
        hostBefore.pid
      )
      await runCli(candidateCliB, value.env, [
        'project',
        'add',
        value.repository,
        '--json'
      ])
      const created = await runCli(candidateCliB, value.env, [
        'terminal',
        'create',
        '--worktree',
        value.repository,
        '--name',
        'after-empty-adoption',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'echo EMPTY_HOST_ADOPTED'
      ])
      await waitForCapture(
        candidateCliB,
        value.env,
        JSON.parse(created.stdout).id,
        'EMPTY_HOST_ADOPTED'
      )
    } finally {
      await terminateFixture(value)
    }
  }, 60_000)

  it('refuses a live historical record through the packaged updater before activation', async () => {
    const value = await fixture('updater-refusal')
    const updaterPrefix = path.join(value.fixtureRoot, 'updater-prefix')
    const updaterCli = path.join(updaterPrefix, 'bin', 'treeport')
    const fakeBin = path.join(value.fixtureRoot, 'fake-bin')
    try {
      await command('cp', ['-al', candidatePrefix, updaterPrefix])
      const manifestPath = path.join(
        updaterPrefix,
        'lib/node_modules/@treeport/treeport/package.json'
      )
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
      await fs.rm(manifestPath)
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify({ ...manifest, version: '0.10.0' }, null, 2)}\n`
      )
      await runCli(candidateCliA, value.env, ['start', '--json'])
      const daemonBefore = JSON.parse(
        await fs.readFile(path.join(value.runtimeDir, 'daemon.json'), 'utf8')
      )
      const host = await readHostRecord(value.runtimeDir)
      const source = `${JSON.stringify({
        ...host.value,
        protocolVersion: 4
      })}\n`
      await fs.writeFile(host.path, source)
      await fs.mkdir(fakeBin)
      await fakeNpm(fakeBin, updaterPrefix)

      const refusal = await runCli(
        updaterCli,
        {
          ...value.env,
          PATH: `${fakeBin}:${value.env.PATH}`,
          NPM_CONFIG_CACHE: npmCache
        },
        ['update', '--yes', '--json']
      ).then(
        () => null,
        (error) => error
      )
      assert(refusal)
      const output = `${refusal.stdout}\n${refusal.stderr}`
      assert.equal(refusal.code, 5, output)
      assert.match(output, /retired protocol 4/)
      const daemonAfter = JSON.parse(
        await fs.readFile(path.join(value.runtimeDir, 'daemon.json'), 'utf8')
      )
      assert.equal(daemonAfter.pid, daemonBefore.pid)
      process.kill(daemonBefore.pid, 0)
      process.kill(host.value.pid, 0)
      assert.equal(await fs.readFile(host.path, 'utf8'), source)
      await assert.rejects(
        fs.access(path.join(updaterPrefix, 'lib', 'treeport', 'current'))
      )
    } finally {
      await terminateFixture(value)
    }
  }, 120_000)

  it('cleans up only a candidate-owned provisional host after failed startup', async () => {
    const value = await fixture('failed-startup')
    const transactionId = crypto.randomUUID()
    try {
      await writeStartupTransaction(value.dataDir, transactionId)
      await runCli(candidateCliA, value.env, ['start', '--json'])
      const host = (await readHostRecord(value.runtimeDir)).value
      assert.equal(host.provisional, true)
      await runCli(candidateCliA, value.env, ['stop', '--json'])
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try {
          process.kill(host.pid, 0)
        } catch {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.throws(() => process.kill(host.pid, 0))
      assert.deepEqual(
        (await fs.readdir(value.runtimeDir)).filter(
          (name) => name.startsWith('terminal-host-') && name.endsWith('.json')
        ),
        []
      )
    } finally {
      await terminateFixture(value)
    }
  })

  it('preserves a pre-existing host when startup ownership is interrupted', async () => {
    const value = await fixture('interrupted-startup')
    const transactionId = crypto.randomUUID()
    try {
      await runCli(candidateCliA, value.env, ['start', '--json'])
      await runCli(candidateCliA, value.env, [
        'project',
        'add',
        value.repository,
        '--json'
      ])
      const created = await runCli(candidateCliA, value.env, [
        'terminal',
        'create',
        '--worktree',
        value.repository,
        '--name',
        'interrupted-survivor',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'printf "INTERRUPTED_PID=%s STATE=still-running\\n" "$$"; while :; do sleep 1; done'
      ])
      const terminalId = JSON.parse(created.stdout).id
      const before = await waitForCapture(
        candidateCliA,
        value.env,
        terminalId,
        'STATE=still-running'
      )
      const shellPid = /INTERRUPTED_PID=(\d+)/.exec(before)?.[1]
      assert(shellPid)
      const hostBefore = (await readHostRecord(value.runtimeDir)).value
      await runCli(candidateCliA, value.env, ['stop', '--json'])

      await writeStartupTransaction(value.dataDir, transactionId)
      await runCli(candidateCliB, value.env, ['start', '--json'])
      assert.equal(
        (await readHostRecord(value.runtimeDir)).value.pid,
        hostBefore.pid
      )
      await fs.rm(
        path.join(value.dataDir, 'updates', 'startup-transaction.json')
      )
      const daemonRecord = path.join(value.runtimeDir, 'daemon.json')
      const deadline = Date.now() + 5_000
      while (
        Date.now() < deadline &&
        (await fs
          .access(daemonRecord)
          .then(() => true)
          .catch(() => false))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      await assert.rejects(fs.access(daemonRecord))
      process.kill(hostBefore.pid, 0)

      await runCli(candidateCliA, value.env, ['start', '--json'])
      const recovered = await waitForCapture(
        candidateCliA,
        value.env,
        terminalId,
        'STATE=still-running'
      )
      assert.match(recovered, new RegExp(`INTERRUPTED_PID=${shellPid}\\b`))
      assert.equal(
        (await readHostRecord(value.runtimeDir)).value.pid,
        hostBefore.pid
      )
    } finally {
      await terminateFixture(value)
    }
  }, 60_000)
})
