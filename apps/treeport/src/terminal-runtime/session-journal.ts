import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { createGunzip } from 'node:zlib'
import type { Readable } from 'node:stream'
import {
  SESSION_MAX_FRAME_BYTES,
  sessionRecordSchema,
  type SessionRecord
} from './session-protocol.ts'

const MAX_RETAINED_ENTRIES = 65536

interface JournalSource {
  path: string
  compressed: boolean
  retainedTail: boolean
}

async function* readJsonlLines(
  input: Readable,
  retainedTail: boolean
): AsyncGenerator<string> {
  // EXTERNAL: JSON strings can contain literal U+2028/U+2029. readline treats them as
  // delimiters, but a version-1 journal uses only LF to separate records.
  input.setEncoding('utf8')
  let line = ''
  let bytes = 0

  for await (const chunk of input) {
    const text = String(chunk)
    let start = 0

    while (start < text.length) {
      const boundary = text.indexOf('\n', start)
      const end = boundary === -1 ? text.length : boundary
      const fragment = text.slice(start, end)
      bytes += Buffer.byteLength(fragment)

      if (bytes + 1 > SESSION_MAX_FRAME_BYTES) {
        throw new Error('Terminal journal record exceeds the frame limit')
      }

      line += fragment

      if (boundary === -1) {
        break
      }

      yield line
      line = ''
      bytes = 0
      start = boundary + 1
    }
  }

  if (line.length > 0 && !retainedTail) {
    throw new Error('Incomplete terminal journal record')
  }
}

async function* readRecords(
  sources: readonly JournalSource[]
): AsyncGenerator<SessionRecord> {
  let sequence = 0

  for (const source of sources) {
    let handle: FileHandle | null = null
    let file: fs.ReadStream | null = null
    let input: Readable | null = null

    try {
      handle = await fs.promises
        .open(
          source.path,
          fs.constants.O_RDONLY |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK
        )
        .catch((error) => {
          // SAFETY: Node open errors expose errno codes.
          if (
            source.retainedTail &&
            (error as NodeJS.ErrnoException).code === 'ENOENT'
          ) {
            return null
          }

          throw error
        })

      if (handle === null) {
        continue
      }

      const metadata = await handle.stat()

      if (!metadata.isFile()) {
        throw new Error('Terminal journal source is not a regular file')
      }

      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
        throw new Error('Terminal journal source exceeds the offset limit')
      }

      if (metadata.size === 0 && source.retainedTail) {
        continue
      }

      file = handle.createReadStream({
        autoClose: false,
        start: 0,
        end: metadata.size > 0 ? metadata.size - 1 : undefined
      })

      const readable = source.compressed ? file.pipe(createGunzip()) : file
      input = readable
      file.on('error', (error: Error) => readable.destroy(error))
      let untrailedRecord: SessionRecord | null = null

      for await (const line of readJsonlLines(readable, source.retainedTail)) {
        const record = sessionRecordSchema.parse(JSON.parse(line))

        if (record.sequence <= sequence) {
          continue
        }

        if (record.sequence !== sequence + 1) {
          throw new Error('Terminal journal has a sequence gap')
        }

        sequence = record.sequence

        if (untrailedRecord !== null) {
          yield untrailedRecord
          untrailedRecord = null
        }

        if (source.compressed) {
          untrailedRecord = record
        } else {
          yield record
        }
      }

      if (untrailedRecord !== null) {
        yield untrailedRecord
      }
    } finally {
      input?.destroy()
      file?.destroy()
      await handle?.close()
    }
  }
}

export class SessionJournal {
  static async *readRetained(directory: string): AsyncGenerator<SessionRecord> {
    // EXTERNAL: readdir materializes the entire directory before a caller can enforce a budget.
    const names: string[] = []
    let entries = 0
    const listing = await fs.promises.opendir(directory)

    for await (const entry of listing) {
      if (++entries > MAX_RETAINED_ENTRIES) {
        throw new Error('Terminal journal directory exceeds the entry limit')
      }

      if (/^checkpoint-\d{10}\.gz$/u.test(entry.name)) {
        names.push(entry.name)
      }
    }

    // EXTERNAL: Dir's async iterator closes its descriptor on success and on rejection.
    names.sort()

    yield* readRecords([
      ...names.map((name) => ({
        path: path.join(directory, name),
        compressed: true,
        retainedTail: false
      })),
      {
        path: path.join(directory, 'journal.jsonl'),
        compressed: false,
        retainedTail: true
      }
    ])
  }
}
