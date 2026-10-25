import { spawnSync } from 'node:child_process'
import { writeSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { createServer } from 'node:net'

const [socketPath, rawOwnerPid] = process.argv.slice(2)
const ownerPid = Number(rawOwnerPid)

if (!socketPath || !Number.isInteger(ownerPid) || ownerPid <= 1) {
  process.exit(1)
}

// A descriptor inherited from the hook targets the original Cursor terminal,
// even though this helper is detached and its own stdio is not a terminal.
let working = false
let generation = null
let closing = false

const emit = (data) => {
  // Deleting a terminal can close its PTY before the owner watcher runs.
  try {
    writeSync(3, data)
  } catch {
    working = false
    void close()
  }
}

const clear = (notify) => {
  if (working) {
    working = false
    emit('\u001b]9;4;0\u001b\\' + (notify ? '\u0007' : ''))
  }
}

const server = createServer((socket) => {
  let input = ''
  socket.setEncoding('utf8')
  socket.setTimeout(2_000, () => socket.destroy())
  socket.on('error', () => {})
  socket.on('data', (data) => {
    input += data

    if (input.length > 1024) {
      socket.destroy()
    }
  })
  socket.on('end', () => {
    const message = Promise.resolve().then(() => JSON.parse(input))
    void message
      .then(({ event, generation: nextGeneration }) => {
        if (event === 'working') {
          generation = nextGeneration
          working = true
          emit('\u001b]9;4;3\u001b\\')
        } else if (event === 'stopped' && nextGeneration === generation) {
          clear(true)
        } else if (event === 'ended') {
          void close()
        }

        socket.end()
      })
      .catch(() => socket.destroy())
  })
})

const close = async () => {
  if (closing) {
    return
  }

  closing = true
  clear(false)
  clearInterval(heartbeat)
  clearInterval(ownerWatch)
  server.close()
  await unlink(socketPath).catch(() => {})
}

// Compare creation time as well as PID so a recycled PID cannot keep an orphan
// heartbeat alive. Cursor does not consistently fire sessionEnd on shutdown.
const ownerIdentity = () =>
  spawnSync('ps', ['-p', String(ownerPid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 1_000
  }).stdout?.trim() || null

const identity = ownerIdentity()

const ownerWatch = setInterval(() => {
  if (!identity || ownerIdentity() !== identity) {
    void close()
  }
}, 2_000)

const heartbeat = setInterval(() => {
  if (working) {
    emit('\u001b]9;4;3\u001b\\')
  }
}, 60_000)

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => void close())
}

server.once('error', () => {
  // Another hook may have started the per-session helper concurrently. Do not
  // unlink its socket; the caller will connect to the winning helper.
  clearInterval(heartbeat)
  clearInterval(ownerWatch)
  process.exitCode = 1
})

server.listen(socketPath, () => process.send?.('ready'))
