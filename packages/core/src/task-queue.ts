export class KeyedTaskQueue<Key> {
  private readonly tails = new Map<Key, Promise<void>>()

  enqueue<Result>(
    key: Key,
    task: () => PromiseLike<Result> | Result
  ): Promise<Result> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task)
    const tail = result.then(
      () => {
        if (this.tails.get(key) === tail) {
          this.tails.delete(key)
        }
      },
      () => {
        if (this.tails.get(key) === tail) {
          this.tails.delete(key)
        }
      }
    )
    this.tails.set(key, tail)
    return result
  }

  has(key: Key): boolean {
    return this.tails.has(key)
  }

  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all(this.tails.values())
    }
  }
}
