import { afterEach, expect, it, vi } from 'vitest'
import { LatestBrowserFrameProducer } from './playwright-browser'

afterEach(() => vi.useRealTimers())

it('limits producer frames, keeps the newest frame, and acknowledges every CDP frame', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const published: number[] = []
  const acknowledged: number[] = []
  const producer = new LatestBrowserFrameProducer(
    (frame) => published.push(frame.data[0]!),
    (sessionId) => acknowledged.push(sessionId),
    10
  )
  const receive = (sessionId: number, value: number) =>
    producer.receive({
      data: Buffer.from([value]).toString('base64'),
      metadata: {
        timestamp: Date.now() / 1_000,
        deviceWidth: 800,
        deviceHeight: 600
      },
      sessionId
    })

  producer.start()
  receive(1, 1)
  receive(2, 2)
  receive(3, 3)

  expect(published).toEqual([1])
  expect(acknowledged).toEqual([1, 2])
  vi.advanceTimersByTime(99)
  expect(published).toEqual([1])
  expect(acknowledged).toEqual([1, 2])
  vi.advanceTimersByTime(1)
  expect(published).toEqual([1, 3])
  expect(acknowledged).toEqual([1, 2, 3])

  receive(4, 4)
  producer.stop()
  vi.runAllTimers()
  expect(published).toEqual([1, 3])
  expect(acknowledged).toEqual([1, 2, 3, 4])
})
