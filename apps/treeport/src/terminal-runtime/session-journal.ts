import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { createGunzip, gzipSync } from 'node:zlib'
import type { Readable } from 'node:stream'
import {
  SESSION_MAX_FRAME_BYTES,
  sessionRecordSchema,
  type SessionRecord,
  type SessionRecordInput
} from './session-protocol.ts'

const SEGMENT_BYTES = 1024 * 1024
const MAX_RETAINED_ENTRIES = 65536

interface Checkpoint {
  readonly path: string
  readonly fence: number
}

interface JournalSnapshot {
  readonly fence: number
  readonly records: AsyncGenerator<SessionRecord>
  readonly close: () => void
}

interface JournalSource {
  path: string
  compressed: boolean
  fd: number | null
  start: number
  end: number | null
  onOpen: (() => void) | null
  retainedTail: boolean
  fence: number | null
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
  sources: readonly JournalSource[],
  after: number,
  fence: number | null
): AsyncGenerator<SessionRecord> {
  let sequence = after

  for (const source of sources) {
    let handle: FileHandle | null = null
    let file: fs.ReadStream | null = null
    let input: Readable | null = null

    try {
      if (source.fd === null) {
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
          start: source.start,
          end: source.end ?? (metadata.size > 0 ? metadata.size - 1 : undefined)
        })
      } else {
        file = fs.createReadStream(source.path, {
          fd: source.fd,
          autoClose: true,
          start: source.start,
          end: source.end ?? undefined
        })
      }

      source.onOpen?.()
      const readable = source.compressed ? file.pipe(createGunzip()) : file
      input = readable
      file.on('error', (error: Error) => readable.destroy(error))
      let pending: SessionRecord | null = null

      for await (const line of readJsonlLines(readable, source.retainedTail)) {
        if (pending !== null && pending.sequence === source.fence) {
          throw new Error(
            'Terminal journal source contains data beyond its captured fence'
          )
        }

        const record = sessionRecordSchema.parse(JSON.parse(line))

        if (
          (source.fence !== null && record.sequence > source.fence) ||
          (fence !== null && record.sequence > fence)
        ) {
          throw new Error('Terminal journal exceeds its captured fence')
        }

        if (record.sequence <= sequence) {
          continue
        }

        if (record.sequence !== sequence + 1) {
          throw new Error('Terminal journal has a sequence gap')
        }

        sequence = record.sequence

        if (pending !== null) {
          yield pending
          pending = null
        }

        if (
          (source.compressed && source.fence === null) ||
          record.sequence === source.fence
        ) {
          pending = record
        } else {
          yield record
        }
      }

      if (source.fence !== null && sequence !== source.fence) {
        throw new Error(
          'Terminal journal source does not reach its captured fence'
        )
      }

      if (pending !== null) {
        yield pending
      }
    } finally {
      input?.destroy()
      file?.destroy()
      await handle?.close()
    }
  }

  if (fence !== null && sequence !== fence) {
    throw new Error('Terminal journal does not reach its captured fence')
  }
}

export class SessionJournal {
  private readonly activePath: string
  private fd: number | null
  private activeBytes = 0
  private archiveBytes = 0
  private readonly checkpoints: Checkpoint[] = []
  private activeOffsets: Array<{ sequence: number; offset: number }> = []
  sequence = 0

  private readonly directory: string
  public limitBytes: number

  constructor(directory: string, limitBytes: number) {
    this.directory = directory
    this.limitBytes = limitBytes

    this.activePath = path.join(directory, 'journal.jsonl')
    this.fd = fs.openSync(this.activePath, 'wx', 0o600)
  }

  append(record: SessionRecordInput): SessionRecord {
    if (this.activeBytes >= SEGMENT_BYTES) {
      this.compact()
    }

    const value = sessionRecordSchema.parse({
      ...record,
      at: record.at ?? Date.now(),
      sequence: this.sequence + 1
    })

    const encoded = Buffer.from(`${JSON.stringify(value)}\n`)

    if (
      this.archiveBytes + this.activeBytes + encoded.length >
      this.limitBytes
    ) {
      this.compact()

      if (
        this.archiveBytes + this.activeBytes + encoded.length >
        this.limitBytes
      ) {
        throw new Error(
          `Terminal journal quota reached (${this.limitBytes} bytes). Increase TREEPORT_TERMINAL_JOURNAL_LIMIT_BYTES and restart Treeport to resume capture.`
        )
      }
    }

    this.fd ??= fs.openSync(this.activePath, 'wx', 0o600)
    let offset = 0

    while (offset < encoded.length) {
      offset += fs.writeSync(
        this.fd,
        encoded,
        offset,
        encoded.length - offset,
        this.activeBytes + offset
      )
    }

    fs.ftruncateSync(this.fd, this.activeBytes + encoded.length)
    this.activeOffsets.push({
      sequence: value.sequence,
      offset: this.activeBytes
    })
    this.activeBytes += encoded.length
    this.sequence = value.sequence

    return value
  }

  private compact(): void {
    if (!this.activeBytes) {
      return
    }

    const encoded = gzipSync(
      fs.readFileSync(this.activePath).subarray(0, this.activeBytes)
    )

    if (this.archiveBytes + encoded.length > this.limitBytes) {
      return
    }

    const number = this.checkpoints.length + 1

    const checkpoint = path.join(
      this.directory,
      `checkpoint-${String(number).padStart(10, '0')}.gz`
    )

    const temporary = `${checkpoint}.tmp`
    const fd = fs.openSync(temporary, 'w', 0o600)

    try {
      let offset = 0

      while (offset < encoded.length) {
        offset += fs.writeSync(fd, encoded, offset)
      }

      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    fs.renameSync(temporary, checkpoint)
    this.checkpoints.push({ path: checkpoint, fence: this.sequence })
    this.archiveBytes += encoded.length
    const retired = path.join(this.directory, `retired-${number}.jsonl`)
    fs.renameSync(this.activePath, retired)

    if (this.fd !== null) {
      fs.closeSync(this.fd)
    }

    this.fd = null
    this.activeBytes = 0
    this.activeOffsets = []
    this.fd = fs.openSync(this.activePath, 'wx', 0o600)
    fs.unlinkSync(retired)
  }

  snapshot(after: number): JournalSnapshot {
    let low = 0
    let high = this.checkpoints.length

    while (low < high) {
      const middle = (low + high) >>> 1

      if (this.checkpoints[middle]!.fence <= after) {
        low = middle + 1
      } else {
        high = middle
      }
    }

    const checkpoints = this.checkpoints.slice(low)
    const fence = this.sequence
    const bytes = this.activeBytes
    low = 0
    high = this.activeOffsets.length

    while (low < high) {
      const middle = (low + high) >>> 1

      if (this.activeOffsets[middle]!.sequence <= after) {
        low = middle + 1
      } else {
        high = middle
      }
    }

    const start = this.activeOffsets[low]?.offset ?? bytes
    const activeFd = bytes > start ? fs.openSync(this.activePath, 'r') : null
    let closed = false
    let ownedFd = activeFd

    const close = () => {
      if (!closed) {
        closed = true

        if (ownedFd !== null) {
          fs.closeSync(ownedFd)
          ownedFd = null
        }
      }
    }

    const activePath = this.activePath

    const records = (async function* (): AsyncGenerator<SessionRecord> {
      try {
        const sources: JournalSource[] = checkpoints.map((checkpoint) => ({
          path: checkpoint.path,
          compressed: true,
          fd: null,
          start: 0,
          end: null,
          onOpen: null,
          retainedTail: false,
          fence: checkpoint.fence
        }))

        if (activeFd !== null) {
          sources.push({
            path: activePath,
            compressed: false,
            fd: activeFd,
            start,
            end: bytes - 1,
            onOpen: () => {
              ownedFd = null
            }, // EXTERNAL: ReadStream owns the captured descriptor.
            retainedTail: false,
            fence
          })
        }

        yield* readRecords(sources, after, fence)
      } finally {
        close()
      }
    })()

    return { fence, records, close }
  }

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

    const sources: JournalSource[] = names.map((name) => ({
      path: path.join(directory, name),
      compressed: true,
      fd: null,
      start: 0,
      end: null,
      onOpen: null,
      retainedTail: false,
      fence: null
    }))

    sources.push({
      path: path.join(directory, 'journal.jsonl'),
      compressed: false,
      fd: null,
      start: 0,
      end: null,
      onOpen: null,
      retainedTail: true,
      fence: null
    })

    yield* readRecords(sources, 0, null)
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd)
      this.fd = null
    }
  }
}
