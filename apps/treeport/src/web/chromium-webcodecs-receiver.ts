import { SOCKET_PATH, type BrowserServerMessage } from '@treeport/shared'
import type {
  BrowserMediaWheel,
  BrowserMediaWorkerCommand,
  BrowserMediaWorkerEvent
} from './browser-media-protocol'

const AUDIO_UNDERRUN_SECONDS = 0.01
const AUDIO_JITTER_LEAD_SECONDS = 0.06
const AUDIO_MAX_LEAD_SECONDS = 0.25

export class ChromiumWebCodecsReceiver {
  private readonly worker: Worker
  private epoch: number | null = null
  private generation = 0
  private connected = false
  private audio: {
    context: AudioContext
    output: GainNode
    playhead: number
  } | null = null
  private muted = false

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
      } else if (data.type === 'audio') {
        this.play(data.sampleRate, data.planes)
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

  wheel(message: BrowserMediaWheel): boolean {
    if (!this.connected) {
      return false
    }

    this.post({ type: 'wheel', message })

    return true
  }

  // EXTERNAL: Browsers start an AudioContext suspended until a user gesture,
  // so input handlers call this from inside the gesture.
  resumeAudio(): void {
    const { context } = this.openAudio()

    if (context.state === 'suspended') {
      void context.resume().catch(() => undefined)
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted

    if (this.audio) {
      this.audio.output.gain.value = muted ? 0 : 1
    }
  }

  private play(sampleRate: number, planes: Float32Array<ArrayBuffer>[]): void {
    const frames = planes[0]?.length ?? 0

    if (frames === 0) {
      return
    }

    const audio = this.openAudio()

    if (audio.context.state !== 'running') {
      return
    }

    const buffer = audio.context.createBuffer(planes.length, frames, sampleRate)
    planes.forEach((plane, index) => buffer.copyToChannel(plane, index))
    const now = audio.context.currentTime

    if (
      audio.playhead < now + AUDIO_UNDERRUN_SECONDS ||
      audio.playhead > now + AUDIO_MAX_LEAD_SECONDS
    ) {
      audio.playhead = now + AUDIO_JITTER_LEAD_SECONDS
    }

    const source = audio.context.createBufferSource()
    source.buffer = buffer
    source.connect(audio.output)
    source.start(audio.playhead)
    audio.playhead += buffer.duration
  }

  private openAudio(): NonNullable<ChromiumWebCodecsReceiver['audio']> {
    if (!this.audio) {
      const context = new AudioContext({ latencyHint: 'interactive' })
      const output = context.createGain()
      output.gain.value = this.muted ? 0 : 1
      output.connect(context.destination)
      this.audio = { context, output, playhead: 0 }
    }

    return this.audio
  }

  stop(): void {
    this.generation++
    this.epoch = null
    this.post({ type: 'stop' })
  }

  dispose(): void {
    this.stop()
    this.worker.terminate()
    void this.audio?.context.close().catch(() => undefined)
    this.audio = null
  }

  private post(
    command: BrowserMediaWorkerCommand,
    transfer: Transferable[] = []
  ): void {
    this.worker.postMessage(command, transfer)
  }
}
