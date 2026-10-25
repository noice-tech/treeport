import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  BrowserClientMessage,
  BrowserServerMessage
} from '@treeport/shared'
import { connectRemoteBrowser } from './browser-remote-connection'
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

// SAFETY: WebRTC negotiation never touches the WebCodecs canvas.
const canvas = {} as HTMLCanvasElement

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  FakePeer.instances = []
})

it('negotiates native video only when visible and ignores superseded answers', async () => {
  vi.stubGlobal('RTCPeerConnection', FakePeer)

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
    canvas,
    (message) => messages.push(message),
    failed,
    vi.fn(),
    vi.fn()
  )

  receiver.receive({ type: 'videoReady' })
  expect(FakePeer.instances).toHaveLength(0)
  receiver.setVisible(true)
  expect(FakePeer.instances).toHaveLength(0)
  receiver.receive({ type: 'videoReady' })
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
  const pendingStats = receiver.stats()
  receiver.setVisible(false)
  expect(await pendingStats).toBeNull()
  expect(await receiver.stats()).toBeNull()
  expect(first.close).toHaveBeenCalledOnce()
  receiver.receive({
    type: 'videoAnswer',
    requestId: offer.requestId,
    sdp: 'stale'
  })
  expect(first.setRemoteDescription).not.toHaveBeenCalled()
  receiver.receive({ type: 'videoReady' })
  receiver.setVisible(true)
  expect(FakePeer.instances).toHaveLength(1)
  receiver.receive({ type: 'videoReady' })
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

it('owns signaling and media visibility/disposal together even for immediate host replies', async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => null })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ticket: 'b'.repeat(43) })))
  )
  const events = new EventEmitter()

  const socket = {
    connected: true,
    on: events.on.bind(events),
    emit: vi.fn((_event: string, message: BrowserClientMessage) => {
      if (message.type === 'setVisible' && message.visible) {
        events.emit('message', { type: 'videoReady' })
      }
    }),
    disconnect: vi.fn()
  }

  // SAFETY: Signaling does not deliver tracks; the receiver only clears srcObject.
  const video = { srcObject: null } as HTMLVideoElement

  const connection = connectRemoteBrowser(
    'app-browser',
    video,
    canvas,
    {
      message: vi.fn(),
      failed: vi.fn(),
      statusChanged: vi.fn(),
      presented: vi.fn()
    },
    () => socket
  )

  connection.setVisible(true)
  await vi.waitFor(() => expect(events.listenerCount('message')).toBe(1))

  const ready: BrowserServerMessage = {
    type: 'ready',
    state: {
      url: 'about:blank',
      title: '',
      faviconUrl: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      controlled: true,
      hasController: true,
      controller: 'you',
      controllerDetails: null,
      videoSettings: null,
      viewport: { width: 390, height: 844 }
    }
  }

  events.emit('message', ready)
  await vi.waitFor(() =>
    expect(socket.emit).toHaveBeenCalledWith(
      'command',
      expect.objectContaining({ type: 'videoOffer' })
    )
  )
  connection.setVisible(false)
  expect(FakePeer.instances[0]!.close).toHaveBeenCalledOnce()
  connection.setVisible(true)
  await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(2))
  expect(FakePeer.instances[1]!.close).not.toHaveBeenCalled()
  connection.dispose()
  expect(FakePeer.instances[1]!.close).toHaveBeenCalledOnce()
  expect(socket.disconnect).toHaveBeenCalledOnce()
})

it('bounds connection retries and closes media when the signaling session is lost', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => null })

  // SAFETY: No track is delivered in this signaling-lifecycle test.
  const video = Object.assign({} as HTMLVideoElement, {
    srcObject: null,
    play: vi.fn(async () => undefined)
  })

  const failed = vi.fn()

  const receiver = new BrowserVideoReceiver(
    video,
    canvas,
    vi.fn(),
    failed,
    vi.fn(),
    vi.fn()
  )

  receiver.setVisible(true)
  receiver.receive({ type: 'videoReady' })
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
