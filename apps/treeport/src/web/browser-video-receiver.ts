import {
  gatherBrowserIce,
  type BrowserClientMessage,
  type BrowserServerMessage
} from '@treeport/shared'
import type { BrowserMediaWheel } from './browser-media-protocol'
import { presentBrowserVideo } from './browser-video-presentation'
import { ChromiumWebCodecsReceiver } from './chromium-webcodecs-receiver'

export class BrowserVideoReceiver {
  // Owns the canvas for its lifetime: an OffscreenCanvas transfers only once.
  private webcodecs: ChromiumWebCodecsReceiver | null = null
  private webcodecsEpoch: number | null = null
  private mediaToken: string | null = null
  private peer: RTCPeerConnection | null = null
  private requestId: string | null = null
  private visible = false
  private available = false
  private disposed = false
  private stopPresentation: (() => void) | null = null
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly send: (message: BrowserClientMessage) => void,
    private readonly failed: (message: string) => void,
    private readonly statusChanged: (message: string) => void,
    private readonly presented: () => void
  ) {}

  receive(message: BrowserServerMessage): void {
    if (this.disposed) {
      return
    }

    if (
      (message.type === 'ready' ||
        message.type === 'state' ||
        message.type === 'controlChanged') &&
      !message.state.controlled
    ) {
      if (this.webcodecsEpoch !== null) {
        this.stop()
      }

      if (message.state.hasController) {
        this.statusChanged('Paused while another window has control.')
      }
    }

    if (message.type === 'videoChannel') {
      this.mediaToken = message.mediaToken
      this.webcodecs?.connect(message.mediaToken)
    } else if (message.type === 'webcodecsReady') {
      if (!this.visible) {
        return
      }

      this.stop()
      if (!ChromiumWebCodecsReceiver.supported(this.canvas)) {
        const reason =
          'This browser cannot decode hosted browser video. Use a current Chrome, Edge, Safari or Firefox.'
        this.send({ type: 'webcodecsStop', message: reason })
        this.failed(reason)
        return
      }

      this.statusChanged('Connecting browser video…')
      if (!this.webcodecs) {
        this.webcodecs = new ChromiumWebCodecsReceiver(
          this.canvas,
          this.presented,
          (wheel) =>
            this.send({
              type: 'wheel',
              x: wheel.x,
              y: wheel.y,
              deltaX: wheel.deltaX,
              deltaY: wheel.deltaY,
              modifiers: wheel.modifiers
            })
        )
        if (this.mediaToken) {
          this.webcodecs.connect(this.mediaToken)
        }
      }

      const receiver = this.webcodecs
      this.webcodecsEpoch = message.epoch
      void receiver.start(message).catch((error) => {
        if (this.webcodecsEpoch === message.epoch) {
          this.send({
            type: 'webcodecsStop',
            message: String(error).slice(0, 512)
          })
          this.stop()
          this.failed(String(error))
        }
      })
    } else if (message.type === 'videoReady') {
      if (!this.visible) {
        return
      }

      this.available = true
      this.attempts = 0
      this.start()
    } else if (
      message.type === 'videoAnswer' &&
      message.requestId === this.requestId &&
      this.peer
    ) {
      const peer = this.peer
      void peer
        .setRemoteDescription({ type: 'answer', sdp: message.sdp })
        .catch((cause) => {
          if (this.peer === peer) {
            this.retry(cause instanceof Error ? cause.message : String(cause))
          }
        })
    } else if (
      [
        'browserUnavailable',
        'browserCrashed',
        'videoUnavailable',
        'closed'
      ].includes(message.type)
    ) {
      this.available = false
      this.stop()
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (!visible) {
      // Hiding closes the host peer and may stop capture. Wait for a fresh
      // videoReady on return instead of racing capture restart with an offer.
      this.available = false
      this.stop()
      this.statusChanged('Waiting for browser video…')
    }
  }

  async stats(): Promise<{
    connectionId: string
    report: RTCStatsReport
  } | null> {
    const peer = this.peer
    const connectionId = this.requestId
    if (!peer || !connectionId || peer.connectionState !== 'connected') {
      return null
    }

    const report = await peer.getStats().catch(() => null)
    return report && this.peer === peer ? { connectionId, report } : null
  }

  wheel(message: BrowserMediaWheel): boolean {
    return (
      this.webcodecsEpoch !== null && (this.webcodecs?.wheel(message) ?? false)
    )
  }

  private retry(message: string): void {
    this.stop()
    if (!this.visible || !this.available || this.disposed) {
      return
    }

    if (++this.attempts >= 3) {
      this.failed(
        `${message} Browser video needs a direct WebRTC connection between this device and the host. Check VPN/firewall connectivity, then retry.`
      )
      return
    }

    this.statusChanged('Reconnecting browser video…')
    this.timer = setTimeout(() => this.start(), 500 * this.attempts)
  }

  private start(): void {
    this.stop()
    this.statusChanged('Connecting browser video…')
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- WebRTC availability is a browser capability, not an untrusted protocol shape.
    if (typeof RTCPeerConnection === 'undefined') {
      this.failed('This browser does not support WebRTC video.')
      return
    }

    const peer = new RTCPeerConnection({ iceServers: [] })
    const requestId = crypto.randomUUID()
    this.peer = peer
    this.requestId = requestId
    const transceiver = peer.addTransceiver('video', { direction: 'recvonly' })
    // Remote interaction favors freshness over a smooth but delayed playout.
    // The receiver still retains the minimum buffer required for network jitter.
    transceiver.receiver.jitterBufferTarget = 0
    // Prefer H.264 for low-latency screen sharing and hardware decoding on
    // laptops. Keep every advertised fallback and repair codec; the browser
    // negotiates a mutually supported profile.
    const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs ?? []
    if (codecs.some((codec) => codec.mimeType === 'video/H264')) {
      transceiver.setCodecPreferences([
        ...codecs.filter((codec) => codec.mimeType === 'video/H264'),
        ...codecs.filter((codec) => codec.mimeType !== 'video/H264')
      ])
    }

    peer.ontrack = ({ track }) => {
      if (this.peer !== peer) {
        return
      }

      this.statusChanged('Waiting for the first frame…')
      this.stopPresentation?.()
      this.stopPresentation = presentBrowserVideo(
        this.video,
        track,
        (cause) => {
          if (this.peer === peer) {
            this.retry(cause instanceof Error ? cause.message : String(cause))
          }
        }
      )
    }
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) {
        return
      }

      if (peer.connectionState === 'connected') {
        if (this.timer) {
          clearTimeout(this.timer)
          this.timer = null
        }

        this.attempts = 0
      } else if (peer.connectionState === 'failed') {
        this.retry('Browser video connection failed.')
      } else if (peer.connectionState === 'disconnected' && !this.timer) {
        this.timer = setTimeout(
          () => this.retry('Browser video disconnected.'),
          5_000
        )
      }
    }
    this.timer = setTimeout(
      () => this.retry('Browser video connection timed out.'),
      15_000
    )
    void (async () => {
      await peer.setLocalDescription(await peer.createOffer())
      await gatherBrowserIce(peer)
      if (this.peer === peer && this.visible && !this.disposed) {
        this.send({
          type: 'videoOffer',
          requestId,
          sdp: peer.localDescription!.sdp
        })
      }
    })().catch((cause) => {
      if (this.peer === peer) {
        this.retry(cause instanceof Error ? cause.message : String(cause))
      }
    })
  }

  private stop(): void {
    if (this.webcodecsEpoch !== null) {
      this.webcodecs?.stop()
      this.webcodecsEpoch = null
    }

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    const peer = this.peer
    this.peer = null
    this.requestId = null
    this.stopPresentation?.()
    this.stopPresentation = null
    peer?.close()
    this.video.srcObject = null
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.webcodecs?.dispose()
    this.webcodecs = null
  }
}
