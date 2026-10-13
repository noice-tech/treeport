import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { SessionJournal } from './session-journal'
import type { SessionRecord } from './session-protocol'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

async function readHistory(root: string): Promise<SessionRecord[]> {
  const records: SessionRecord[] = []
  for await (const record of SessionJournal.readRetained(root)) {
    records.push(record)
  }
  return records
}

it('recovers ordered archives and only complete active records without changing stored history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-journal-recovery-'))
  roots.push(root)
  const expected: SessionRecord[] = [
    {
      type: 'marker',
      sequence: 1,
      at: 1,
      data: 'x'.repeat(65535) + '🌲\u2028\u2029\ud800X\udfff'
    },
    { type: 'resize', sequence: 2, at: 2, cols: 101, rows: 37 },
    { type: 'marker', sequence: 3, at: 3, data: '\ud800\ud800\udc00\udc00' }
  ]
  // Create archives out of order; their records, not directory order, define history.
  for (const index of [1, 0]) {
    await fs.writeFile(
      path.join(root, `checkpoint-${String(index + 1).padStart(10, '0')}.gz`),
      gzipSync(JSON.stringify(expected[index]) + '\r\n')
    )
  }
  const active = path.join(root, 'journal.jsonl')
  const bytes =
    JSON.stringify(expected[2]) + '\n{"type":"output","data":"partial🌲'
  await fs.writeFile(active, bytes)
  expect(await readHistory(root)).toEqual(expected)
  expect(await fs.readFile(active, 'utf8')).toBe(bytes)
  for (const tail of ['{"uncommitted":', '', null]) {
    if (tail === null) {
      await fs.rm(active)
    } else {
      await fs.writeFile(active, tail)
    }

    expect(await readHistory(root)).toEqual(expected.slice(0, 2))
  }
})

it.each(['valid', 'crc', 'truncated', 'empty', 'partial-record'] as const)(
  'validates a retained archive before handing off its final record (%s)',
  async (kind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-journal-trailer-'))
    roots.push(root)
    const expected: SessionRecord = {
      type: 'marker',
      at: 1,
      sequence: 1,
      data: randomBytes(1024 * 1024).toString('base64')
    }
    const trailer = gzipSync(Buffer.alloc(0))
    if (kind === 'crc') {
      trailer[trailer.length - 8] = trailer[trailer.length - 8]! ^ 1
    }

    const bytes =
      kind === 'empty'
        ? Buffer.alloc(0)
        : kind === 'partial-record'
          ? gzipSync(JSON.stringify(expected))
          : Buffer.concat([
              gzipSync(JSON.stringify(expected) + '\n'),
              kind === 'truncated'
                ? trailer.subarray(0, trailer.length - 1)
                : trailer
            ])
    const checkpoint = path.join(root, 'checkpoint-0000000001.gz')
    await fs.writeFile(checkpoint, bytes)
    const records = SessionJournal.readRetained(root)
    try {
      if (kind === 'valid') {
        expect((await records.next()).value).toEqual(expected)
      } else {
        await expect(records.next()).rejects.toThrow()
      }
    } finally {
      // Consumers may stop after one record; integrity cannot depend on a later next().
      await records.return(undefined)
    }
    expect((await fs.readFile(checkpoint)).equals(bytes)).toBe(true)
  }
)

it('keeps recovery bounded to the history captured before path replacement or growth', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-journal-anchor-'))
  roots.push(root)
  const file = path.join(root, 'journal.jsonl')
  const original = path.join(root, 'original.jsonl')
  const first: SessionRecord = {
    type: 'marker',
    at: 1,
    sequence: 1,
    data: 'prefix'
  }
  const second: SessionRecord = {
    type: 'marker',
    at: 2,
    sequence: 2,
    data: 'x'.repeat(256 * 1024)
  }
  await fs.writeFile(
    file,
    [first, second].map((record) => JSON.stringify(record) + '\n').join('')
  )
  const records = SessionJournal.readRetained(root)
  try {
    expect((await records.next()).value).toEqual(first)
    await fs.rename(file, original)
    await fs.writeFile(
      file,
      JSON.stringify({ ...second, data: 'replacement' }) + '\n'
    )
    await fs.appendFile(
      original,
      JSON.stringify({ ...second, sequence: 3, data: 'not captured' }) + '\n'
    )
    expect((await records.next()).value).toEqual(second)
    expect((await records.next()).done).toBe(true)
  } finally {
    await records.return(undefined)
  }
})

it.each(['active', 'checkpoint'] as const)(
  'refuses a symlink %s without following or altering its target',
  async (kind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-journal-link-'))
    roots.push(root)
    const target = path.join(root, 'outside')
    const bytes = Buffer.from(
      JSON.stringify({ type: 'marker', at: 1, sequence: 1, data: 'outside' }) +
        '\n'
    )
    const original = kind === 'checkpoint' ? gzipSync(bytes) : bytes
    await fs.writeFile(target, original)
    await fs.symlink(
      target,
      path.join(
        root,
        kind === 'checkpoint' ? 'checkpoint-0000000001.gz' : 'journal.jsonl'
      )
    )
    await expect(readHistory(root)).rejects.toThrow()
    expect(await fs.readFile(target)).toEqual(original)
  }
)
