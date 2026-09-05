import type { BrowserClientMessage, BrowserFrame } from '@treeport/shared'

export class BrowserVideoDecoder {
  private decoder: VideoDecoder | null = null
  private readonly pending = new Map<number, number>()
  private lastSequence = 0
  private disposed = false
  private failures = 0

  constructor(
    private readonly draw: (frame: VideoFrame) => void,
    private readonly send: (message: BrowserClientMessage) => void,
    private readonly failed: (message: string, fatal: boolean) => void
  ) {}

  private reset(): void {
    if (this.decoder?.state !== 'closed') {
      this.decoder?.close()
    }

    this.decoder = null
    for (const sequence of this.pending.values()) {
      this.send({ type: 'frameAck', sequence })
    }
    this.pending.clear()
  }

  private recover(error: Error): void {
    this.reset()
    if (error.name === 'NotSupportedError' || ++this.failures >= 3) {
      this.send({ type: 'setVisible', visible: false })
      this.failed(
        'Browser video could not be decoded. Retry or use a browser with WebCodecs VP8 support.',
        true
      )
      this.disposed = true
      return
    }

    this.failed('Browser video was interrupted. Reconnecting…', false)
    this.send({ type: 'requestVideoKeyframe' })
  }

  receive(frame: BrowserFrame): void {
    if (this.disposed) {
      return
    }

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- WebCodecs availability is a browser capability, not a protocol shape check.
    if (typeof VideoDecoder === 'undefined') {
      this.send({ type: 'frameAck', sequence: frame.sequence })
      this.recover(
        new DOMException('WebCodecs is unavailable.', 'NotSupportedError')
      )
      return
    }

    try {
      if (frame.keyframe) {
        this.reset()
        const decoder = new VideoDecoder({
          output: (decoded) => {
            const sequence = this.pending.get(decoded.timestamp)
            this.pending.delete(decoded.timestamp)
            try {
              if (
                !this.disposed &&
                this.decoder === decoder &&
                sequence !== undefined
              ) {
                this.failures = 0
                this.draw(decoded)
              }
            } finally {
              decoded.close()
              if (sequence !== undefined) {
                this.send({ type: 'frameAck', sequence })
              }
            }
          },
          error: (error) => {
            if (this.decoder === decoder && !this.disposed) {
              this.recover(error)
            }
          }
        })
        this.decoder = decoder
        this.decoder.configure({
          codec: 'vp8',
          codedWidth: frame.width,
          codedHeight: frame.height,
          optimizeForLatency: true
        })
      } else if (frame.sequence !== this.lastSequence + 1) {
        this.reset()
      }

      this.lastSequence = frame.sequence
      if (!this.decoder || this.decoder.decodeQueueSize >= 4) {
        this.reset()
        this.send({ type: 'frameAck', sequence: frame.sequence })
        this.send({ type: 'requestVideoKeyframe' })
        return
      }

      this.pending.set(frame.timestamp, frame.sequence)
      this.decoder.decode(
        new EncodedVideoChunk({
          type: frame.keyframe ? 'key' : 'delta',
          timestamp: frame.timestamp,
          data: frame.data
        })
      )
    } catch (error) {
      // WebCodecs can reject configuration or malformed chunks synchronously.
      this.send({ type: 'frameAck', sequence: frame.sequence })
      this.recover(error instanceof Error ? error : new Error(String(error)))
    }
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }
}
