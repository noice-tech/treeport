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
const panelSdkDirectory = path.resolve(
  packageDirectory,
  '..',
  '..',
  'packages',
  'panel-sdk'
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
  await execute('pnpm', ['pack', '--pack-destination', temporaryDirectory], {
    cwd: panelSdkDirectory
  })
  await execute('pnpm', ['pack', '--pack-destination', temporaryDirectory], {
    cwd: packageDirectory
  })
  const panelSdkTarball = path.join(
    temporaryDirectory,
    `treeport-panel-sdk-${version}.tgz`
  )
  const treeportTarball = path.join(
    temporaryDirectory,
    `treeport-treeport-${version}.tgz`
  )
  await execute(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      panelSdkTarball,
      treeportTarball
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
  const panelDirectory = path.join(
    repository,
    '.treeport',
    'web-panels',
    'smoke'
  )
  await fs.mkdir(panelDirectory, { recursive: true })
  await Promise.all([
    fs.writeFile(
      path.join(panelDirectory, 'index.html'),
      '<main id="root"></main><script type="module" src="./panel.tsx"></script>\n'
    ),
    fs.writeFile(
      path.join(panelDirectory, 'panel.tsx'),
      "import { treeport } from '@treeport/panel-sdk'; const message: string = `source TSX panel loaded with SDK ${treeport.version}`; document.querySelector('#root').textContent = message\n"
    )
  ])
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
  const definitions = await fetch(
    `http://127.0.0.1:${port}/api/worktrees/${worktree.id}/web-panel-definitions`
  ).then((response) => response.json())
  const panelDefinition = definitions.definitions.find(
    (definition) => definition.id === 'project:smoke'
  )
  if (!panelDefinition) {
    throw new Error('Packaged daemon did not discover the source panel')
  }

  const createdPanel = await fetch(
    `http://127.0.0.1:${port}/api/worktrees/${worktree.id}/panels`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definitionId: panelDefinition.id })
    }
  ).then((response) => response.json())
  const transformedPanel = await fetch(
    `http://127.0.0.1:${port}/api/web-panels/${createdPanel.panel.id}/assets/`
  ).then((response) => response.text())
  const panelModulePath = /src="([^"]*panel\.tsx)"/.exec(transformedPanel)?.[1]
  if (!panelModulePath) {
    throw new Error('Packaged daemon did not transform the source panel HTML')
  }

  const transformedModule = await fetch(
    new URL(panelModulePath, `http://127.0.0.1:${port}`)
  ).then((response) => response.text())
  if (
    !transformedModule.includes('source TSX panel loaded') ||
    transformedModule.includes('const message: string')
  ) {
    throw new Error('Packaged daemon did not transform the source TSX module')
  }

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
