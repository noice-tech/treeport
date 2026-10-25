import fs from 'node:fs'
import path from 'node:path'

const LOG_LIMIT_BYTES = 5 * 1024 * 1024

// Open on each write: rotation must not strand a writer on a renamed file.
// This synchronous boundary also works during fatal errors and process exit.
export function appendDaemonLog(
  logPath: string,
  value: string | Uint8Array
): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })

  let bytes =
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- Normalize Node's documented string/byte output contract at the file boundary.
    typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)

  if (bytes.byteLength > LOG_LIMIT_BYTES) {
    const notice = Buffer.from(
      '[Treeport log chunk truncated; retaining its tail]\n'
    )

    bytes = Buffer.concat([
      notice,
      bytes.subarray(-LOG_LIMIT_BYTES + notice.length)
    ])
  }

  const size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0

  if (size > 0 && size + bytes.byteLength > LOG_LIMIT_BYTES) {
    fs.rmSync(`${logPath}.1`, { force: true })
    fs.renameSync(logPath, `${logPath}.1`)
  }

  fs.appendFileSync(logPath, bytes, { mode: 0o600 })
}

export async function tailDaemonLog(
  logPath: string,
  lines: number
): Promise<string> {
  const parts: string[] = []
  let remaining = lines

  for (const filePath of [logPath, `${logPath}.1`]) {
    const file = await fs.promises
      .open(filePath, 'r')
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null
        }

        throw error
      })

    if (!file) {
      continue
    }

    try {
      let position = (await file.stat()).size
      const chunks: Buffer[] = []
      let newlines = 0
      let readBytes = 0

      // Bound reads even for legacy files containing an enormous single line.
      while (
        position > 0 &&
        newlines <= remaining &&
        readBytes < LOG_LIMIT_BYTES
      ) {
        const length = Math.min(position, 64 * 1024)
        position -= length
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await file.read(buffer, 0, length, position)
        const chunk = buffer.subarray(0, bytesRead)
        readBytes += bytesRead
        chunks.unshift(chunk)

        for (const byte of chunk) {
          if (byte === 10) {
            newlines++
          }
        }
      }

      const value = Buffer.concat(chunks).toString('utf8').replace(/\n$/, '')

      if (value) {
        const selected = value.split('\n').slice(-remaining)
        parts.unshift(selected.join('\n'))
        remaining -= selected.length
      }
    } finally {
      await file.close()
    }

    if (remaining === 0) {
      break
    }
  }

  return parts.length ? `${parts.join('\n')}\n` : ''
}
