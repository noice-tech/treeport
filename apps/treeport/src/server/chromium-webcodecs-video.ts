import type { BrowserServerMessage } from '#protocol/browser'
import type {
  BrowserRelay,
  BrowserRelayStream
} from './browser-relay-client.ts'
import type { BrowserCapturePage } from './browser-video.ts'
import { captureChromiumWebCodecs } from './chromium-webcodecs-capture.ts'

export interface ChromiumWebCodecsViewer {
  start(send: (message: BrowserServerMessage) => boolean): boolean
}

export class ChromiumWebCodecsVideo {
  private helper: BrowserCapturePage['page'] | null = null
  private stream: BrowserRelayStream | null = null
  private connected = false
  private viewer: {
    id: string
    epoch: number
    send(message: BrowserServerMessage): boolean
  } | null = null
  private epoch = 0
  private restartedAt = -Infinity
  private width = 0
  private height = 0

  private readonly openCapturePage: () => Promise<BrowserCapturePage>
  private readonly extensionId: string
  private readonly relay: BrowserRelay
  private readonly input: string | null
  private readonly debuggingEndpoint: () => string | null
  private readonly failed: (message: string) => void

  constructor(
    openCapturePage: () => Promise<BrowserCapturePage>,
    extensionId: string,
    relay: BrowserRelay,
    input: string | null,
    debuggingEndpoint: () => string | null,
    failed: (message: string) => void
  ) {
    this.openCapturePage = openCapturePage
    this.extensionId = extensionId
    this.relay = relay
    this.input = input
    this.debuggingEndpoint = debuggingEndpoint
    this.failed = failed
  }

  async start(width: number, height: number): Promise<void> {
    const captureWidth = Math.max(2, Math.round(width / 2) * 2)
    const captureHeight = Math.max(2, Math.round(height / 2) * 2)

    if (this.helper) {
      if (this.width === captureWidth && this.height === captureHeight) {
        return
      }

      await this.restart(
        width,
        height,
        'WebCodecs capture could not be resized. Reconnect to restart video.'
      )

      return
    }

    this.width = captureWidth
    this.height = captureHeight
    const { page: helper, targetId } = await this.openCapturePage()
    this.helper = helper

    const lost = () => {
      if (this.helper === helper) {
        this.helper = null
        this.failed('Browser video capture stopped. Reconnect to restart it.')
      }
    }

    helper.once('crash', lost)
    helper.once('close', lost)
    const endpoint = this.debuggingEndpoint()

    const stream = await helper
      .goto(`chrome-extension://${this.extensionId}/capture.html`)
      .then(() => {
        if (!endpoint) {
          throw new Error('The hosted browser debugger is not available.')
        }

        return this.relay.open(
          {
            extensionId: this.extensionId,
            endpoint,
            targetId,
            input: this.input
          },
          {
            ready: (config) => {
              const viewer = this.viewer

              if (
                this.stream === stream &&
                viewer?.epoch === config.epoch &&
                !viewer.send(config)
              ) {
                this.failed('Viewer metadata queue is full.')
              }
            },
            failed: (message) => {
              if (this.stream !== stream) {
                return
              }

              const now = performance.now()

              if (now - this.restartedAt < 10_000) {
                this.failed(message)

                return
              }

              this.restartedAt = now
              void this.restart(this.width, this.height, message).catch(
                () => undefined
              )
            }
          }
        )
      })
      .catch(async (error) => {
        await this.stop()
        throw error
      })

    this.stream = stream
    let timeout: ReturnType<typeof setTimeout> | null = null
    await Promise.all([
      Promise.race([
        stream.connected,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Capture helper authentication timed out.')),
            5000
          )
        })
      ]).finally(() => clearTimeout(timeout ?? undefined)),
      helper.evaluate(`(async () => {
        const target = (await chrome.debugger.getTargets()).find(
          target => target.id === ${JSON.stringify(targetId)}
        );
        if (!target?.tabId) throw new Error('The Browser capture target is unavailable.');
        const sourceId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.tabId });
        // Bound native acquisition, not just post-capture scaling. This helper
        // is recreated on resize so a larger viewport never upscales an old track.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: {
            chromeMediaSource: 'tab', chromeMediaSourceId: sourceId
          } },
          video: { mandatory: {
            chromeMediaSource: 'tab', chromeMediaSourceId: sourceId,
            maxWidth: ${captureWidth}, maxHeight: ${captureHeight}, maxFrameRate: 120
          } }
        });
        await (async () => {
          const track = stream.getVideoTracks()[0];
          await track.applyConstraints({
            width: { exact: ${captureWidth} }, height: { exact: ${captureHeight} },
            frameRate: { max: 120 }
          });
          track.contentHint = 'motion';
          globalThis.__treeportWebCodecs = await (${captureChromiumWebCodecs.toString()})(
            track, stream.getAudioTracks()[0] ?? null,
            ${JSON.stringify(`ws://127.0.0.1:${stream.port}`)}, ${JSON.stringify(stream.token)}
          );
        })().catch(error => {
          stream.getTracks().forEach(track => track.stop());
          throw error;
        });
      })()`)
    ]).catch(async (error) => {
      await this.stop()
      throw error
    })
    this.connected = this.stream === stream
  }

  viewerSource(id: string): ChromiumWebCodecsViewer {
    return {
      start: (send) => {
        if (!this.stream || !this.connected) {
          return false
        }

        this.viewer = { id, epoch: ++this.epoch, send }
        this.stream.start(id, this.epoch)

        return true
      }
    }
  }

  async closeViewer(id: string): Promise<void> {
    if (this.viewer?.id !== id) {
      return
    }

    this.viewer = null
    this.stream?.closeViewer(id)
  }

  private async restart(
    width: number,
    height: number,
    message: string
  ): Promise<void> {
    const viewer = this.viewer
    await this.stop()
    await this.start(width, height).catch((error) => {
      this.failed(message)
      throw error
    })

    if (viewer && !this.viewerSource(viewer.id).start(viewer.send)) {
      this.failed('Capture helper unavailable after restarting.')
    }
  }

  async stop(): Promise<void> {
    this.viewer = null
    this.connected = false
    this.stream?.close()
    this.stream = null
    this.width = 0
    this.height = 0
    const helper = this.helper
    this.helper = null
    await helper?.close().catch(() => undefined)
  }
}
