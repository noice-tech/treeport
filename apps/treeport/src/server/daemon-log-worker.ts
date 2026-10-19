import { parentPort, workerData } from 'node:worker_threads'
import { appendDaemonLog } from './daemon-log'

// SAFETY: The daemon creates this private worker with this exact data shape.
const { logPath, completion } = workerData as {
  logPath: string
  completion: SharedArrayBuffer
}
const state = new Int32Array(completion)
parentPort!.on(
  'message',
  ({ sequence, data }: { sequence: number; data: Uint8Array }) => {
    try {
      appendDaemonLog(logPath, data)
    } catch {
      Atomics.store(state, 1, 1)
    }
    Atomics.store(state, 0, sequence)
    Atomics.notify(state, 0)
    parentPort!.postMessage(sequence)
  }
)
