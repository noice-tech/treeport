import { describe, expect, it } from 'vitest'
import { SharedRead } from './shared-read'

describe('shared Git reads', () => {
  it('shares work without letting one reader cancel another', async () => {
    const reads = new SharedRead()
    const first = new AbortController()
    const second = new AbortController()
    let complete!: (value: number) => void
    let sharedSignal!: AbortSignal
    let calls = 0

    const evaluate = (signal: AbortSignal) => {
      calls++
      sharedSignal = signal

      return new Promise<number>((resolve) => {
        complete = resolve
      })
    }

    const a = reads.run('same', first.signal, evaluate)
    const b = reads.run('same', second.signal, evaluate)
    await Promise.resolve()
    first.abort(new Error('cancelled'))
    await expect(a).rejects.toThrow('cancelled')
    expect(sharedSignal.aborted).toBe(false)
    complete(42)
    await expect(b).resolves.toBe(42)
    expect(calls).toBe(1)
    await expect(reads.run('same', undefined, async () => 43)).resolves.toBe(43)
  })

  it('cancels abandoned work and does not reuse failures', async () => {
    const reads = new SharedRead()
    const caller = new AbortController()
    let signal!: AbortSignal

    const pending = reads.run('key', caller.signal, async (value) => {
      signal = value

      return new Promise<void>((_resolve, reject) => {
        value.addEventListener('abort', () => reject(value.reason), {
          once: true
        })
      })
    })

    await Promise.resolve()
    caller.abort(new Error('abandoned'))
    await expect(pending).rejects.toThrow('abandoned')
    expect(signal.aborted).toBe(true)
    await expect(
      reads.run('key', undefined, async () => {
        throw new Error('failed')
      })
    ).rejects.toThrow('failed')
    await expect(
      reads.run('key', undefined, async () => 'retry')
    ).resolves.toBe('retry')
  })
})
