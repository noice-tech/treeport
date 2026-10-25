import { afterEach, expect, it, vi } from 'vitest'
import * as Effect from 'effect/Effect'
import { checkHealth } from './backend-connection'

const health = { ok: true, version: '0.7.0', hostname: 'test-computer' }
const origin = 'http://127.0.0.1:8733'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('reads optional metadata without imposing a daemon release or health shape', async () => {
  const request = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', request)

  for (const version of ['0.1.0', '99.0.0', 'development', null]) {
    request.mockResolvedValueOnce(
      Response.json({
        ...health,
        version,
        protocolVersion: 'unknown',
        daemonLifecycle: 'future'
      })
    )
    expect(await Effect.runPromise(checkHealth(origin))).toEqual({
      hostname: health.hostname,
      version
    })
  }

  request.mockResolvedValueOnce(
    Response.json({ hostname: health.hostname, version: 123 })
  )
  expect(await Effect.runPromise(checkHealth(origin))).toEqual({
    hostname: health.hostname,
    version: null
  })
  request.mockResolvedValueOnce(Response.json({}))
  expect(await Effect.runPromise(checkHealth(origin))).toEqual({
    hostname: null,
    version: null
  })
})

it('cancels in-flight metadata requests when the owning connection is interrupted', async () => {
  let finishRequest: (response: Response) => void = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishRequest = resolve
        })
    )
  )
  const inFlight = new AbortController()
  const published = vi.fn()

  const abandoned = Effect.runPromiseExit(
    checkHealth(origin).pipe(
      Effect.tap((value) => Effect.sync(() => published(value)))
    ),
    { signal: inFlight.signal }
  )

  inFlight.abort()
  finishRequest(Response.json(health))
  expect((await abandoned)._tag).toBe('Failure')
  expect(published).not.toHaveBeenCalled()
})

it('omits metadata for failed requests and malformed bodies', async () => {
  const request = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', request)

  for (const response of [
    new Response(null, { status: 503 }),
    new Response('not json'),
    Response.json(null)
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
