#!/usr/bin/env node
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const temporaryDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'treeport-package-smoke-')
)
const prefix = path.join(temporaryDirectory, 'prefix')
const dataDirectory = path.join(temporaryDirectory, 'data')
const runtimeDirectory = path.join(temporaryDirectory, 'runtime')
const treeport = path.join(prefix, 'bin', 'treeport')
const { version } = JSON.parse(
  await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')
)

const reservation = net.createServer()
await new Promise((resolve, reject) => {
  reservation.once('error', reject)
  reservation.listen(0, '127.0.0.1', resolve)
})
const address = reservation.address()
if (!address || typeof address === 'string') {
  throw new Error('Could not allocate a package smoke-test port')
}

const port = address.port
await new Promise((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve()))
)

const environment = {
  ...process.env,
  TREEPORT_API_URL: '',
  TREEPORT_HOST: '127.0.0.1',
  TREEPORT_PORT: String(port),
  TREEPORT_DATA_DIR: dataDirectory,
  TREEPORT_RUNTIME_DIR: runtimeDirectory
}

try {
  const packed = await execute(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    { cwd: packageDirectory }
  )
  const [{ filename }] = JSON.parse(packed.stdout)
  await execute(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      path.join(temporaryDirectory, filename)
    ],
    { cwd: temporaryDirectory }
  )

  await execute(treeport, ['up'], { env: environment })
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(
    async (response) => {
      if (!response.ok) {
        throw new Error(`Packaged health check returned ${response.status}`)
      }

      return response.json()
    }
  )
  if (health.ok !== true || health.version !== version) {
    throw new Error(
      `Unexpected packaged health response: ${JSON.stringify(health)}`
    )
  }

  const html = await fetch(`http://127.0.0.1:${port}/`).then((response) =>
    response.text()
  )
  if (!html.includes('<div id="root"></div>')) {
    throw new Error('Packaged daemon did not serve the Treeport web app')
  }

  const repository = path.join(temporaryDirectory, 'repository')
  await fs.mkdir(repository)
  await execute('git', ['init', '-b', 'main'], { cwd: repository })
  await execute('git', ['config', 'user.name', 'Treeport test'], {
    cwd: repository
  })
  await execute('git', ['config', 'user.email', 'treeport@example.test'], {
    cwd: repository
  })
  await fs.writeFile(path.join(repository, 'README.md'), '# Package smoke\n')
  await execute('git', ['add', 'README.md'], { cwd: repository })
  await execute('git', ['commit', '-m', 'Initial commit'], { cwd: repository })
  const added = await execute(
    treeport,
    ['project', 'add', repository, '--json'],
    { env: environment }
  )
  const project = JSON.parse(added.stdout)
  const worktree = project.worktrees[0]
  await execute(
    treeport,
    [
      'terminal',
      'create',
      '--worktree',
      worktree.id,
      '--name',
      'smoke',
      '--',
      '/bin/sh',
      '-c',
      'sleep 60'
    ],
    { env: environment }
  )

  await execute(treeport, ['down', '--terminate-terminals', '--force'], {
    env: environment
  })
  const tmuxEnvironment = { ...process.env, TMUX: '' }
  const serverTerminated = await execute(
    'tmux',
    ['-L', worktree.tmuxSocketName, 'has-session'],
    { env: tmuxEnvironment }
  ).then(
    () => false,
    () => true
  )
  if (!serverTerminated) {
    throw new Error('Destructive shutdown left a Treeport tmux server running')
  }

  await fs.access(path.join(dataDirectory, 'treeport.db'))
  console.log('Clean npm package installation smoke test passed')
} finally {
  await execute(treeport, ['down'], { env: environment }).catch(() => undefined)
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
}
