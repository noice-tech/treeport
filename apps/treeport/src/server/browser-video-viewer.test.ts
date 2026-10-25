import { expect, it, vi } from 'vitest'
import { BrowserVideoViewer } from './browser-video-viewer'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void

  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

it.each(['answer', 'failure'] as const)(
  'drains a revoked %s before allowing a replacement offer',
  async (outcome) => {
    const send = vi.fn(() => true)
    const pending = deferred<string>()
    const cleanup = deferred<void>()

    const old = {
      webcodecs: null,
      negotiate: vi.fn(() => pending.promise),
      close: vi
        .fn(async (): Promise<void> => undefined)
        .mockImplementationOnce(() => cleanup.promise)
    }

    const next = {
      webcodecs: null,
      negotiate: vi.fn(async () => 'new-answer'),
      close: vi.fn(async () => undefined)
    }

    const viewer = new BrowserVideoViewer(send)
    viewer.resume(old)
    viewer.offer('old', 'offer')
    viewer.offer('duplicate', 'offer')
    expect(old.negotiate).toHaveBeenCalledOnce()
    viewer.suspend()
    viewer.resume(next)
    viewer.offer('premature', 'offer')
    expect(next.negotiate).not.toHaveBeenCalled()
    expect(send.mock.calls).toEqual([[{ type: 'videoReady' }]])

    if (outcome === 'answer') {
      pending.resolve('stale-answer')
    } else {
      pending.reject(new Error('stale-failure'))
    }

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(send.mock.calls).toEqual([[{ type: 'videoReady' }]])
    cleanup.resolve()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    viewer.offer('current', 'offer')
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith({
        type: 'videoAnswer',
        requestId: 'current',
        sdp: 'new-answer'
      })
    )
    expect(next.close).not.toHaveBeenCalled()
    viewer.dispose()
    expect(next.close).toHaveBeenCalledOnce()
  }
)

it('revokes an activation lease even when the caller reuses the same backend', async () => {
  const send = vi.fn(() => true)
  const pending = deferred<string>()

  const source = {
    webcodecs: null,
    negotiate: vi
      .fn(async () => 'current')
      .mockImplementationOnce(() => pending.promise),
    close: vi.fn(async () => undefined)
  }

  const viewer = new BrowserVideoViewer(send)
  viewer.resume(source)
  viewer.offer('old', 'offer')
  viewer.suspend()
  viewer.resume(source)
  pending.resolve('stale')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  expect(send.mock.calls).toEqual([
    [{ type: 'videoReady' }],
    [{ type: 'videoReady' }]
  ])
  viewer.offer('new', 'offer')
  await vi.waitFor(() =>
    expect(send).toHaveBeenLastCalledWith({
      type: 'videoAnswer',
      requestId: 'new',
      sdp: 'current'
    })
  )
  viewer.dispose()
})

it('coalesces rapid visibility changes and cannot revive a disposed viewer', async () => {
  const send = vi.fn(() => true)
  const cleanup = deferred<void>()

  const first = {
    webcodecs: null,
    negotiate: vi.fn(async () => 'first'),
    close: vi.fn(() => cleanup.promise)
  }

  const skipped = {
    webcodecs: null,
    negotiate: vi.fn(async () => 'skipped'),
    close: vi.fn(async () => undefined)
  }

  const last = {
    webcodecs: null,
    negotiate: vi.fn(async () => 'last'),
    close: vi.fn(async () => undefined)
  }

  const viewer = new BrowserVideoViewer(send)
  viewer.resume(first)
  viewer.suspend()
  viewer.resume(skipped)
  viewer.suspend()
  viewer.resume(last)
  viewer.dispose()
  viewer.resume(first)
  cleanup.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  viewer.offer('after-dispose', 'offer')
  expect(send.mock.calls).toEqual([[{ type: 'videoReady' }]])
  expect(first.negotiate).not.toHaveBeenCalled()
  expect(skipped.negotiate).not.toHaveBeenCalled()
  expect(last.negotiate).not.toHaveBeenCalled()
  expect(last.close).toHaveBeenCalledOnce()
})

it('waits for capture readiness and replaces a failed source without retaining stale answers', async () => {
  const send = vi.fn(() => true)

  const first = {
    webcodecs: null,
    negotiate: vi.fn(async () => {
      throw new Error('capture failed')
    }),
    close: vi.fn(async () => undefined)
  }

  const viewer = new BrowserVideoViewer(send)
  viewer.offer('too-early', 'offer')
  expect(send).not.toHaveBeenCalled()
  viewer.resume(first)
  viewer.resume(first)
  expect(send).toHaveBeenCalledOnce()
  viewer.offer('failed', 'offer')
  await vi.waitFor(() =>
    expect(send).toHaveBeenLastCalledWith({
      type: 'videoUnavailable',
      message: 'capture failed'
    })
  )

  const next = {
    webcodecs: null,
    negotiate: vi.fn(async () => 'answer'),
    close: vi.fn(async () => undefined)
  }

  viewer.resume(next)
  await vi.waitFor(() =>
    expect(send).toHaveBeenLastCalledWith({ type: 'videoReady' })
  )
  viewer.offer('recovered', 'offer')
  await vi.waitFor(() =>
    expect(send).toHaveBeenLastCalledWith({
      type: 'videoAnswer',
      requestId: 'recovered',
      sdp: 'answer'
    })
  )
  viewer.dispose()
})
