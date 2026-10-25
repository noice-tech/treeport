import { SOCKET_PATH, type BrowserServerMessage } from '@treeport/shared'
import type {
  BrowserMediaWheel,
  BrowserMediaWorkerCommand,
  BrowserMediaWorkerEvent
} from './browser-media-protocol'

// Full-frame Annex-B H.264, received, decoded and painted by a worker that
// owns both the canvas and the attachment's video socket.
export class ChromiumWebCodecsReceiver {
  private readonly worker: Worker
  private epoch: number | null = null
  private generation = 0
  private connected = false

  constructor(
    canvas: HTMLCanvasElement,
    private readonly presented: () => void,
    private readonly fallback: (message: BrowserMediaWheel) => void
  ) {
    this.worker = new Worker(
      new URL('./browser-media.worker.ts', import.meta.url),
      { type: 'module' }
    )
    this.worker.onmessage = ({
      data
    }: MessageEvent<BrowserMediaWorkerEvent>) => {
      if (data.type === 'media') {
        this.connected = data.connected
      } else if (data.type === 'wheel') {
        this.fallback(data.message)
      } else if (data.epoch === this.epoch) {
        this.presented()
      }
    }

    const offscreen = canvas.transferControlToOffscreen()
    this.post({ type: 'canvas', canvas: offscreen }, [offscreen])
  }

  static supported(canvas: HTMLCanvasElement): boolean {
    return Boolean(globalThis.VideoDecoder && canvas.transferControlToOffscreen)
  }

  // Each attachment authorizes its own video socket.
  connect(token: string): void {
    const url = new URL(`${SOCKET_PATH}/browser-media`, location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    this.post({ type: 'connect', url: url.href, token })
  }

  async start(
    config: Extract<BrowserServerMessage, { type: 'webcodecsReady' }>
  ): Promise<void> {
    this.stop()
    const generation = this.generation

    const support = await VideoDecoder.isConfigSupported({
      codec: config.codec,
      codedWidth: config.width,
      codedHeight: config.height,
      optimizeForLatency: true
    })

    if (generation !== this.generation) {
      return
    }

    if (!support.supported) {
      throw new Error(`This browser cannot decode ${config.codec} video.`)
    }

    this.epoch = config.epoch
    this.post({
      type: 'configure',
      config: {
        epoch: config.epoch,
        codec: config.codec,
        width: config.width,
        height: config.height
      }
    })
  }

  // Wheel input rides the media socket to the browser relay, which scrolls
  // without waiting on the daemon. Returns false when that socket is down.
  wheel(message: BrowserMediaWheel): boolean {
    if (!this.connected) {
      return false
    }

    this.post({ type: 'wheel', message })

    return true
  }

  // Discards the last painted frame on lease revocation.
  stop(): void {
    this.generation++
    this.epoch = null
    this.post({ type: 'stop' })
  }

  dispose(): void {
    this.stop()
    this.worker.terminate()
  }

  private post(
    command: BrowserMediaWorkerCommand,
    transfer: Transferable[] = []
  ): void {
    this.worker.postMessage(command, transfer)
  }
}
