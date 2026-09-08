import type { BrowserContext, CDPSession, Page } from 'playwright'
import { parseBrowserCaptureMessage, type BrowserFrame } from '@treeport/shared'

// Desktop-owned pages still supply VP8 through the native desktop capture path.
export function receiveBrowserVideo(
  payload: string,
  publish: (frame: Omit<BrowserFrame, 'sequence'>) => void,
  failed: (message: string) => void
): void {
  const message = parseBrowserCaptureMessage(payload)
  if (!message || message.error || !message.frame) {
    failed(message?.error ?? 'The Browser video capture message is invalid.')
    return
  }

  const frame = message.frame
  publish({ ...frame, data: Buffer.from(frame.data, 'base64') })
}

export class PlaywrightBrowserVideo {
  private cdp: CDPSession | null = null

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly publish: (frame: Omit<BrowserFrame, 'sequence'>) => void,
    private readonly failed: (message: string) => void
  ) {}

  async start(width: number, height: number): Promise<void> {
    if (this.cdp) {
      return
    }

    const cdp = await this.context.newCDPSession(this.page)
    this.cdp = cdp
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      if (this.cdp === cdp) {
        this.publish({
          mimeType: 'image/jpeg',
          keyframe: true,
          timestamp: Math.round(performance.now() * 1000),
          width,
          height,
          data: Buffer.from(data, 'base64')
        })
      }

      void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {
        if (this.cdp === cdp) {
          void this.stop()
          this.failed('Browser capture disconnected. Reconnect to restart it.')
        }
      })
    })
    await cdp
      .send('Page.startScreencast', {
        format: 'jpeg',
        quality: 80,
        maxWidth: width,
        maxHeight: height
      })
      .catch(async (error) => {
        await this.stop()
        throw error
      })
  }

  async requestKeyframe(): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      return
    }

    // A newly joined viewer needs an image even if the page has not changed.
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 80
    })
    if (this.cdp !== cdp) {
      return
    }

    const viewport = this.page.viewportSize()!
    this.publish({
      mimeType: 'image/jpeg',
      keyframe: true,
      timestamp: Math.round(performance.now() * 1000),
      width: viewport.width,
      height: viewport.height,
      data: Buffer.from(data, 'base64')
    })
  }

  async stop(): Promise<void> {
    const cdp = this.cdp
    this.cdp = null
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => undefined)
      await cdp.detach().catch(() => undefined)
    }
  }
}
