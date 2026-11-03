#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { report, runSteps } from './steps.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

report({
  type: 'plan',
  steps: [
    'Fetching changes',
    'Updating your clone',
    'Installing dependencies',
    'Building Treeport',
    'Restarting'
  ]
})

const head = () =>
  spawnSync('git', ['log', '-1', '--format=%h %s'], {
    cwd: root,
    encoding: 'utf8'
  }).stdout.trim()

let status = runSteps(root, [['Fetching changes', 'git', ['fetch']]])

const divergence = spawnSync(
  'git',
  ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
  { cwd: root, encoding: 'utf8' }
)

const [local, remote] = divergence.stdout.trim().split(/\s+/).map(Number)

if (status === 0 && local > 0 && remote > 0) {
  console.error(
    `\nYour clone has ${local} commit${local === 1 ? '' : 's'} your fork doesn't, and your fork has ${remote} new commit${remote === 1 ? '' : 's'}. Ask your coding agent to merge them, then run treeport update again.`
  )
  report({ type: 'diverged', local, remote })
  status = 1
}

if (status === 0 && remote === 0) {
  const current = head()
  console.log(`Treeport is already up to date at ${current}`)
  report({ type: 'up-to-date', head: current })
  process.exit(0)
}

if (status === 0) {
  status = runSteps(root, [
    ['Updating your clone', 'git', ['merge', '--ff-only', '@{upstream}']],
    ['Installing dependencies', 'pnpm', ['install', '--frozen-lockfile']],
    ['Building Treeport', 'pnpm', ['build:server']]
  ])
}

if (status !== 0) {
  console.error('\nUpdate stopped. The running Treeport was left untouched.')
  process.exit(status)
}

const current = head()

console.log(`Treeport is at ${current}`)

report({ type: 'updated', commits: remote, head: current })

const port = process.env.TREEPORT_PORT?.trim() || '8733'

const health = await fetch(`http://127.0.0.1:${port}/api/health`)
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null)

if (health?.installationMethod === 'pm2') {
  process.exit(
    runSteps(root, [
      ['Restarting', 'pnpm', ['pm2', 'restart', 'ecosystem.config.cjs']]
    ])
  )
}

if (health?.installationMethod === 'desktop-app') {
  process.kill(health.pid, 'SIGTERM')
  console.log(
    'Restarting through the Treeport app. Open Treeport if it is closed.'
  )
} else if (health) {
  console.log(
    'Restart Treeport to apply: pnpm pm2 restart ecosystem.config.cjs under pm2, or restart pnpm start.'
  )
} else {
  console.log('Treeport is not running. Start it to apply.')
}
