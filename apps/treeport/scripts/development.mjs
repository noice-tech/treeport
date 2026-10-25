#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import '../../../scripts/development-tracing.mjs'

const serverOnly = process.argv.includes('--server')

await rm('.treeport-dev-dist', { recursive: true, force: true })

const tsdownPackage = createRequire(import.meta.url).resolve(
  'tsdown/package.json'
)

// EXTERNAL: Run tsdown in a process group this script owns instead of behind
// `pnpm exec`: pnpm SIGKILLs its child groups as soon as tsdown exits, which
// kills the daemon tsdown spawned before it can release its terminal host.
const child = spawn(
  process.execPath,
  [
    path.join(
      path.dirname(tsdownPackage),
      JSON.parse(await readFile(tsdownPackage, 'utf8')).bin.tsdown
    ),
    '--watch',
    '--out-dir',
    '.treeport-dev-dist'
  ],
  {
    env: {
      ...process.env,
      TREEPORT_DAEMON_LIFECYCLE: 'external',
      TREEPORT_INSTALLATION_METHOD: 'development',
      TREEPORT_APP_VERSION: 'development',
      TREEPORT_WEB_DEVELOPMENT: serverOnly
        ? process.env.TREEPORT_WEB_DEVELOPMENT
        : '1',
      TREEPORT_DATA_DIR: '.treeport-dev/data',
      TREEPORT_RUNTIME_DIR: '.treeport-dev/runtime'
    },
    stdio: 'inherit',
    detached: process.platform !== 'win32'
  }
)

function signalGroup(signal) {
  if (!child.pid) {
    return false
  }

  try {
    if (process.platform === 'win32') {
      return child.kill(signal)
    }

    process.kill(-child.pid, signal)

    return true
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false
    }

    throw error
  }
}

let stopping = false
let requestedSignal = null

function stop(signal = 'SIGTERM') {
  if (stopping) {
    return
  }

  stopping = true
  requestedSignal = signal
  signalGroup(signal)
}

// EXTERNAL: Stay subscribed: terminal teardown delivers duplicates, and the default
// action would end this process before the daemon has stopped.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop(signal))
}

child.once('error', (error) => {
  console.error(
    `Could not start Treeport development process: ${error.message}`
  )
  process.exitCode = 1
})

child.once('exit', async (code) => {
  process.exitCode =
    requestedSignal === 'SIGINT'
      ? 130
      : requestedSignal === 'SIGTERM'
        ? 143
        : requestedSignal === 'SIGHUP'
          ? 129
          : (code ?? 1)
  // EXTERNAL: tsdown exits without awaiting the daemon it spawned. Stay alive, and keep
  // the pnpm processes above this script alive, until the daemon has shut down.
  signalGroup('SIGTERM')
  const deadline = Date.now() + 10_000

  while (process.platform !== 'win32' && signalGroup(0)) {
    if (Date.now() >= deadline) {
      signalGroup('SIGKILL')

      return
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})
