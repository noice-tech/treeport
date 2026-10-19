import { Worker } from 'node:worker_threads'

const MAX_PENDING_BYTES = 1024 * 1024

/** Bounded, batched normal logging; fatal/exit flushes do not need the event loop. */
export function createBufferedDaemonLog(
  entry: URL,
  logPath: string,
  failed: (error: Error) => void
) {
  const completion = new SharedArrayBuffer(8)
  const state = new Int32Array(completion)
  const worker = new Worker(entry, {
    workerData: { logPath, completion },
    execArgv: []
  })
  let sequence = 0
  let bytes = 0
  let queued: Buffer[] = []
  const outstanding = new Map<number, number>()
  let scheduled: NodeJS.Immediate | null = null
  let failureReported = false
  const report = (error: Error) => {
    Atomics.store(state, 1, 1)
    if (!failureReported) {
      failureReported = true
      failed(error)
    }
  }
  const acknowledge = () => {
    const completed = Atomics.load(state, 0)
    for (const [id, size] of outstanding) {
      if (id > completed) {
        break
      }

      bytes -= size
      outstanding.delete(id)
    }
    if (Atomics.load(state, 1)) {
      report(new Error('Daemon log worker could not persist logs'))
    }

    if (bytes === 0) {
      worker.unref()
    }
  }
  worker.on('message', acknowledge)
  worker.on('error', report)
  worker.unref()
  const send = () => {
    if (scheduled) {
      clearImmediate(scheduled)
    }

    scheduled = null
    if (!queued.length) {
      return
    }

    const data = Buffer.concat(queued)
    queued = []
    outstanding.set(++sequence, data.length)
    worker.postMessage({ sequence, data })
  }
  return {
    write(value: string | Uint8Array): boolean {
      acknowledge()
      if (Atomics.load(state, 1)) {
        return false
      }

      const data = Buffer.from(value)
      if (bytes + data.length > MAX_PENDING_BYTES) {
        return false
      }

      bytes += data.length
      queued.push(data)
      worker.ref()
      scheduled ??= setImmediate(send)
      return true
    },
    flushSync(): boolean {
      send()
      const deadline = Date.now() + 5_000
      while (Atomics.load(state, 0) < sequence && !Atomics.load(state, 1)) {
        const observed = Atomics.load(state, 0)
        if (observed >= sequence) {
          break
        }

        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          return false
        }

        Atomics.wait(state, 0, observed, remaining)
      }
      acknowledge()
      return !Atomics.load(state, 1)
    },
    async close(): Promise<void> {
      this.flushSync()
      await worker.terminate()
    }
  }
}
