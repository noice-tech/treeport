#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Keep this baseline older than the candidate's packaged migration history.
const baseline = {
  version: '0.5.0',
  url: 'https://registry.npmjs.org/@treeport/treeport/-/treeport-0.5.0.tgz',
  integrity:
    'sha512-t9uuuWcpU5ET/2Qvqnp3NtL0Zadn1u6S5TOdGZd1IZLjRHfxOAvYWzzOwZbsBlpcWd6R3JCAaq1Ib3ACOL8eHA=='
}
const execute = promisify(execFile)
const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-real-upgrade-'))
const prefix = path.join(root, 'prefix')
const dataDir = path.join(root, 'data')
const runtimeDir = path.join(root, 'runtime')
const home = path.join(root, 'home')
const cli = path.join(prefix, 'bin/treeport')
const { version } = JSON.parse(
  await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')
)
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('TREEPORT_'))
)
Object.assign(environment, {
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  TREEPORT_DATA_DIR: dataDir,
  TREEPORT_RUNTIME_DIR: runtimeDir,
  TREEPORT_HOST: '127.0.0.1',
  TREEPORT_DAEMON_LIFECYCLE: 'treeport',
  NPM_CONFIG_PREFIX: prefix
})
const reservation = net.createServer()
await new Promise((resolve, reject) => {
  reservation.once('error', reject)
  reservation.listen(0, '127.0.0.1', resolve)
})
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
environment.TREEPORT_PORT = String(port)
const apiUrl = `http://127.0.0.1:${port}`
environment.TREEPORT_API_URL = apiUrl
const runCli = async (args) =>
  JSON.parse(
    (
      await execute(cli, [...args, '--json'], {
        env: environment,
        cwd: root,
        timeout: 120_000
      })
    ).stdout
  )
let stopped = true
let cleanupEntrypoint = cli
let passed = false
try {
  await fs.mkdir(home)
  const response = await fetch(baseline.url, {
    signal: AbortSignal.timeout(30_000)
  })
  assert(
    response.ok,
    `Could not download historical package: ${response.status}`
  )
  const historicalBytes = Buffer.from(await response.arrayBuffer())
  assert.equal(
    `sha512-${crypto.createHash('sha512').update(historicalBytes).digest('base64')}`,
    baseline.integrity
  )
  const historicalTarball = path.join(root, 'historical.tgz')
  await fs.writeFile(historicalTarball, historicalBytes)
  await execute(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      historicalTarball,
      '--no-audit',
      '--no-fund'
    ],
    { cwd: root, env: environment, timeout: 120_000 }
  )

  const packArguments = [
    '--config.ignore-scripts=true',
    'pack',
    '--pack-destination',
    root
  ]
  await execute('pnpm', packArguments, {
    cwd: packageDirectory,
    timeout: 120_000
  })
  await execute('pnpm', packArguments, {
    cwd: path.resolve(packageDirectory, '../../packages/panel-sdk'),
    timeout: 120_000
  })
  const candidateTarball = path.join(root, `treeport-treeport-${version}.tgz`)
  const panelSdkTarball = path.join(root, `treeport-panel-sdk-${version}.tgz`)
  const candidateIntegrity = `sha512-${crypto
    .createHash('sha512')
    .update(await fs.readFile(candidateTarball))
    .digest('base64')}`
  const realNpm = (await execute('which', ['npm'])).stdout.trim()
  const updateBin = path.join(root, 'update-bin')
  await fs.mkdir(updateBin)
  // Replace only release discovery. npm still packs and installs real tarballs.
  await fs.writeFile(
    path.join(updateBin, 'npm'),
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === 'view') {
  console.log(JSON.stringify({ name: '@treeport/treeport', version: ${JSON.stringify(version)}, dist: { tarball: 'https://candidate.example/treeport.tgz', integrity: ${JSON.stringify(candidateIntegrity)} } }))
  process.exit(0)
}
if (args[0] === 'pack') args[1] = ${JSON.stringify(candidateTarball)}
if (args[0] === 'install') args.push(${JSON.stringify(panelSdkTarball)})
const result = spawnSync(${JSON.stringify(realNpm)}, args, { env: process.env, stdio: 'inherit' })
process.exit(result.status ?? 1)
`,
    { mode: 0o755 }
  )

  stopped = false
  await runCli(['start'])
  const health = await fetch(`${apiUrl}/api/health`).then((result) =>
    result.json()
  )
  const daemon = JSON.parse(
    await fs.readFile(path.join(runtimeDir, 'daemon.json'), 'utf8')
  )
  assert.equal(health.version, baseline.version)
  assert.equal(health.pid, daemon.pid)
  assert.equal(daemon.dataDir, dataDir)
  const repository = path.join(root, 'repository')
  await fs.mkdir(repository)
  await execute('git', ['init', '-b', 'main'], { cwd: repository })
  await execute(
    'git',
    [
      '-c',
      'user.name=Treeport test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'Initial commit'
    ],
    { cwd: repository }
  )
  const project = await runCli(['project', 'add', repository])
  const tree = await runCli([
    'worktree',
    'create',
    '--project',
    project.id,
    '--name',
    'upgrade-test'
  ])
  const before = await runCli(['project', 'list'])
  assert(
    before
      .find((item) => item.id === project.id)
      .worktrees.some((item) => item.id === tree.worktree.id)
  )

  const databasePath = path.join(dataDir, 'treeport.db')
  const oldDatabase = new DatabaseSync(databasePath, { readOnly: true })
  const oldHistory = oldDatabase
    .prepare(
      'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at'
    )
    .all()
  oldDatabase.close()
  const oldPackage = path.join(prefix, 'lib/node_modules/@treeport/treeport')
  const oldEntrypoint = path.join(oldPackage, 'bin/treeport.mjs')
  // 0.5.0 uses tmux. The terminal-host cutover cannot adopt those live processes.
  await runCli(['stop', '--terminate-terminals', '--force'])
  environment.PATH = `${updateBin}:${environment.PATH}`
  const result = await runCli(['update'])
  assert.equal(result.status, 'updated')
  assert.equal(result.fromVersion, baseline.version)
  assert.equal(result.toVersion, version)
  assert.equal(result.daemon.restarted, false)
  assert.equal(
    await fetch(`${apiUrl}/api/health`).then(
      () => true,
      () => false
    ),
    false
  )
  await runCli(['start'])
  const updatedHealth = await fetch(`${apiUrl}/api/health`).then((value) =>
    value.json()
  )
  assert.equal(updatedHealth.version, version)
  assert.notEqual(updatedHealth.pid, health.pid)
  const after = await runCli(['project', 'list'])
  for (const previousProject of before) {
    const preserved = after.find((item) => item.id === previousProject.id)
    assert(preserved, 'The project catalog did not survive the upgrade')
    for (const previousTree of previousProject.worktrees) {
      assert(
        preserved.worktrees.some(
          (item) =>
            item.id === previousTree.id && item.path === previousTree.path
        ),
        'A worktree did not survive the upgrade'
      )
    }
  }
  const updatedDatabase = new DatabaseSync(databasePath, { readOnly: true })
  const newHistory = updatedDatabase
    .prepare(
      'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at'
    )
    .all()
  updatedDatabase.close()
  assert(
    newHistory.length > oldHistory.length,
    'The real upgrade must have pending migrations'
  )
  assert.deepEqual(newHistory.slice(0, oldHistory.length), oldHistory)
  const backups = await fs.readdir(path.join(dataDir, 'database-backups'))
  assert.equal(backups.length, 1)
  const snapshot = new DatabaseSync(
    path.join(dataDir, 'database-backups', backups[0]),
    { readOnly: true }
  )
  assert.deepEqual(
    snapshot
      .prepare(
        'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at'
      )
      .all(),
    oldHistory
  )
  assert.equal(
    snapshot.prepare('SELECT id FROM projects WHERE id = ?').get(project.id).id,
    project.id
  )
  snapshot.close()

  await runCli(['stop'])
  await runCli(['start'])
  assert.deepEqual(
    await fs.readdir(path.join(dataDir, 'database-backups')),
    backups
  )
  await runCli(['stop', '--terminate-terminals', '--force'])
  stopped = true
  const databaseBeforeDowngrade = await fs.readFile(databasePath)
  cleanupEntrypoint = oldEntrypoint
  stopped = false
  const downgrade = await execute(oldEntrypoint, ['start', '--json'], {
    env: environment,
    cwd: root,
    timeout: 30_000
  }).then(
    () => null,
    (error) => error
  )
  assert(
    downgrade,
    'The historical binary unexpectedly started against a newer schema'
  )
  assert.match(downgrade.stderr, /newer than this binary supports/)
  assert.equal(
    await fetch(`${apiUrl}/api/health`).then(
      () => true,
      () => false
    ),
    false
  )
  assert.deepEqual(await fs.readFile(databasePath), databaseBeforeDowngrade)

  // Exercise the documented, explicit restore without destroying the failed database.
  const preservedDatabase = path.join(root, 'failed-database')
  await fs.mkdir(preservedDatabase)
  for (const suffix of ['', '-wal', '-shm']) {
    await fs
      .rename(
        `${databasePath}${suffix}`,
        path.join(preservedDatabase, `treeport.db${suffix}`)
      )
      .catch((error) => {
        if (error.code !== 'ENOENT') {
          throw error
        }
      })
  }
  await fs.copyFile(
    path.join(dataDir, 'database-backups', backups[0]),
    databasePath
  )
  await fs.chmod(databasePath, 0o600)
  await execute(oldEntrypoint, ['start', '--json'], {
    env: environment,
    cwd: root,
    timeout: 30_000
  })
  stopped = false
  const restored = JSON.parse(
    (
      await execute(oldEntrypoint, ['project', 'list', '--json'], {
        env: environment,
        cwd: root
      })
    ).stdout
  )
  assert(
    restored.some(
      (item) =>
        item.id === project.id &&
        item.worktrees.some((item) => item.id === tree.worktree.id)
    )
  )
  await execute(oldEntrypoint, ['stop', '--terminate-terminals', '--force'], {
    env: environment,
    cwd: root,
    timeout: 30_000
  })
  stopped = true
  passed = true
  console.log(
    `Real packaged upgrade ${baseline.version} -> ${version} preserved catalog data, applied migrations, created a snapshot, and refused downgrade`
  )
} finally {
  // Do not delete runtime evidence when shutdown fails.
  if (!stopped) {
    const record = await fs
      .readFile(path.join(runtimeDir, 'daemon.json'), 'utf8')
      .then((value) => JSON.parse(value))
      .catch(() => null)
    const health = await fetch(`${apiUrl}/api/health`, {
      signal: AbortSignal.timeout(1_500)
    })
      .then((response) => response.json())
      .catch(() => null)
    const owned =
      record?.dataDir === dataDir &&
      record.apiUrl === apiUrl &&
      record.pid === health?.pid &&
      record.instanceId === health?.instanceId
    await execute(
      cleanupEntrypoint,
      ['stop', ...(owned ? ['--terminate-terminals', '--force'] : [])],
      {
        env: environment,
        cwd: root,
        timeout: 30_000
      }
    )
  }

  if (passed) {
    await fs.rm(root, { recursive: true, force: true })
  } else {
    console.error(`Upgrade failure evidence: ${root}`)
    for (const file of [
      'logs/daemon.log',
      'updates/operation.json',
      'updates/startup-report.json'
    ]) {
      console.error(
        await fs
          .readFile(path.join(dataDir, file), 'utf8')
          .catch(() => `${file}: unavailable`)
      )
    }
  }
}
