interface PendingRead {
  readonly controller: AbortController
  readonly promise: Promise<unknown>
  readers: number
}

/** Share only overlapping reads. One cancelled caller must not cancel its peers. */
export class SharedRead {
  private readonly pending = new Map<string, PendingRead>()

  run<A>(
    key: string,
    signal: AbortSignal | undefined,
    evaluate: (signal: AbortSignal) => Promise<A>
  ): Promise<A> {
    signal?.throwIfAborted()
    let entry = this.pending.get(key)
    if (!entry) {
      if (this.pending.size >= 256) {
        return Promise.reject(new Error('Too many pending Git reads'))
      }

      const controller = new AbortController()
      const promise = Promise.resolve().then(() => evaluate(controller.signal))
      entry = { controller, promise, readers: 0 }
      this.pending.set(key, entry)
      const current = entry
      const settled = () => {
        if (this.pending.get(key) === current) {
          this.pending.delete(key)
        }
      }
      void promise.then(settled, settled)
    }

    const current = entry
    current.readers++
    return new Promise<A>((resolve, reject) => {
      let finished = false
      const finish = () => {
        if (finished) {
          return false
        }

        finished = true
        signal?.removeEventListener('abort', abort)
        current.readers--
        if (current.readers === 0) {
          if (this.pending.get(key) === current) {
            this.pending.delete(key)
          }

          current.controller.abort()
        }

        return true
      }
      const abort = () => {
        if (finish()) {
          reject(signal?.reason)
        }
      }
      signal?.addEventListener('abort', abort, { once: true })
      void current.promise.then(
        (value) => {
          if (finish()) {
            // SAFETY: Each key identifies one read operation and its result type.
            resolve(value as A)
          }
        },
        // eslint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejections are opaque; forward them without inspecting or changing the failure.
        (error: unknown) => {
          if (finish()) {
            reject(error)
          }
        }
      )
    })
  }
}
