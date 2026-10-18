import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserClientMessage } from '@treeport/shared'
import { BrowserVideoReceiver } from './browser-video-receiver'

class FakePeer extends EventTarget {
  static instances: FakePeer[] = []
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription: RTCSessionDescriptionInit | null = null
  ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  readonly transceiver = {
    receiver: { jitterBufferTarget: 100 },
    setCodecPreferences: vi.fn()
  }
  readonly addTransceiver = vi.fn(() => this.transceiver)
  readonly setRemoteDescription = vi.fn(async () => undefined)
  readonly getStats = vi.fn(async () => new Map<string, RTCStats>())
  readonly close = vi.fn(() => {
    this.connectionState = 'closed'
  })
  constructor() {
    super()
    FakePeer.instances.push(this)
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: 'offer-sdp' }
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  FakePeer.instances = []
})

it('negotiates native video only when visible and ignores superseded answers', async () => {
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: MediaStreamTrack[]) {}
    }
  )
  const workers: FakeWorker[] = []
  class FakeWorker {
    onmessage: (() => void) | null = null
    onerror: (() => void) | null = null
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() {
      workers.push(this)
    }
  }
  const outputs: FakeGenerator[] = []
  class FakeGenerator {
    writable = new WritableStream<VideoFrame>()
    stop = vi.fn()
    constructor() {
      outputs.push(this)
    }
  }
  const processor = vi.fn(function () {
    return { readable: new ReadableStream<VideoFrame>() }
  })
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('MediaStreamTrackGenerator', FakeGenerator)
  vi.stubGlobal('MediaStreamTrackProcessor', processor)
  const clones: MediaStreamTrack[] = []
  // SAFETY: Presentation only clones/stops these tracks; no media is decoded.
  const track = Object.assign({} as MediaStreamTrack, {
    clone: vi.fn(() => {
      // SAFETY: The cloned track is only passed to the fake processor or stopped.
      const clone = Object.assign({} as MediaStreamTrack, { stop: vi.fn() })
      clones.push(clone)
      return clone
    })
  })
  const codecs = [
    { mimeType: 'video/VP8' },
    { mimeType: 'video/H264' },
    { mimeType: 'video/rtx' }
  ]
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs }) })
  // SAFETY: This receiver only uses srcObject and play; both are provided below.
  const video = Object.assign({} as HTMLVideoElement, {
    srcObject: null,
    play: vi.fn(async () => undefined)
  })
  const messages: BrowserClientMessage[] = []
  const failed = vi.fn()
  const receiver = new BrowserVideoReceiver(
    video,
    (message) => messages.push(message),
    failed
  )
  receiver.receive({ type: 'videoReady' })
  expect(FakePeer.instances).toHaveLength(0)
  receiver.setVisible(true)
  await vi.waitFor(() => expect(messages).toHaveLength(1))
  const offer = messages[0]!
  expect(offer).toMatchObject({ type: 'videoOffer', sdp: 'offer-sdp' })
  if (offer.type !== 'videoOffer') {
    throw new Error('Expected a video offer')
  }

  const first = FakePeer.instances[0]!
  expect(first.addTransceiver).toHaveBeenCalledWith('video', {
    direction: 'recvonly'
  })
  expect(await receiver.stats()).toBeNull()
  first.connectionState = 'connected'
  expect(await receiver.stats()).toEqual({
    connectionId: offer.requestId,
    report: new Map()
  })
  expect(first.transceiver.receiver.jitterBufferTarget).toBe(0)
  expect(first.transceiver.setCodecPreferences).toHaveBeenCalledWith([
    codecs[1],
    codecs[0],
    codecs[2]
  ])
  first.ontrack?.({ track })
  expect(processor).toHaveBeenCalledWith({ track: clones[0], maxBufferSize: 1 })
  expect(video.srcObject).toMatchObject({ tracks: [outputs[0]] })
  expect(workers[0]!.postMessage).toHaveBeenCalledWith(
    { readable: expect.any(ReadableStream), writable: outputs[0]!.writable },
    [expect.any(ReadableStream), outputs[0]!.writable]
  )
  // A failed worker falls back without renegotiating or stopping the peer track.
  workers[0]!.onmessage?.()
  expect(video.srcObject).toMatchObject({ tracks: [track] })
  expect(clones[0]!.stop).toHaveBeenCalledOnce()
  expect(outputs[0]!.stop).toHaveBeenCalledOnce()
  expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  first.ontrack?.({ track })
  workers[0]!.onmessage?.()
  expect(video.srcObject).toMatchObject({ tracks: [outputs[1]] })
  const pendingStats = receiver.stats()
  receiver.setVisible(false)
  expect(clones[1]!.stop).toHaveBeenCalledOnce()
  expect(outputs[1]!.stop).toHaveBeenCalledOnce()
  expect(workers[1]!.terminate).toHaveBeenCalledOnce()
  expect(await pendingStats).toBeNull()
  expect(await receiver.stats()).toBeNull()
  expect(first.close).toHaveBeenCalledOnce()
  receiver.receive({
    type: 'videoAnswer',
    requestId: offer.requestId,
    sdp: 'stale'
  })
  expect(first.setRemoteDescription).not.toHaveBeenCalled()
  receiver.setVisible(true)
  await vi.waitFor(() => expect(messages).toHaveLength(2))
  const next = messages[1]!
  if (next.type !== 'videoOffer') {
    throw new Error('Expected a video offer')
  }

  const second = FakePeer.instances[1]!
  receiver.receive({
    type: 'videoAnswer',
    requestId: next.requestId,
    sdp: 'answer'
  })
  expect(second.setRemoteDescription).toHaveBeenCalledWith({
    type: 'answer',
    sdp: 'answer'
  })
  second.connectionState = 'connected'
  second.getStats.mockRejectedValueOnce(new Error('peer closed during stats'))
  expect(await receiver.stats()).toBeNull()
  receiver.dispose()
  expect(second.close).toHaveBeenCalledOnce()
  expect(failed).not.toHaveBeenCalled()
})

it('bounds connection retries and closes media when the signaling session is lost', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => null })
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: MediaStreamTrack[]) {}
    }
  )
  // SAFETY: Without track-processing APIs, presentation uses only these members.
  const video = Object.assign({} as HTMLVideoElement, {
    srcObject: null,
    play: vi.fn(async () => undefined)
  })
  const failed = vi.fn()
  const receiver = new BrowserVideoReceiver(video, vi.fn(), failed)
  receiver.setVisible(true)
  receiver.receive({ type: 'videoReady' })
  // SAFETY: Native fallback passes the track through without reading members.
  const track = {} as MediaStreamTrack
  FakePeer.instances[0]!.ontrack?.({ track })
  expect(video.srcObject).toMatchObject({ tracks: [track] })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(FakePeer.instances).toHaveLength(3)
  expect(failed).toHaveBeenCalledOnce()
  expect(
    FakePeer.instances.every((peer) => peer.close.mock.calls.length === 1)
  ).toBe(true)
  receiver.receive({ type: 'videoReady' })
  receiver.receive({
    type: 'browserUnavailable',
    message: 'Disconnected',
    installCommand: null
  })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(FakePeer.instances).toHaveLength(4)
  expect(FakePeer.instances[3]!.close).toHaveBeenCalledOnce()
  receiver.dispose()
})
