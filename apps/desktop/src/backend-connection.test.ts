import { afterEach, expect, it, vi } from 'vitest'
import { checkHealth, watchBackendHealth } from './backend-connection'

// Vitest's clock controls global timers, not node:timers/promises. Replace only
// that timing primitive; health parsing, backoff and cancellation remain real.
// eslint-disable-next-line anti-slop/no-module-mocking -- Adapt only the abortable timer primitive to the controlled clock, without mocking the connection boundary.
vi.mock('node:timers/promises', () => ({
  setTimeout: (
    ms: number,
    value: undefined,
    options: { signal: AbortSignal }
  ) =>
    new Promise<undefined>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        reject(options.signal.reason)
      }
      const timer = setTimeout(() => {
        options.signal.removeEventListener('abort', abort)
        resolve(value)
      }, ms)
      options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal.aborted) {
        abort()
      }
    })
}))

const health = { ok: true, version: '0.7.0', hostname: 'test-computer' }
const origin = 'http://127.0.0.1:8733'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('backs off, reports unavailable once after the grace period, caps retries, and recovers', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const attempts: number[] = []
  const request = vi.fn(async () => {
    attempts.push(Date.now())
    return new Response(null, { status: 503 })
  })
  vi.stubGlobal('fetch', request)
  const controller = new AbortController()
  const transitions = watchBackendHealth(origin, controller.signal)
  const unavailable = transitions.next()
  await vi.advanceTimersByTimeAsync(3_749)
  expect(attempts).toEqual([0, 250, 750, 1_750])
  await vi.advanceTimersByTimeAsync(1)
  expect(await unavailable).toEqual({ done: false, value: null })
  const ready = transitions.next()
  await vi.advanceTimersByTimeAsync(4_000)
  expect(attempts).toEqual([0, 250, 750, 1_750, 3_750, 5_750, 7_750])
  request.mockImplementation(async () => {
    attempts.push(Date.now())
    return Response.json(health)
  })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(await ready).toEqual({ done: false, value: health })
  expect(attempts.at(-1)).toBe(9_750)
  expect(await transitions.next()).toEqual({ done: true, value: undefined })
})

it('connects immediately when ready and cancels both sleeping and in-flight attempts', async () => {
  vi.useFakeTimers()
  const request = vi.fn(async () => Response.json(health))
  vi.stubGlobal('fetch', request)
  const ready = watchBackendHealth(origin, new AbortController().signal)
  expect(await ready.next()).toEqual({ done: false, value: health })
  expect(await ready.next()).toEqual({ done: true, value: undefined })
  expect(request).toHaveBeenCalledTimes(1)

  request.mockResolvedValue(new Response(null, { status: 503 }))
  const sleeping = new AbortController()
  const canceled = watchBackendHealth(origin, sleeping.signal).next()
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(2)
  sleeping.abort()
  expect(await canceled).toEqual({ done: true, value: undefined })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(request).toHaveBeenCalledTimes(2)

  // A superseded request may still finish; it must not publish stale health.
  let finishRequest: (response: Response) => void = () => undefined
  request.mockReturnValue(
    new Promise<Response>((resolve) => {
      finishRequest = resolve
    })
  )
  const inFlight = new AbortController()
  const abandoned = watchBackendHealth(origin, inFlight.signal).next()
  inFlight.abort()
  finishRequest(Response.json(health))
  expect(await abandoned).toEqual({ done: true, value: undefined })
})

it('rejects failed and malformed health responses rather than declaring readiness', async () => {
  const request = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', request)
  const controller = new AbortController()
  for (const response of [
    new Response(null, { status: 503 }),
    new Response('not json'),
    Response.json({ ok: false }),
    Response.json({ ok: true, hostname: 123 })
  ]) {
    request.mockResolvedValueOnce(response)
    expect(await checkHealth(origin, controller.signal)).toBeNull()
  }
  request.mockRejectedValueOnce(new Error('Connection refused'))
  expect(await checkHealth(origin, controller.signal)).toBeNull()
  expect(request).toHaveBeenLastCalledWith(`${origin}/api/health`, {
    redirect: 'error',
    signal: expect.any(AbortSignal)
  })
})
