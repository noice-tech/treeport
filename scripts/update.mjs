#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runSteps } from './steps.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const status = runSteps(root, [
  ['Pulling changes', 'git', ['pull', '--ff-only']],
  ['Installing dependencies', 'pnpm', ['install', '--frozen-lockfile']],
  ['Building Treeport', 'pnpm', ['build:server']]
])

if (status !== 0) {
  console.error('\nUpdate stopped. The running Treeport was left untouched.')
  process.exit(status)
}

const commit = spawnSync('git', ['log', '-1', '--format=%h %s'], {
  cwd: root,
  encoding: 'utf8'
})

console.log(`Treeport is at ${commit.stdout.trim()}`)

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
