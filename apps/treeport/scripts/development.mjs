#!/usr/bin/env node
import { spawn } from 'node:child_process'

const environment = {
  ...process.env,
  TREEPORT_DAEMON_LIFECYCLE: 'external'
}
const children = [
  spawn('pnpm', ['dev:server'], { env: environment, stdio: 'inherit' }),
  spawn('pnpm', ['dev:web'], { env: environment, stdio: 'inherit' })
]

let stopping = false
let exitCode = 0
function stop(signal = 'SIGTERM') {
  if (stopping) {
    return
  }

  stopping = true
  for (const child of children) {
    child.kill(signal)
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => stop(signal))
}

for (const child of children) {
  child.once('error', (error) => {
    console.error(
      `Could not start Treeport development process: ${error.message}`
    )
    exitCode = 1
    stop()
  })
  child.once('exit', (code) => {
    if (!stopping) {
      exitCode = code || 1
      stop()
    }
  })
}

await Promise.all(
  children.map(
    (child) =>
      new Promise((resolve) => {
        child.once('exit', resolve)
      })
  )
)
process.exitCode = exitCode
