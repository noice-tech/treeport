import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserClientMessage, BrowserFrame } from '@treeport/shared'
import { BrowserVideoDecoder } from './browser-video-decoder'

afterEach(() => vi.unstubAllGlobals())

it('acknowledges displayed or discarded video, recovers at keyframes, and stops repeated decoder failures', () => {
  const decoders: FakeDecoder[] = []
  const messages: BrowserClientMessage[] = []
  const displayed: number[] = []
  const failures: Array<{ message: string; fatal: boolean }> = []
  let closedFrames = 0
  class FakeDecoder {
    state: CodecState = 'unconfigured'
    decodeQueueSize = 0
    chunks: EncodedVideoChunk[] = []
    constructor(readonly callbacks: VideoDecoderInit) {
      decoders.push(this)
    }
    configure() {
      this.state = 'configured'
    }
    decode(chunk: EncodedVideoChunk) {
      this.chunks.push(chunk)
      this.decodeQueueSize++
    }
    close() {
      this.state = 'closed'
    }
    output(timestamp: number) {
      this.decodeQueueSize--
      // SAFETY: The decoder consumes timestamp and close; draw is supplied by this fixture.
      this.callbacks.output({
        timestamp,
        close() {
          closedFrames++
        }
      } as VideoFrame)
    }
  }
  vi.stubGlobal('VideoDecoder', FakeDecoder)
  vi.stubGlobal(
    'EncodedVideoChunk',
    class {
      constructor(readonly value: EncodedVideoChunkInit) {}
    }
  )
  const decoder = new BrowserVideoDecoder(
    (frame) => displayed.push(frame.timestamp),
    (message) => messages.push(message),
    (message, fatal) => failures.push({ message, fatal })
  )
  const frame = (sequence: number, keyframe: boolean): BrowserFrame => ({
    mimeType: 'video/vp8',
    keyframe,
    timestamp: sequence * 1_000,
    width: 800,
    height: 600,
    sequence,
    data: Uint8Array.from([sequence])
  })
  decoder.receive(frame(1, true))
  decoder.receive(frame(2, false))
  expect(messages).toEqual([])
  decoders[0]!.output(1_000)
  expect(displayed).toEqual([1_000])
  expect(messages).toEqual([{ type: 'frameAck', sequence: 1 }])

  // A missing reference frame requires resynchronization, not decoding the next delta.
  decoder.receive(frame(4, false))
  expect(decoders[0]!.state).toBe('closed')
  expect(messages.slice(1)).toEqual([
    { type: 'frameAck', sequence: 2 },
    { type: 'frameAck', sequence: 4 },
    { type: 'requestVideoKeyframe' }
  ])
  decoder.receive(frame(5, true))
  decoders[1]!.output(5_000)
  expect(displayed).toEqual([1_000, 5_000])
  expect(closedFrames).toBe(2)
  for (let sequence = 6; sequence <= 10; sequence++) {
    decoder.receive(frame(sequence, false))
  }
  expect(decoders[1]!.chunks).toHaveLength(5)
  expect(
    messages
      .filter((message) => message.type === 'frameAck')
      .map((message) => message.sequence)
  ).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10])
  for (let sequence = 11; sequence <= 13; sequence++) {
    decoder.receive(frame(sequence, true))
    decoders
      .at(-1)!
      .callbacks.error(new DOMException('Invalid video', 'DataError'))
  }
  expect(failures.map((failure) => failure.fatal)).toEqual([false, false, true])
  expect(messages.at(-1)).toEqual({ type: 'setVisible', visible: false })
  const decoderCount = decoders.length
  decoder.receive(frame(14, true))
  expect(decoders).toHaveLength(decoderCount)
  decoder.dispose()
})
