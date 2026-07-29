import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'

interface QueuedTask {
  run: () => PromiseLike<unknown> | unknown
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

interface KeyQueue {
  queue: Queue.Queue<QueuedTask>
  pending: number
  running: boolean
  idle: Promise<void>
  resolveIdle: () => void
}

export class KeyedTaskQueue<Key> {
  private readonly queues = new Map<Key, KeyQueue>()

  enqueue<Result>(
    key: Key,
    task: () => PromiseLike<Result> | Result
  ): Promise<Result> {
    let state = this.queues.get(key)
    if (!state) {
      let resolveIdle!: () => void
      const idle = new Promise<void>((resolve) => {
        resolveIdle = resolve
      })
      state = {
        queue: Effect.runSync(Queue.unbounded<QueuedTask>()),
        pending: 0,
        running: false,
        idle,
        resolveIdle
      }
      this.queues.set(key, state)
    }

    const result = new Promise<Result>((resolve, reject) => {
      state.pending += 1
      Effect.runSync(
        Queue.offer(state.queue, {
          run: task,
          resolve: (value) => resolve(value as Result),
          reject
        })
      )
    })

    if (!state.running) {
      state.running = true
      void this.run(key, state)
    }

    return result
  }

  has(key: Key): boolean {
    return (this.queues.get(key)?.pending ?? 0) > 0
  }

  async drain(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all([...this.queues.values()].map((state) => state.idle))
    }
  }

  private async run(key: Key, state: KeyQueue): Promise<void> {
    while (state.pending > 0) {
      const task = await Effect.runPromise(Queue.take(state.queue))
      try {
        task.resolve(await task.run())
      } catch (error) {
        task.reject(error)
      } finally {
        state.pending -= 1
      }
    }

    state.running = false
    if (state.pending > 0) {
      state.running = true
      void this.run(key, state)
      return
    }

    if (this.queues.get(key) === state) {
      this.queues.delete(key)
    }

    state.resolveIdle()
  }
}
