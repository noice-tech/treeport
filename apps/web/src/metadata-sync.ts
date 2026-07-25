import { ApiError } from './api'

export const METADATA_STALE_TIME_MS = 30_000
const METADATA_INVALIDATION_DELAY_MS = 75
export const METADATA_DEGRADED_GRACE_MS = 3_000

export function shouldRetryMetadataQuery(
  failureCount: number,
  error: unknown
): boolean {
  if (failureCount >= 2) {
    return false
  }

  if (!(error instanceof ApiError)) {
    return true
  }

  return error.status === 408 || error.status === 429 || error.status >= 500
}

export function metadataRetryDelay(attemptIndex: number): number {
  return Math.min(2_000, 500 * 2 ** Math.max(0, attemptIndex))
}

export interface InvalidationCoalescer {
  schedule(): void
  dispose(): void
}

export function createInvalidationCoalescer(
  invalidate: () => Promise<unknown>,
  delayMs = METADATA_INVALIDATION_DELAY_MS
): InvalidationCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let trailing = false
  let disposed = false

  const run = async () => {
    timer = null
    if (disposed) {
      return
    }

    if (running) {
      trailing = true
      return
    }

    running = true
    try {
      await invalidate()
    } catch {
      // TanStack Query owns the visible error state.
    } finally {
      running = false
      if (trailing && !disposed) {
        trailing = false
        timer = setTimeout(() => void run(), delayMs)
      }
    }
  }

  return {
    schedule() {
      if (disposed) {
        return
      }

      if (running) {
        trailing = true
        return
      }

      if (timer !== null) {
        return
      }

      timer = setTimeout(() => void run(), delayMs)
    },
    dispose() {
      disposed = true
      trailing = false
      if (timer !== null) {
        clearTimeout(timer)
      }

      timer = null
    }
  }
}
