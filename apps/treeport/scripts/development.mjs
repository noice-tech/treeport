#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import '../../../scripts/development-tracing.mjs'

const serverOnly = process.argv.includes('--server')
await rm('.treeport-dev-dist', { recursive: true, force: true })
const child = spawn(
  'pnpm',
  ['exec', 'tsdown', '--watch', '--out-dir', '.treeport-dev-dist'],
  {
    env: {
      ...process.env,
      TREEPORT_DAEMON_LIFECYCLE: 'external',
      TREEPORT_WEB_DEVELOPMENT: serverOnly
        ? process.env.TREEPORT_WEB_DEVELOPMENT
        : '1',
      TREEPORT_DATA_DIR: '.treeport-dev/data',
      TREEPORT_RUNTIME_DIR: '.treeport-dev/runtime'
    },
    stdio: 'inherit'
  }
)

let stopping = false
let requestedSignal = null
function stop(signal = 'SIGTERM') {
  if (stopping) {
    return
  }

  stopping = true
  requestedSignal = signal
  child.kill(signal)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => stop(signal))
}

child.once('error', (error) => {
  console.error(
    `Could not start Treeport development process: ${error.message}`
  )
  process.exitCode = 1
})
child.once('exit', (code) => {
  process.exitCode =
    requestedSignal === 'SIGINT'
      ? 130
      : requestedSignal === 'SIGTERM'
        ? 143
        : requestedSignal === 'SIGHUP'
          ? 129
          : (code ?? 1)
})
