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
      let sequence = after
      try {
        const sources: Array<{
          path: string
          compressed: boolean
          fd: number | null
          start: number
          end: number | null
        }> = checkpoints.map((checkpoint) => ({
          path: checkpoint.path,
          compressed: true,
          fd: null,
          start: 0,
          end: null
        }))
        if (activeFd !== null) {
          sources.push({
            path: activePath,
            compressed: false,
            fd: activeFd,
            start,
            end: bytes - 1
          })
        }

        for (const source of sources) {
          const file =
            source.fd === null
              ? fs.createReadStream(source.path)
              : fs.createReadStream(source.path, {
                  fd: source.fd,
                  autoClose: true,
                  start: source.start,
                  end: source.end!
                })
          if (source.fd !== null) {
            ownedFd = null
          } // ReadStream now owns the captured descriptor.

          const input = source.compressed ? file.pipe(createGunzip()) : file
          const onError = (error: Error) => input.destroy(error)
          file.on('error', onError)
          const lines = createInterface({ input, crlfDelay: Infinity })
          let inputFailure: Error | null = null
          // readline's async iterator does not forward input-stream failures.
          // A corrupt checkpoint must disconnect the engine, never crash the
          // persistent owner through an unhandled zlib/ReadStream error event.
          input.on('error', (error: Error) => {
            inputFailure = error
            lines.close()
          })
          try {
            for await (const line of lines) {
              const record = sessionRecordSchema.parse(JSON.parse(line))
              // The first segment may overlap the requested cursor. A failed
              // rotation can also retain an already checkpointed active prefix.
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
        if (sequence !== fence) {
          throw new Error('Terminal journal does not reach its captured fence')
        }
      } finally {
        close()
      }
    })()
    return { fence, records, close }
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd)
      this.fd = null
    }
  }
}
