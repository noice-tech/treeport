import type {
  BrowserClientMessage,
  BrowserServerMessage
} from '@treeport/shared'

// Full-frame Annex-B only. Decoded VideoFrames enter the existing <video>
// surface, never RTCPeerConnection.addTrack with pre-encoded bytes.
export class ChromiumWebCodecsReceiver {
  private decoder: VideoDecoder | null = null
  private track:
    | (MediaStreamTrack & { writable: WritableStream<VideoFrame> })
    | null = null
  private writer: WritableStreamDefaultWriter<VideoFrame> | null = null
  private pending: { sequence: number; timestamp: number } | null = null
  private stopped = false
  private sequence = 0
  private callback: number | null = null
  private start = performance.now()
  private bytes = 0
  private received = 0
  private decoded = 0
  private captured = 0
  private droppedRaw = 0
  private captureElapsedMs = 0
  private encodeTotalMs = 0
  private encodeMaxMs = 0
  private decodeTotalMs = 0
  private receiveToPresentTotalMs = 0
  private receiveToPresentMaxMs = 0
  private receivedAt = 0
  private frames = 0
  private lastFrame = 0
  private maxGap = 0

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly config: Extract<
      BrowserServerMessage,
      { type: 'webcodecsReady' }
    >,
    private readonly send: (message: BrowserClientMessage) => void,
    private readonly failed: (message: string) => void
  ) {}

  async startDecoder(): Promise<void> {
    // SAFETY: Chromium's optional track generator is not in standard DOM types.
    const { MediaStreamTrackGenerator } = globalThis as typeof globalThis & {
      MediaStreamTrackGenerator?: new (options: {
        kind: 'video'
      }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> }
    }
    if (!globalThis.VideoDecoder || !MediaStreamTrackGenerator) {
      throw new Error(
        'ChromiumWebCodecs prototype needs WebCodecs and MediaStreamTrackGenerator in a secure Chromium context.'
      )
    }

    const configuration: VideoDecoderConfig = {
      codec: this.config.codec,
      codedWidth: this.config.width,
      codedHeight: this.config.height,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware'
      // No description: the packet is Annex-B, with SPS/PPS on each IDR.
    }
    if (!(await VideoDecoder.isConfigSupported(configuration)).supported) {
      configuration.hardwareAcceleration = 'no-preference'
      if (!(await VideoDecoder.isConfigSupported(configuration)).supported) {
        throw new Error(
          `WebCodecs cannot decode ${this.config.codec}, including software fallback.`
        )
      }
    }

    if (this.stopped) {
      return
    }

    this.track = new MediaStreamTrackGenerator({ kind: 'video' })
    this.writer = this.track.writable.getWriter()
    this.video.title =
      'Experimental Chromium WebCodecs: fixed 1280×800 surface, 60fps target / 8Mbps. Resizing fits the viewer, not the captured display.'
    this.video.srcObject = new MediaStream([this.track])
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const pending = this.pending
        if (this.stopped || !pending || frame.timestamp !== pending.timestamp) {
          frame.close()
          return
        }

        this.decoded++
        this.decodeTotalMs += performance.now() - this.receivedAt
        const writer = this.writer!
        // One unacknowledged frame throughout socket -> decoder -> renderer.
        // ACK on actual video presentation, not merely websocket arrival.
        this.callback = this.video.requestVideoFrameCallback((now) => {
          this.callback = null
          if (this.stopped || this.pending !== pending) {
            return
          }

          this.pending = null
          this.frames++
          const receiveToPresentMs = Math.max(0, now - this.receivedAt)
          this.receiveToPresentTotalMs += receiveToPresentMs
          this.receiveToPresentMaxMs = Math.max(
            this.receiveToPresentMaxMs,
            receiveToPresentMs
          )
          if (this.lastFrame) {
            this.maxGap = Math.max(this.maxGap, now - this.lastFrame)
          }

          this.lastFrame = now
          this.video.dataset.webcodecs = JSON.stringify({
            epoch: this.config.epoch,
            frames: this.frames,
            elapsedMs: now - this.start,
            maxGapMs: this.maxGap,
            encoder: this.config.encoderBackend,
            encoderPreference: this.config.encoderPreference,
            hardwareSupported: this.config.hardwareSupported,
            decoderPreference: configuration.hardwareAcceleration,
            bytes: this.bytes,
            received: this.received,
            decoded: this.decoded,
            captured: this.captured,
            droppedRaw: this.droppedRaw,
            captureElapsedMs: this.captureElapsedMs,
            encodeTotalMs: this.encodeTotalMs,
            encodeMaxMs: this.encodeMaxMs,
            decodeTotalMs: this.decodeTotalMs,
            receiveToPresentTotalMs: this.receiveToPresentTotalMs,
            receiveToPresentMaxMs: this.receiveToPresentMaxMs
          })
          this.send({
            type: 'webcodecsAck',
            epoch: this.config.epoch,
            sequence: pending.sequence
          })
        })
        void writer
          .write(frame)
          .catch((error) => this.fail(String(error)))
          .finally(() => frame.close())
        void this.video.play().catch((error) => this.fail(String(error)))
      },
      error: (error) => this.fail(error.message)
    })
    this.decoder.configure(configuration)
    this.send({ type: 'webcodecsAck', epoch: this.config.epoch, sequence: 0 })
  }

  frame(data: Uint8Array): void {
    if (this.stopped) {
      return
    }

    if (
      !this.decoder ||
      data.byteLength < 42 ||
      data.byteLength > 2 * 1024 * 1024
    ) {
      this.fail('ChromiumWebCodecs decoder is not ready or packet is invalid.')
      return
    }

    const header = new DataView(data.buffer, data.byteOffset, 41)
    const epoch = header.getUint32(0)
    if (epoch !== this.config.epoch) {
      return
    }

    const sequence = header.getUint32(4)
    const timestamp = Math.round(header.getFloat64(8))
    const key = header.getUint8(16) === 1
    if (
      sequence !== this.sequence + 1 ||
      this.pending ||
      this.decoder.decodeQueueSize > 0 ||
      (!this.sequence && !key) ||
      !Number.isSafeInteger(timestamp)
    ) {
      this.fail(
        'ChromiumWebCodecs stream continuity lost. Reconnect for a new IDR; delta frames are not discarded selectively.'
      )
      return
    }

    this.bytes += data.byteLength
    this.received++
    this.receivedAt = performance.now()
    this.captured = header.getUint32(17)
    this.droppedRaw = header.getUint32(21)
    this.encodeTotalMs += header.getFloat64(25)
    this.encodeMaxMs = Math.max(this.encodeMaxMs, header.getFloat64(25))
    this.captureElapsedMs = header.getFloat64(33)
    this.sequence = sequence
    this.pending = { sequence, timestamp }
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp,
          data: data.subarray(41)
        })
      )
    } catch (error) {
      this.fail(String(error))
    }
  }

  private fail(message: string): void {
    if (this.stopped) {
      return
    }

    this.send({ type: 'webcodecsStop', message: message.slice(0, 512) })
    this.stop()
    this.failed(message)
  }

  stop(): void {
    this.stopped = true
    if (this.callback !== null) {
      this.video.cancelVideoFrameCallback(this.callback)
    }

    this.callback = null
    this.pending = null
    if (this.decoder?.state !== 'closed') {
      this.decoder?.close()
    }

    this.decoder = null
    void this.writer?.abort().catch(() => undefined)
    this.writer = null
    this.track?.stop()
    this.track = null
    this.video.srcObject = null
    this.video.removeAttribute('src')
    this.video.load() // discard the last painted frame on lease revocation
    delete this.video.dataset.webcodecs
    this.video.removeAttribute('title')
  }
}
