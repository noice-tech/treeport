import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import * as Effect from 'effect/Effect'
import { loadRenderer } from './renderer-load'

const url = 'http://127.0.0.1:8733'

afterEach(() => vi.useRealTimers())

it('retries a failed initial document load until the renderer is available', async () => {
  vi.useFakeTimers()

  const renderer = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    loadURL: vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Renderer unavailable'))
      .mockImplementationOnce(async () => {
        renderer.emit('did-navigate', {}, url, 503)
      })
      .mockImplementation(async () => {
        renderer.emit('did-navigate', {}, url, 200)
      })
  })

  const onFailure = vi.fn()
  const loaded = Effect.runPromise(loadRenderer(renderer, url, onFailure))
  await vi.advanceTimersByTimeAsync(999)
  expect(renderer.loadURL).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(await loaded).toBe(true)
  expect(onFailure).toHaveBeenCalledTimes(2)
  expect(renderer.listenerCount('did-navigate')).toBe(0)
  expect(renderer.loadURL).toHaveBeenCalledTimes(3)
  expect(renderer.loadURL).toHaveBeenLastCalledWith(url)
})

it('cancels retries when the owning connection is interrupted', async () => {
  vi.useFakeTimers()

  const renderer = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    loadURL: vi.fn(async () => {
      throw new Error('Renderer unavailable')
    })
  })

  const controller = new AbortController()

  const loaded = Effect.runPromiseExit(loadRenderer(renderer, url), {
    signal: controller.signal
  })

  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  expect((await loaded)._tag).toBe('Failure')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(renderer.loadURL).toHaveBeenCalledTimes(1)
})

it('does not retry a superseded navigation or a destroyed renderer', async () => {
  const renderer = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async () => {
      throw Object.assign(new Error('Navigation superseded'), {
        code: 'ERR_ABORTED'
      })
    })
  })

  expect(await Effect.runPromise(loadRenderer(renderer, url))).toBe(false)
  expect(renderer.loadURL).toHaveBeenCalledTimes(1)
  renderer.isDestroyed.mockReturnValue(true)
  expect(await Effect.runPromise(loadRenderer(renderer, url))).toBe(false)
  expect(renderer.loadURL).toHaveBeenCalledTimes(1)
})
