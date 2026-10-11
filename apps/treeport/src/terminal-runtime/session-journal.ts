import fs from 'node:fs'
import path from 'node:path'
import { createGunzip, gzipSync } from 'node:zlib'
import { createInterface } from 'node:readline'
import {
  sessionRecordSchema,
  type SessionRecord,
  type SessionRecordInput
} from './session-protocol'

const SEGMENT_BYTES = 1024 * 1024

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
}

async function* readRecords(
  sources: readonly JournalSource[],
  after: number,
  fence: number | null
): AsyncGenerator<SessionRecord> {
  let sequence = after
  for (const source of sources) {
    const file = fs.createReadStream(source.path, {
      fd: source.fd ?? undefined,
      autoClose: true,
      start: source.start,
      end: source.end ?? undefined
    })
    source.onOpen?.()
    const input = source.compressed ? file.pipe(createGunzip()) : file
    file.on('error', (error: Error) => input.destroy(error))
    const lines = createInterface({ input, crlfDelay: Infinity })
    let inputFailure: Error | null = null
    // readline's async iterator does not forward input-stream failures.
    input.on('error', (error: Error) => {
      inputFailure = error
      lines.close()
    })
    try {
      for await (const line of lines) {
        const record = sessionRecordSchema.parse(JSON.parse(line))
        // Failed rotation can leave an already checkpointed active prefix.
        if (record.sequence <= sequence) {
          continue
        }

        if (record.sequence !== sequence + 1) {
          throw new Error('Terminal journal has a sequence gap')
        }

        sequence = record.sequence
        yield record
      }
      if (inputFailure) {
        throw inputFailure
      }
    } finally {
      lines.close()
      input.destroy()
      file.destroy()
    }
  }
  if (fence !== null && sequence !== fence) {
    throw new Error('Terminal journal does not reach its captured fence')
  }
}

/** Lossless, compressed checkpoints retain the original records, including
 * partial escapes, decoder boundaries, resize events, and opaque engine markers.
 * No incomplete emulator serialization is used as a recovery checkpoint.
 * The quota bounds retained storage; explicit terminal close removes it.
 * Compaction briefly needs one segment of additional disk space.
 */
export class SessionJournal {
  private readonly activePath: string
  private fd: number | null
  private activeBytes = 0
  private archiveBytes = 0
  private readonly checkpoints: Checkpoint[] = []
  private activeOffsets: Array<{ sequence: number; offset: number }> = []
  sequence = 0

  constructor(
    private readonly directory: string,
    public limitBytes: number
  ) {
    this.activePath = path.join(directory, 'journal.jsonl')
    // Never restart a PTY owner over another owner's journal.
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
    // A failed partial write is outside activeBytes and never exposed to a
    // reader. Retrying overwrites it; truncate any uncommitted trailing bytes.
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
    // Rotate the inode rather than truncating it: a reconnecting engine may
    // still be reading its captured prefix while the PTY keeps producing data.
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

  /** Capture an immutable prefix without pausing the PTY or buffering a live
   * suffix in the engine's socket. Archived files are immutable; the active
   * inode is held open and read only up to its captured byte boundary. */
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
          onOpen: null
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
            } // ReadStream owns the captured descriptor.
          })
        }

        yield* readRecords(sources, after, fence)
      } finally {
        close()
      }
    })()
    return { fence, records, close }
  }

  /** Read-only recovery after the owning process is proven dead. Read all
   * complete records, not only the last published status fence: output may
   * have been committed after the engine's last acknowledgement. */
  static async *readRetained(directory: string): AsyncGenerator<SessionRecord> {
    const names = (await fs.promises.readdir(directory))
      .filter((name) => /^checkpoint-\d{10}\.gz$/u.test(name))
      .sort()
    const sources: JournalSource[] = names.map((name) => ({
      path: path.join(directory, name),
      compressed: true,
      fd: null,
      start: 0,
      end: null,
      onOpen: null
    }))
    const activePath = path.join(directory, 'journal.jsonl')
    const active = await fs.promises.readFile(activePath).catch((error) => {
      // SAFETY: Node filesystem errors expose errno codes.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }

      return Buffer.alloc(0)
    })
    // A crashed write can leave an uncommitted partial final record. Preserve
    // the file, but do not pretend that fragment is replayable terminal output.
    const end = active.lastIndexOf(10)
    if (end !== -1) {
      sources.push({
        path: activePath,
        compressed: false,
        fd: null,
        start: 0,
        end,
        onOpen: null
      })
    }

    yield* readRecords(sources, 0, null)
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd)
      this.fd = null
    }
  }
}
