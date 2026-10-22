import type { BrowserServerMessage } from '@treeport/shared'
import type { ChromiumWebCodecsViewer } from './chromium-webcodecs-video'

interface BrowserVideoSource {
  webcodecs: ChromiumWebCodecsViewer | null
  negotiate: ((sdp: string) => Promise<string>) | null
  close(): Promise<void>
}

// Hosted Chromium uses WebCodecs; only Electron-owned tabs negotiate WebRTC.
// The session scheduler supplies a source after capture is ready; native ICE
// negotiation and retiring viewers never occupy that scheduler.
export class BrowserVideoViewer {
  #source: { readonly runtime: BrowserVideoSource } | null = null
  #advertised = false
  #negotiation: Promise<void> | null = null
  #retirement: Promise<void> | null = null
  #disposed = false

  constructor(
    private readonly send: (message: BrowserServerMessage) => boolean,
    // Closes the attachment's media socket, which the browser relay owns.
    private readonly release: () => void = () => undefined
  ) {}

  resume(source: BrowserVideoSource): void {
    if (this.#disposed || this.#source) {
      return
    }

    // Each activation gets its own lease, even when the backend is reused.
    this.#source = { runtime: source }
    this.prepare()
  }

  private prepare(): void {
    if (
      this.#disposed ||
      !this.#source ||
      this.#advertised ||
      this.#negotiation ||
      this.#retirement
    ) {
      return
    }

    if (this.#source.runtime.webcodecs) {
      this.#advertised = true
      if (!this.#source.runtime.webcodecs.start(this.send)) {
        this.fail('Capture helper unavailable. Reconnect to restart video.')
      }
    } else {
      this.#advertised = this.send({ type: 'videoReady' })
    }
  }

  offer(requestId: string, sdp: string): void {
    const source = this.#source
    if (
      !source ||
      source.runtime.webcodecs ||
      !source.runtime.negotiate ||
      !this.#advertised ||
      this.#negotiation ||
      this.#retirement
    ) {
      return
    }

    const negotiation = source.runtime
      .negotiate(sdp)
      .then((answer) => {
        if (this.#source === source) {
          this.send({ type: 'videoAnswer', requestId, sdp: answer })
        }
      })
      .catch((cause) => {
        if (this.#source === source) {
          this.fail(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (this.#negotiation === negotiation) {
          this.#negotiation = null
          this.prepare()
        }
      })
    this.#negotiation = negotiation
  }

  suspend(): void {
    const source = this.#source
    this.#source = null
    this.#advertised = false
    if (!source) {
      return
    }

    // Revoke immediately, then drain any in-flight negotiation before advertising
    // another source. A late answer/cleanup can never close a successor's peer.
    const close = source.runtime.close().catch(() => undefined)
    const negotiation = this.#negotiation
    const retirement = Promise.all([this.#retirement, close, negotiation])
      .then(async () => {
        if (negotiation) {
          await source.runtime.close().catch(() => undefined)
        }
      })
      .then(() => {
        if (this.#retirement === retirement) {
          this.#retirement = null
          this.prepare()
        }
      })
    this.#retirement = retirement
  }

  fail(message: string): void {
    if (this.#disposed) {
      return
    }

    this.suspend()
    this.send({ type: 'videoUnavailable', message })
  }

  dispose(): void {
    this.#disposed = true
    this.suspend()
    this.release()
  }
}
