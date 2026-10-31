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

const managedByPm2 =
  spawnSync('pm2', ['describe', 'treeport'], { cwd: root, stdio: 'ignore' })
    .status === 0

if (!managedByPm2) {
  console.log('Restart pnpm start to apply.')
  process.exit(0)
}

const restart = spawnSync('pm2', ['restart', 'ecosystem.config.cjs'], {
  cwd: root,
  stdio: 'inherit'
})

process.exit(restart.status ?? 1)
