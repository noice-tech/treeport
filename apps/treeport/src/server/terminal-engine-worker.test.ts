import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { expect, it } from 'vitest'
import { startTerminalEngineWorker } from './terminal-engine-worker'

it('joins worker shutdown and settles startup errors without leaking its scope', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-worker-'))
  const entry = path.join(root, 'worker.mjs')
  const options = {
    runtimeDir: root,
    launcherPath: '',
    sessionExecutable: '',
    journalLimitBytes: undefined,
    hostId: 'test',
    hostKey: 'test',
    token: 'test',
    socketPath: '',
    recordPath: path.join(root, 'stopped')
  }
  try {
    await fs.writeFile(
      entry,
      `
      import { parentPort, workerData } from 'node:worker_threads'
      import fs from 'node:fs/promises'
      parentPort.on('message', async () => {
        await fs.writeFile(workerData.recordPath, 'stopped')
        parentPort.close()
      })
      parentPort.postMessage('ready')
    `
    )
    await Effect.runPromise(
      Effect.scoped(startTerminalEngineWorker(entry, options, process.env))
    )
    expect(await fs.readFile(options.recordPath, 'utf8')).toBe('stopped')
    await expect(
      Effect.runPromise(
        Effect.scoped(
          startTerminalEngineWorker(
            path.join(root, 'missing.mjs'),
            options,
            process.env
          )
        )
      )
    ).rejects.toThrow()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
