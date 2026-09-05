import { expect, it } from 'vitest'
import type { BrowserFrame } from '@treeport/shared'
import { receiveBrowserVideo } from './browser-video'

it('relays encoded video without changing its dependencies and rejects invalid capture output', () => {
  const frames: Array<Omit<BrowserFrame, 'sequence'>> = []
  const failures: string[] = []
  const receive = (payload: string) =>
    receiveBrowserVideo(
      payload,
      (frame) => frames.push(frame),
      (message) => failures.push(message)
    )
  const frame = {
    mimeType: 'video/vp8',
    keyframe: true,
    timestamp: 1,
    width: 800,
    height: 600,
    data: Buffer.from([1, 2, 3]).toString('base64')
  }
  receive(JSON.stringify({ frame, error: null }))
  receive(
    JSON.stringify({
      frame: { ...frame, timestamp: 33_334, keyframe: false },
      error: null
    })
  )
  expect(frames).toEqual([
    { ...frame, data: Buffer.from([1, 2, 3]) },
    {
      ...frame,
      data: Buffer.from([1, 2, 3]),
      timestamp: 33_334,
      keyframe: false
    }
  ])
  receive(JSON.stringify({ frame: { ...frame, width: 100_000 }, error: null }))
  receive('{invalid')
  receive(JSON.stringify({ frame: null, error: 'Capture stopped' }))
  expect(frames).toHaveLength(2)
  expect(failures).toHaveLength(3)
  expect(failures.at(-1)).toBe('Capture stopped')
})
