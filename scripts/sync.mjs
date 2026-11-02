#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

for (const [label, command, args] of [
  ['pull', 'git', ['pull', '--ff-only']],
  ['install dependencies', 'pnpm', ['install', '--frozen-lockfile']],
  ['build Treeport', 'pnpm', ['build:server']]
]) {
  const step = spawnSync(command, args, { cwd: root, stdio: 'inherit' })

  if (step.status !== 0) {
    console.error(
      step.error
        ? `Failed to ${label}: ${step.error.message}`
        : `Failed to ${label}. The running server was left untouched.`
    )
    process.exit(step.status ?? 1)
  }
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
  const restart = spawnSync('pm2', ['restart', 'ecosystem.config.cjs'], {
    cwd: root,
    stdio: 'inherit'
  })

  process.exit(restart.status ?? 1)
}

if (health?.installationMethod === 'desktop-app') {
  process.kill(health.pid, 'SIGTERM')
  console.log(
    'Stopped the server started by the Treeport app. The app starts it again, or open Treeport if it is closed.'
  )
} else if (health) {
  console.log(
    'Restart Treeport to apply: pnpm pm2 restart ecosystem.config.cjs under pm2, or restart pnpm start.'
  )
} else {
  console.log('Treeport is not running. Start it to apply.')
}
