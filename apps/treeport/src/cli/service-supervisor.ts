// Installed independently of a release: never import code from the active package.
// launchd drops privileges before starting this program. Only the owned daemon
// child is signalled; detached terminal hosts must survive supervisor shutdown.
export function serviceSupervisorSource(): string {
  return `import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const [recordPath, owner] = process.argv.slice(2)
const uid = Number(owner)
if (!Number.isInteger(uid) || uid <= 0 || process.getuid?.() !== uid || !path.isAbsolute(recordPath)) {
  throw new Error('Treeport supervisor must run as its non-root owner')
}
const directory = path.dirname(recordPath)
const statePath = path.join(directory, 'supervisor.json')
let child = null
let stopping = null
let lastState = ''
let exiting = false
let retryAt = 0
let reported = ''
process.on('SIGTERM', () => { exiting = true })
process.on('SIGINT', () => { exiting = true })

async function readRecord() {
  // Reject symlinks and paths writable by another account, including ancestors.
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000)))) {
      throw new Error('Unsafe Treeport service directory: ' + current)
    }
    if (current === path.dirname(current)) break
  }
  const handle = await fs.open(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error('Unsafe Treeport service record')
    }
    const record = JSON.parse(await handle.readFile('utf8'))
    if (record.uid !== uid || record.supervisorVersion !== 1 ||
        !['running', 'stopped'].includes(record.requestedState) ||
        typeof record.updatedAt !== 'string' || !path.isAbsolute(record.cliEntrypoint) ||
        record.environment?.TREEPORT_SERVICE_RECORD !== recordPath) {
      throw new Error('Invalid Treeport supervisor record')
    }
    return record
  } finally {
    await handle.close()
  }
}

while (true) {
  const record = await readRecord().catch(error => {
    if (reported !== error.message) console.error(error.message)
    reported = error.message
    return null
  })
  if (exiting || !record || record.requestedState === 'stopped') {
    if (child && stopping !== child) {
      stopping = child
      child.kill('SIGTERM')
    }
  } else if (!child && Date.now() >= retryAt) {
    // Resolve the stable CLI path on every spawn, after the updater's atomic switch.
    const log = await fs.open(record.logPath, 'a', 0o600)
    const launched = spawn(record.cliEntrypoint, ['service', 'run'], {
      env: { ...record.environment, PATH: path.dirname(process.execPath) + ':' + record.environment.PATH },
      stdio: ['ignore', log.fd, log.fd]
    })
    child = launched
    const finished = () => {
      if (child === launched) child = null
      retryAt = Date.now() + 1000
    }
    launched.once('error', error => { console.error(error.message); finished() })
    launched.once('exit', finished)
    await log.close()
  }
  if (record) {
    const state = JSON.stringify({
      pid: process.pid, childPid: child?.pid ?? null,
      requestedState: record.requestedState, updatedAt: record.updatedAt,
      requestId: record.supervisorRequestId ?? null
    })
    if (state !== lastState) {
      const temporary = statePath + '.' + process.pid + '.' + Date.now() + '.tmp'
      await fs.writeFile(temporary, state, { mode: 0o600, flag: 'wx' })
      await fs.rename(temporary, statePath)
      lastState = state
    }
  }
  if (exiting && !child) break
  await new Promise(resolve => setTimeout(resolve, 100))
}
`
}
