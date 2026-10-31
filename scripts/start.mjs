#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const serverEntry = path.join(
  root,
  'apps',
  'treeport',
  'src',
  'server',
  'index.ts'
)

const webDist = path.join(root, 'apps', 'treeport', 'dist', 'web')

for (const [label, command, args] of [
  ['install dependencies', 'pnpm', ['install', '--frozen-lockfile']],
  [
    'build Treeport',
    path.join(root, 'node_modules', '.bin', 'turbo'),
    [
      'run',
      'build',
      '--filter=@treeport/treeport...',
      '--ui=stream',
      '--output-logs=errors-only'
    ]
  ]
]) {
  const step = spawnSync(command, args, { cwd: root, stdio: 'inherit' })

  if (step.status !== 0) {
    console.error(
      step.error
        ? `Failed to ${label}: ${step.error.message}`
        : `Failed to ${label}.`
    )
    process.exit(step.status ?? 1)
  }
}

const host = process.env.TREEPORT_HOST?.trim() || '127.0.0.1'
const port = process.env.TREEPORT_PORT?.trim() || '8733'
const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'

console.log(`Treeport network listener: http://${host}:${port}`)

console.warn(
  'Authentication is disabled; anyone who can reach this port has full access.'
)

if (!loopback) {
  console.warn(
    'LAN access enabled. Do not expose this port directly to the public internet.'
  )
}

const child = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: {
    ...process.env,
    TREEPORT_HOST: host,
    TREEPORT_PORT: port,
    TREEPORT_API_URL:
      process.env.TREEPORT_API_URL?.trim() || `http://127.0.0.1:${port}`,
    TREEPORT_WEB_DIST: process.env.TREEPORT_WEB_DIST?.trim() || webDist
  },
  stdio: 'inherit'
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.once('error', (error) => {
  console.error(`Failed to start Treeport: ${error.message}`)
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
