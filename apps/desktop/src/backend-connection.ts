import { setTimeout as delay } from 'node:timers/promises'
import {
  decodeUnknownOrNull,
  desktopHealthResponseSchema,
  type DesktopHealthResponse
} from '@treeport/shared'

export async function checkHealth(
  origin: string,
  signal: AbortSignal
): Promise<DesktopHealthResponse | null> {
  const response = await fetch(new URL('/api/health', origin).toString(), {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(1_500)])
  }).catch(() => null)
  if (!response?.ok) {
    return null
  }

  const body = await response.json().catch(() => null)
  return decodeUnknownOrNull(desktopHealthResponseSchema, body)
}

// The shell owns presentation and compatibility; this boundary owns cancellable
// health polling. Emit one unavailable transition, then keep trying until ready.
export async function* watchBackendHealth(
  origin: string,
  signal: AbortSignal
): AsyncGenerator<DesktopHealthResponse | null> {
  const startedAt = Date.now()
  const retryDelays = [0, 250, 500, 1_000, 2_000]
  let attempt = 0
  let unavailable = false
  while (!signal.aborted) {
    const retryDelay = retryDelays[Math.min(attempt, retryDelays.length - 1)]!
    if (retryDelay > 0) {
      await delay(retryDelay, undefined, { signal }).catch(() => undefined)
    }

    if (signal.aborted) {
      return
    }

    const health = await checkHealth(origin, signal)
    if (signal.aborted) {
      return
    }

    if (health) {
      yield health
      return
    }

    attempt += 1
    if (!unavailable && Date.now() - startedAt >= 3_000) {
      unavailable = true
      yield null
    }
  }
}
