import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserContext, CDPSession, Page } from 'playwright'
import {
  BROWSER_VIDEO_CAPTURE_SOURCE,
  parseBrowserCaptureMessage,
  type BrowserFrame
} from '@treeport/shared'

const EXTENSION_ID = 'amdpndecodoelfdgdngdhdcfdhocnief'
// Public key only. This fixes the bundled extension's identity across profile restarts.
const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqRkGqUAR23+Ol6bgYEqjV5yObGD96bVznt/VZsks7mSHJlg7rO2Xeo7i5JMuaiqyIwrZ/LilUI6OXu07dZcg6eodaz+YbxJ4Zo2Ha4dtyz+OKJzlKYs9EPTKqF5Ho58ykK5DyHrsHtzSpxnpEEDzmpVUQr2k9eSxnYqo08XQWUUaeKJbyZV0tV7mKWdHHxs6K63mnfZO3Ea80QnKVnjF275aAtxYWqVyeYYNbvMgPsjgtgHQdnwJXVirOUat0IC0fUbkTxBJHyO9dp67YhU7jYe/aNBVIEh+DT6Lw+Zn69bv4dcvG09fWAUC68ERkxRrLNeaDXNehqIcOLg1Nbq1mQIDAQAB'

export async function prepareBrowserVideoExtension(
  cachePath: string
): Promise<string[]> {
  const directory = path.join(cachePath, 'treeport-video-extension')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await Promise.all([
    fs.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Treeport Browser capture',
        version: '1.0',
        key: EXTENSION_KEY,
        // debugger.getTargets supplies the exact CDP target-to-tab mapping. We do
        // not attach another debugger or select tabs by URL, title, or focus.
        permissions: ['tabCapture', 'debugger'],
        background: { service_worker: 'worker.js' }
      }),
      { mode: 0o600 }
    ),
    fs.writeFile(
      path.join(directory, 'worker.js'),
      'chrome.runtime.onInstalled.addListener(() => {});',
      { mode: 0o600 }
    ),
    fs.writeFile(
      path.join(directory, 'capture.html'),
      '<!doctype html><title>Treeport Browser capture</title>',
      { mode: 0o600 }
    )
  ])
  return [
    `--disable-extensions-except=${directory}`,
    `--load-extension=${directory}`,
    // Chromium grants tabCapture only to this app-owned extension. Never use
    // global fake-UI or automatic desktop-capture permission switches.
    `--allowlisted-extension-id=${EXTENSION_ID}`
  ]
}

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
  private helper: Page | null = null
  private cdp: CDPSession | null = null

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly publish: (frame: Omit<BrowserFrame, 'sequence'>) => void,
    private readonly failed: (message: string) => void
  ) {}

  async start(width: number, height: number): Promise<void> {
    if (this.helper) {
      return
    }

    if (this.context.serviceWorkers().length === 0) {
      await this.context.waitForEvent('serviceworker', { timeout: 10_000 })
    }

    const targetSession = await this.context.newCDPSession(this.page)
    const { targetInfo } = await targetSession.send('Target.getTargetInfo')
    await targetSession.detach()
    const helper = await this.context.newPage()
    this.helper = helper
    await (async () => {
      await helper.goto(`chrome-extension://${EXTENSION_ID}/capture.html`)
      const cdp = await this.context.newCDPSession(helper)
      this.cdp = cdp
      await cdp.send('Runtime.enable')
      await cdp.send('Runtime.addBinding', { name: '__treeportVideoFrame' })
      cdp.on('Runtime.bindingCalled', ({ name, payload }) => {
        if (name !== '__treeportVideoFrame' || this.helper !== helper) {
          return
        }

        receiveBrowserVideo(payload, this.publish, this.failed)
        void cdp
          .send('Runtime.evaluate', {
            expression: 'globalThis.__treeportVideo?.acknowledge()'
          })
          .catch(() => undefined)
      })
      const expression = `(async () => {
        const target = (await chrome.debugger.getTargets()).find(target => target.id === ${JSON.stringify(targetInfo.targetId)});
        if (!target?.tabId) throw new Error('The Browser capture target is unavailable.');
        const source = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.tabId });
        globalThis.__treeportVideo = await ${BROWSER_VIDEO_CAPTURE_SOURCE}(source, ${width}, ${height}, globalThis.__treeportVideoFrame);
      })()`
      await helper.evaluate(expression)
      helper.once('crash', () => {
        if (this.helper === helper) {
          void this.stop()
          this.failed(
            'Browser video capture crashed. Select Retry to restart it.'
          )
        }
      })
      helper.once('close', () => {
        if (this.helper === helper) {
          this.helper = null
          this.cdp = null
          this.failed('Browser video capture stopped. Reconnect to restart it.')
        }
      })
    })().catch(async (error) => {
      await this.stop()
      throw error
    })
  }

  async requestKeyframe(): Promise<void> {
    await this.cdp?.send('Runtime.evaluate', {
      expression: 'globalThis.__treeportVideo?.requestKeyframe()'
    })
  }

  async stop(): Promise<void> {
    const helper = this.helper
    this.helper = null
    this.cdp = null
    // Closing the isolated document releases its track, frames, and encoder,
    // including a getUserMedia operation that has not completed yet.
    await helper?.close().catch(() => undefined)
  }
}
