/* eslint-disable anti-slop/no-runtime-typeof -- Cursor hook JSON is untrusted at this stdio boundary. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isatty } from 'node:tty'
import { fileURLToPath } from 'node:url'

const event = process.argv[2]
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
  if (input.length > 1024 * 1024) {
    process.stdout.write('{"continue":true}\n')
    process.exit(0)
  }
}

async function runHook() {
  if (!process.env.TREEPORT_TERMINAL_ID) {
    return { continue: true }
  }

  if (event === 'context') {
    return {
      continue: true,
      additional_context:
        'You are running in a Treeport-managed terminal. Use the treeport skill for persistent terminals, shared browser tabs, projects, and separate trees. Run treeport context before Treeport operations to read the current tree, assigned task, and target instance. Only act on a tree task when the user asks. Do not stop the inherited Treeport daemon or delete this terminal.'
    }
  }

  const payload = JSON.parse(input)
  const generation =
    typeof payload?.generation_id === 'string' ? payload.generation_id : null
  // Cursor captures hook stdio and detaches its shell from the controlling
  // terminal. Find the nearest terminal-owning ancestor, not /dev/tty or stdout.
  let ownerPid = process.ppid
  let tty = null
  for (let depth = 0; depth < 16 && ownerPid > 1; depth += 1) {
    const result = spawnSync(
      'ps',
      ['-p', String(ownerPid), '-o', 'ppid=,tty='],
      { encoding: 'utf8', timeout: 1_000 }
    )
    const [parent, device] = result.stdout?.trim().split(/\s+/) ?? []
    if (/^(?:pts\/\d+|ttys?\d+)$/.test(device ?? '')) {
      tty = '/dev/' + device
      break
    }

    ownerPid = Number(parent)
  }

  if (!tty) {
    return { continue: true }
  }

  const directory = join(tmpdir(), `treeport-cursor-${process.getuid()}`)
  mkdirSync(directory, { mode: 0o700, recursive: true })
  const stat = lstatSync(directory)
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  ) {
    throw new Error('Unsafe Cursor status directory')
  }

  const key = createHash('sha256')
    .update(process.env.TREEPORT_TERMINAL_ID + ':' + ownerPid)
    .digest('hex')
    .slice(0, 20)
  const socketPath = join(directory, key + '.sock')
  const message = JSON.stringify({ event, generation })
  const send = () =>
    new Promise((resolve) => {
      const socket = createConnection(socketPath)
      socket.setTimeout(2_000, () => socket.destroy())
      socket.on('error', () => {})
      socket.on('connect', () => socket.end(message))
      socket.on('close', (hadError) =>
        resolve(!hadError && socket.bytesWritten > 0)
      )
    })
  if (await send()) {
    return { continue: true }
  }

  if (event !== 'working') {
    return { continue: true }
  }

  const fd = openSync(tty, 'w')
  if (!isatty(fd)) {
    closeSync(fd)
    return { continue: true }
  }

  const worker = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./status-worker.mjs', import.meta.url)),
      socketPath,
      String(ownerPid)
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd, 'ipc'] }
  )
  closeSync(fd)
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000)
    const ready = () => {
      clearTimeout(timeout)
      resolve()
    }
    worker.once('message', ready)
    worker.once('error', ready)
    worker.once('exit', ready)
  })
  if (worker.connected) {
    worker.disconnect()
  }

  worker.unref()
  await send()
  return { continue: true }
}

// Status reporting must never block a prompt, and stdout belongs to Cursor's
// hook protocol. Fail open if a terminal disappears or a hook payload is invalid.
const response = await runHook().catch(() => ({ continue: true }))
process.stdout.write(JSON.stringify(response) + '\n')
