import { afterEach, expect, it, vi } from 'vitest'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { checkHealth, watchBackendHealth } from './backend-connection'

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
  const transitions: unknown[] = []
  const finished = Effect.runPromise(
    Stream.runForEach(watchBackendHealth(origin), (value) =>
      Effect.sync(() => {
        transitions.push(value)
      })
    )
  )
  await vi.advanceTimersByTimeAsync(3_749)
  expect(attempts).toEqual([0, 250, 750, 1_750])
  await vi.advanceTimersByTimeAsync(1)
  expect(transitions).toEqual([null])
  await vi.advanceTimersByTimeAsync(4_000)
  expect(attempts).toEqual([0, 250, 750, 1_750, 3_750, 5_750, 7_750])
  request.mockImplementation(async () => {
    attempts.push(Date.now())
    return Response.json(health)
  })
  await vi.advanceTimersByTimeAsync(2_000)
  await finished
  expect(transitions).toEqual([null, health])
  expect(attempts.at(-1)).toBe(9_750)
})

it('connects immediately when ready and cancels both sleeping and in-flight attempts', async () => {
  const request = vi.fn(async () => Response.json(health))
  vi.stubGlobal('fetch', request)
  expect(
    Array.from(
      await Effect.runPromise(Stream.runCollect(watchBackendHealth(origin)))
    )
  ).toEqual([health])
  expect(request).toHaveBeenCalledTimes(1)

  vi.useFakeTimers()
  request.mockResolvedValue(new Response(null, { status: 503 }))
  const sleeping = new AbortController()
  const canceled = Effect.runPromiseExit(
    Stream.runDrain(watchBackendHealth(origin)),
    { signal: sleeping.signal }
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(2)
  sleeping.abort()
  expect((await canceled)._tag).toBe('Failure')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(request).toHaveBeenCalledTimes(2)

  let finishRequest: (response: Response) => void = () => undefined
  request.mockReturnValue(
    new Promise<Response>((resolve) => {
      finishRequest = resolve
    })
  )
  const inFlight = new AbortController()
  const published = vi.fn()
  const abandoned = Effect.runPromiseExit(
    Stream.runForEach(watchBackendHealth(origin), (value) =>
      Effect.sync(() => published(value))
    ),
    { signal: inFlight.signal }
  )
  await vi.advanceTimersByTimeAsync(0)
  inFlight.abort()
  finishRequest(Response.json(health))
  expect((await abandoned)._tag).toBe('Failure')
  expect(published).not.toHaveBeenCalled()
})

it('rejects failed and malformed health responses rather than declaring readiness', async () => {
  const request = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', request)
  for (const response of [
    new Response(null, { status: 503 }),
    new Response('not json'),
    Response.json({ ok: false }),
    Response.json({ ok: true, hostname: 123 })
  ]) {
    request.mockResolvedValueOnce(response)
    expect(await Effect.runPromise(checkHealth(origin))).toBeNull()
  }
  request.mockRejectedValueOnce(new Error('Connection refused'))
  expect(await Effect.runPromise(checkHealth(origin))).toBeNull()
  expect(request).toHaveBeenLastCalledWith(`${origin}/api/health`, {
    redirect: 'error',
    signal: expect.any(AbortSignal)
  })
})

it('bounds a stalled health response body and aborts its fetch', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | null = null
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, options: RequestInit) => {
      signal = options.signal ?? null
      return Promise.resolve(new Response(new ReadableStream({ start() {} })))
    })
  )
  const result = Effect.runPromise(checkHealth(origin))
  await vi.advanceTimersByTimeAsync(1_500)
  expect(await result).toBeNull()
  expect(signal!.aborted).toBe(true)
})
