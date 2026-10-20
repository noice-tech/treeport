import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import {
  BROWSER_VIDEO_CAPTURE_SOURCE,
  DEFAULT_BROWSER_VIDEO_SETTINGS,
  type BrowserVideoSettings
} from '@treeport/shared/browser-host'

export async function prepareBrowserVideoExtension(directory: string) {
  // A fresh public identity scopes unattended capture to this host's extension.
  // No signing key is retained, and websites cannot invoke this extension.
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  })
  const key = publicKey.export({ format: 'der', type: 'spki' })
  const id = crypto
    .createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (value) =>
      String.fromCharCode(97 + Number.parseInt(value, 16))
    )
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await Promise.all([
    fs.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Treeport Browser capture',
        version: '1.0',
        key: key.toString('base64'),
        // getTargets maps the exact CDP target to its tab. No debugger attaches
        // and no page is selected by URL, title, focus, or screen position.
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
  return { id, directory }
}

export interface BrowserCapturePage {
  readonly page: Pick<
    Page,
    'goto' | 'evaluate' | 'exposeFunction' | 'once' | 'close'
  >
  readonly targetId: string
}

export class PlaywrightBrowserVideo {
  private helper: BrowserCapturePage['page'] | null = null
  private settings = DEFAULT_BROWSER_VIDEO_SETTINGS

  constructor(
    private readonly openCapturePage: () => Promise<BrowserCapturePage>,
    private readonly extensionId: string,
    private readonly failed: (message: string) => void
  ) {}

  async start(
    width: number,
    height: number,
    settings: BrowserVideoSettings = this.settings
  ): Promise<void> {
    if (this.helper) {
      await this.helper
        .evaluate(
          `globalThis.__treeportVideo.resize(${width}, ${height}, ${JSON.stringify(settings)})`
        )
        .catch(async (error) => {
          await this.stop()
          this.failed(
            'Browser video capture could not be resized. Reconnect to restart it.'
          )
          throw error
        })
      this.settings = settings
      return
    }

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
    await (async () => {
      await helper.goto(`chrome-extension://${this.extensionId}/capture.html`)
      await helper.exposeFunction('__treeportVideoError', (message: string) => {
        if (this.helper === helper) {
          this.failed(message)
        }
      })
      await helper.evaluate(`(async () => {
        const target = (await chrome.debugger.getTargets()).find(
          target => target.id === ${JSON.stringify(targetId)}
        );
        if (!target?.tabId) throw new Error('The Browser capture target is unavailable.');
        const source = () => chrome.tabCapture.getMediaStreamId({ targetTabId: target.tabId });
        globalThis.__treeportVideo = await ${BROWSER_VIDEO_CAPTURE_SOURCE}(source, ${width}, ${height}, globalThis.__treeportVideoError, ${JSON.stringify(settings)});
      })()`)
    })().catch(async (error) => {
      await this.stop()
      throw error
    })
    this.settings = settings
  }

  async negotiate(peerId: string, sdp: string): Promise<string> {
    const helper = this.helper
    if (!helper) {
      throw new Error('Browser video capture is unavailable.')
    }

    return helper.evaluate(
      `globalThis.__treeportVideo.negotiate(${JSON.stringify(peerId)}, ${JSON.stringify(sdp)})`
    )
  }

  async closePeer(peerId: string): Promise<void> {
    await this.helper?.evaluate(
      `globalThis.__treeportVideo?.closePeer(${JSON.stringify(peerId)})`
    )
  }

  async stop(): Promise<void> {
    const helper = this.helper
    this.helper = null
    await helper?.close().catch(() => undefined)
  }
}
