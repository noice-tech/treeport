import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBufferedDaemonLog } from './buffered-daemon-log'

const entry = new URL(
  '../../dist/node/server/daemon-log-worker.js',
  import.meta.url
)

describe('buffered daemon diagnostics', () => {
  it('flushes queued logs in order without needing the main event loop', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-log-'))
    const logPath = path.join(root, 'logs', 'daemon.log')
    const failures: Error[] = []
    const log = createBufferedDaemonLog(entry, logPath, (error) =>
      failures.push(error)
    )
    try {
      for (let index = 0; index < 1_000; index++) {
        expect(log.write(`${index}\n`)).toBe(true)
      }
      // No await: this also exercises flushing before the worker is ready.
      expect(log.flushSync()).toBe(true)
      expect(await fs.readFile(logPath, 'utf8')).toBe(
        Array.from({ length: 1_000 }, (_, index) => `${index}\n`).join('')
      )
      expect(failures).toEqual([])
      expect(log.write('after flush\n')).toBe(true)
      expect(log.flushSync()).toBe(true)
      expect(
        (await fs.readFile(logPath, 'utf8')).endsWith('after flush\n')
      ).toBe(true)
    } finally {
      await log.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('bounds queued bytes and reports disk failures', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-log-'))
    const failures: Error[] = []
    await fs.writeFile(path.join(root, 'not-a-directory'), '')
    const log = createBufferedDaemonLog(
      entry,
      path.join(root, 'not-a-directory', 'log'),
      (error) => failures.push(error)
    )
    try {
      expect(log.write(Buffer.alloc(1024 * 1024 + 1))).toBe(false)
      expect(log.write('cannot persist')).toBe(true)
      expect(log.flushSync()).toBe(false)
      expect(failures).toHaveLength(1)
      expect(log.write('after failure')).toBe(false)
    } finally {
      await log.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
