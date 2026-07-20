import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api.js'
import {
  createInvalidationCoalescer,
  metadataRetryDelay,
  shouldRetryMetadataQuery
} from './metadata-sync.js'

afterEach(() => vi.useRealTimers())

describe('metadata sync', () => {
  it('retries transient failures within a fixed bound', () => {
    expect(shouldRetryMetadataQuery(0, new Error('offline'))).toBe(true)
    expect(
      shouldRetryMetadataQuery(1, new ApiError('UPSTREAM', 'bad', 503))
    ).toBe(true)
    expect(
      shouldRetryMetadataQuery(0, new ApiError('UNAUTHORIZED', 'no', 401))
    ).toBe(false)
    expect(shouldRetryMetadataQuery(2, new Error('offline'))).toBe(false)
    expect(metadataRetryDelay(0)).toBe(500)
    expect(metadataRetryDelay(10)).toBe(2_000)
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
