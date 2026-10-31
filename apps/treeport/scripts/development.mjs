#!/usr/bin/env node
import { spawn } from 'node:child_process'
import '../../../scripts/development-tracing.mjs'

const serverOnly = process.argv.includes('--server')
const managed = Boolean(process.env.TREEPORT_DAEMON_RECORD)

const child = spawn(
  process.execPath,
  ['--watch', '--watch-preserve-output', 'src/server/index.ts'],
  {
    env: {
      ...process.env,
      TREEPORT_INSTALLATION_METHOD: 'development',
      TREEPORT_APP_VERSION: 'development',
      TREEPORT_WEB_DEVELOPMENT: serverOnly
        ? process.env.TREEPORT_WEB_DEVELOPMENT
        : '1',
      // EXTERNAL: Managed terminals inherit their parent's directories, not this worktree's.
      TREEPORT_DATA_DIR:
        (!managed && process.env.TREEPORT_DATA_DIR) || '.treeport-dev/data',
      TREEPORT_RUNTIME_DIR:
        (!managed && process.env.TREEPORT_RUNTIME_DIR) ||
        '.treeport-dev/runtime',
      TREEPORT_CACHE_DIR:
        (!managed && process.env.TREEPORT_CACHE_DIR) || '.treeport-dev/cache'
    },
    stdio: 'inherit'
  }
)

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}

child.once('error', (error) => {
  console.error(
    `Could not start Treeport development process: ${error.message}`
  )
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
