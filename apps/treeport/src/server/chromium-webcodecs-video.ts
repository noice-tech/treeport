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
  private readonly viewers = new Map<
    string,
    { generation: number; send(message: BrowserServerMessage): boolean }
  >()
  private controller: string | null = null
  private generation = 0
  private restartedAt = -Infinity
  private width = 0
  private height = 0
  private colorMatrix: 'bt709' | 'smpte170m' | null = null

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
            ready: (attachment, generation, config) => {
              const viewer = this.viewers.get(attachment)

              if (
                this.stream === stream &&
                viewer?.generation === generation &&
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

    const [, colorMatrix] = await Promise.all([
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
        // EXTERNAL: Chromium's software compositor converts captured pixels to YUV
        // with BT.601 coefficients but labels them BT.709, which shifts every
        // colour. Capture this page painted a known green once to tell which
        // matrix it used; the GPU path labels correctly and paints no hidden tab.
        const colorMatrix = ${JSON.stringify(this.colorMatrix)} ?? await (async () => {
          const style = document.createElement('style');
          style.textContent = 'html{background:#22aa77}body::after{content:"";display:block;width:2px;height:2px;animation:treeport-probe .1s infinite alternate}@keyframes treeport-probe{to{opacity:.5}}';
          document.head.append(style);
          const probe = await navigator.mediaDevices.getUserMedia({ video: { mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: await chrome.tabCapture.getMediaStreamId({
              targetTabId: (await chrome.tabs.getCurrent()).id
            }),
            maxWidth: 64, maxHeight: 64
          } } });
          const track = probe.getVideoTracks()[0];
          const { value: frame } = await Promise.race([
            new MediaStreamTrackProcessor({ track }).readable.getReader().read(),
            new Promise(resolve => setTimeout(() => resolve({ value: null }), 500))
          ]);
          track.stop();
          style.remove();
          if (!frame) return 'bt709';
          const context = new OffscreenCanvas(1, 1).getContext('2d');
          context.drawImage(frame, frame.displayWidth / 2, frame.displayHeight / 2, 1, 1, 0, 0, 1, 1);
          frame.close();
          // BT.709 decoding of BT.601 data turns green 170 into 154.
          return context.getImageData(0, 0, 1, 1).data[1] < 162 ? 'smpte170m' : 'bt709';
        })().catch(() => 'bt709');
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
            ${JSON.stringify(`ws://127.0.0.1:${stream.port}`)}, ${JSON.stringify(stream.token)},
            colorMatrix
          );
        })().catch(error => {
          stream.getTracks().forEach(track => track.stop());
          throw error;
        });
        return colorMatrix;
      })()`)
    ]).catch(async (error) => {
      await this.stop()
      throw error
    })

    this.colorMatrix = colorMatrix === 'smpte170m' ? 'smpte170m' : 'bt709'
    this.connected = this.stream === stream
    stream.control(this.controller)
  }

  viewerSource(id: string): ChromiumWebCodecsViewer {
    return {
      start: (send) => {
        if (!this.stream || !this.connected) {
          return false
        }

        const generation = ++this.generation
        this.viewers.set(id, { generation, send })
        this.stream.start(id, generation)

        return true
      }
    }
  }

  async closeViewer(id: string): Promise<void> {
    if (this.viewers.delete(id)) {
      this.stream?.closeViewer(id)
    }
  }

  control(id: string | null): void {
    this.controller = id
    this.stream?.control(id)
  }

  private async restart(
    width: number,
    height: number,
    message: string
  ): Promise<void> {
    const viewers = [...this.viewers]
    await this.stop()
    await this.start(width, height).catch((error) => {
      this.failed(message)
      throw error
    })

    for (const [id, viewer] of viewers) {
      if (!this.viewerSource(id).start(viewer.send)) {
        this.failed('Capture helper unavailable after restarting.')

        return
      }
    }
  }

  async stop(): Promise<void> {
    this.viewers.clear()
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
