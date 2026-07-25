import { describe, expect, it, vi } from 'vitest'
import { KeyedTaskQueue } from './task-queue'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('KeyedTaskQueue', () => {
  it('runs same-key tasks in FIFO order', async () => {
    const queue = new KeyedTaskQueue<string>()
    const firstGate = gate()
    const calls: string[] = []

    const first = queue.enqueue('project', async () => {
      calls.push('first:start')
      await firstGate.promise
      calls.push('first:end')
      return 1
    })
    const second = queue.enqueue('project', async () => {
      calls.push('second')
      return 2
    })

    await vi.waitFor(() => expect(calls).toEqual(['first:start']))
    expect(queue.has('project')).toBe(true)
    firstGate.release()

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(calls).toEqual(['first:start', 'first:end', 'second'])
    expect(queue.has('project')).toBe(false)
  })

  it('runs different keys concurrently', async () => {
    const queue = new KeyedTaskQueue<string>()
    const firstGate = gate()
    const secondGate = gate()
    const started: string[] = []

    const first = queue.enqueue('first', async () => {
      started.push('first')
      await firstGate.promise
    })
    const second = queue.enqueue('second', async () => {
      started.push('second')
      await secondGate.promise
    })

    await vi.waitFor(() => expect(started).toEqual(['first', 'second']))
    firstGate.release()
    secondGate.release()
    await Promise.all([first, second])
  })

  it('continues after a task fails', async () => {
    const queue = new KeyedTaskQueue<string>()
    const failure = new Error('failed')
    const first = queue.enqueue('project', async () => {
      throw failure
    })
    const second = queue.enqueue('project', async () => 'completed')

    await expect(first).rejects.toBe(failure)
    await expect(second).resolves.toBe('completed')
    expect(queue.has('project')).toBe(false)
  })

  it('drains running and queued tasks', async () => {
    const queue = new KeyedTaskQueue<string>()
    const firstGate = gate()
    const secondGate = gate()
    const completed: string[] = []

    void queue.enqueue('project', async () => {
      await firstGate.promise
      completed.push('first')
    })
    void queue.enqueue('project', async () => {
      await secondGate.promise
      completed.push('second')
    })

    let drained = false
    const draining = queue.drain().then(() => {
      drained = true
    })
    firstGate.release()
    await vi.waitFor(() => expect(completed).toEqual(['first']))
    expect(drained).toBe(false)
    secondGate.release()
    await draining
    expect(completed).toEqual(['first', 'second'])
    expect(drained).toBe(true)
  })
})
