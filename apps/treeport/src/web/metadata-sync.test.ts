import { afterEach, describe, expect, it, vi } from 'vitest'
import { DetailedError } from './api'
import {
  apiRetryDelay,
  createInvalidationCoalescer,
  shouldRetryApiQuery
} from './metadata-sync'

afterEach(() => vi.useRealTimers())

describe('metadata sync', () => {
  it('retries transient failures within a fixed bound', () => {
    expect(shouldRetryApiQuery(0, new Error('offline'))).toBe(true)
    expect(
      shouldRetryApiQuery(1, new DetailedError('bad', { statusCode: 503 }))
    ).toBe(true)
    expect(
      shouldRetryApiQuery(0, new DetailedError('later', { statusCode: 408 }))
    ).toBe(true)
    expect(
      shouldRetryApiQuery(0, new DetailedError('later', { statusCode: 429 }))
    ).toBe(true)
    expect(
      shouldRetryApiQuery(0, new DetailedError('no', { statusCode: 400 }))
    ).toBe(false)
    expect(shouldRetryApiQuery(2, new Error('offline'))).toBe(false)
    expect(apiRetryDelay(0)).toBe(500)
    expect(apiRetryDelay(10)).toBe(2_000)
  })

  it('coalesces bursts and retains one trailing invalidation', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const invalidate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const coalescer = createInvalidationCoalescer(invalidate, 10)
    coalescer.schedule()
    coalescer.schedule()
    await vi.advanceTimersByTimeAsync(10)
    expect(invalidate).toHaveBeenCalledTimes(1)
    coalescer.schedule()
    coalescer.schedule()
    release?.()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(invalidate).toHaveBeenCalledTimes(2)
    coalescer.dispose()
  })

  it('cancels queued work on disposal', async () => {
    vi.useFakeTimers()
    const invalidate = vi.fn(async () => undefined)
    const coalescer = createInvalidationCoalescer(invalidate, 10)
    coalescer.schedule()
    coalescer.dispose()
    await vi.advanceTimersByTimeAsync(20)
    expect(invalidate).not.toHaveBeenCalled()
  })
})
