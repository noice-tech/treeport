import fs from 'node:fs/promises'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import type { Browser, BrowserContext, Page } from 'playwright'
import {
  prepareBrowserVideoExtension,
  type BrowserCapturePage
} from './browser-video'
import { browserRuntime } from './browser-runtime'
import { browserClipboard } from './browser-clipboard'

interface PlaywrightBrowserLease {
  browser: Browser
  context: BrowserContext
  page: Page
  extensionId: string
  openCapturePage(): Promise<BrowserCapturePage>
}

export class PlaywrightBrowserHost {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private readonly pages = new Set<Page>()
  private readonly lifecycle = Effect.unsafeMakeSemaphore(1)
  private pendingOpens = 0
  private closing = false
  private debuggingEndpoint: string | null = null
  private captureExtensionId = ''
  private closeOperation: Promise<void> | null = null
  private readonly closingPages = new Map<Page, Promise<void>>()

  constructor(readonly profilePath: string) {}

  get started(): boolean {
    return this.context !== null
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    // A permit is held until the underlying Playwright promise settles, even
    // if the caller goes away. Interruption cannot cancel Chromium operations.
    return Effect.runPromise(
      this.lifecycle
        .withPermits(1)(
          Effect.tryPromise({ try: operation, catch: (cause) => cause })
        )
        .pipe(Effect.uninterruptible)
    )
  }

  openPage(): Promise<PlaywrightBrowserLease> {
    if (this.closing || this.pendingOpens >= 64) {
      return Promise.reject(
        new Error(
          this.closing
            ? 'The hosted browser is closing.'
            : 'Too many hosted browser pages are opening. Wait and try again.'
        )
      )
    }

    this.pendingOpens += 1
    return this.schedule(async () => {
      let context = this.context
      let browser = this.browser
      let initialPage: Page | null = null
      if (!context || !browser?.isConnected()) {
        await fs.mkdir(this.profilePath, { recursive: true, mode: 0o700 })
        await fs.chmod(this.profilePath, 0o700)
        const { chromium } = await import('playwright')
        const runtime = await browserRuntime()
        if (runtime.launchError || !runtime.executablePath) {
          throw new Error(
            runtime.launchError ?? 'Browser executable is unavailable.'
          )
        }

        const extension = await prepareBrowserVideoExtension(
          path.join(this.profilePath, 'treeport-capture-extension')
        )
        const env = { ...process.env }
        const args = [
          // Only the private loopback CDP connection can load our extension.
          // Modern branded Chrome does not support --load-extension.
          '--enable-unsafe-extension-debugging',
          `--allowlisted-extension-id=${extension.id}`,
          '--remote-debugging-address=127.0.0.1',
          '--remote-debugging-port=0',
          // Tab capture is even-sized, but WebRTC adaptation can halve 1614
          // pixels to 807 and force H.264 into software. Align adapted frames
          // too, without changing the CSS viewport or copying pixels in JS.
          '--force-fieldtrials=WebRTC-SimulcastEncoderAdapter-GetEncoderInfoOverride/requested_resolution_alignment:2/'
        ]
        // WSLg exposes Windows GPUs through Mesa's D3D12 OpenGL driver, not
        // native Linux Vulkan. Daemons often lack DISPLAY, and headless Chrome
        // otherwise forces SwiftShader. Scope these defaults to the child and
        // respect explicitly selected displays or software rendering.
        if (
          process.platform === 'linux' &&
          (!env.DISPLAY || env.DISPLAY === ':0' || env.DISPLAY === ':0.0') &&
          (!env.GALLIUM_DRIVER || env.GALLIUM_DRIVER === 'd3d12') &&
          !env.LIBGL_ALWAYS_SOFTWARE &&
          (await fs.stat('/mnt/wslg/.X11-unix/X0').then(
            (stat) => stat.isSocket(),
            () => false
          )) &&
          (await fs
            .access('/dev/dxg', fs.constants.R_OK | fs.constants.W_OK)
            .then(
              () => true,
              () => false
            ))
        ) {
          env.DISPLAY ||= ':0'
          env.GALLIUM_DRIVER ||= 'd3d12'
          args.push('--enable-gpu', '--use-angle=gl')
        }

        await fs.rm(path.join(this.profilePath, 'DevToolsActivePort'), {
          force: true
        })
        context = await chromium.launchPersistentContext(this.profilePath, {
          executablePath: runtime.executablePath,
          chromiumSandbox: true,
          headless: true,
          acceptDownloads: false,
          ignoreDefaultArgs: ['--disable-extensions'],
          args,
          env,
          // Each browser page sets its own viewport in launch(). A context
          // default also resizes the shared native window when a capture helper
          // tab opens, changing the streamed resolution on every tree switch.
          viewport: null
        })
        browser = context.browser()
        const extensionSession = await browser!.newBrowserCDPSession()
        await extensionSession
          .send('Extensions.loadUnpacked', { path: extension.directory })
          .catch(async () => {
            await context!.close()
            throw new Error(
              'Native Browser video requires Chrome/Chromium with CDP Extensions.loadUnpacked support. Update the host browser and retry.'
            )
          })
        await extensionSession.detach()
        this.captureExtensionId = extension.id
        const activePort = await fs.readFile(
          path.join(this.profilePath, 'DevToolsActivePort'),
          'utf8'
        )
        const [port, endpoint] = activePort.trim().split('\n')
        if (
          !port ||
          !/^\d+$/.test(port) ||
          Number(port) < 1 ||
          Number(port) > 65535 ||
          !endpoint ||
          !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint)
        ) {
          await context.close()
          throw new Error('Chrome did not expose a private debugging endpoint.')
        }

        this.debuggingEndpoint = `ws://127.0.0.1:${port}${endpoint}`

        if (!browser) {
          await context.close()
          throw new Error(
            'Playwright did not expose the hosted browser process.'
          )
        }

        this.context = context
        this.browser = browser
        initialPage = context.pages()[0] ?? null
        browser.once('disconnected', () => {
          if (this.browser === browser) {
            this.browser = null
            this.context = null
            this.pages.clear()
            this.debuggingEndpoint = null
          }
        })
      }

      const page =
        initialPage && !initialPage.isClosed()
          ? initialPage
          : await context.newPage()
      this.pages.add(page)
      return {
        browser,
        context,
        page,
        extensionId: this.captureExtensionId,
        openCapturePage: () =>
          this.schedule(async () => {
            if (
              this.closing ||
              this.context !== context ||
              !this.pages.has(page)
            ) {
              throw new Error('The hosted browser page is unavailable.')
            }

            const cdp = await context.newCDPSession(page)
            const { targetInfo } = await cdp
              .send('Target.getTargetInfo')
              .finally(() => cdp.detach())
            return {
              page: await context.newPage(),
              targetId: targetInfo.targetId
            }
          })
      }
    }).finally(() => {
      this.pendingOpens -= 1
    })
  }

  copy(page: Page): ReturnType<typeof browserClipboard> {
    return this.schedule(() =>
      browserClipboard(page, async (read) => {
        const browser = this.browser
        if (!browser || !this.pages.has(page)) {
          throw new Error('The hosted browser page is unavailable.')
        }

        // Clipboard reads need a script-free context, never the user's tab.
        const context = await browser.newContext({ viewport: null })
        try {
          const reader = await context.newPage()
          return await read({
            page: reader,
            cdp: await context.newCDPSession(reader)
          })
        } finally {
          await context.close().catch(() => undefined)
        }
      })
    )
  }

  getDebuggingEndpoint(): string | null {
    return this.browser?.isConnected() ? this.debuggingEndpoint : null
  }

  closePage(page: Page): Promise<void> {
    const pending = this.closingPages.get(page)
    if (pending) {
      return pending
    }

    if (!this.pages.has(page)) {
      return Promise.resolve()
    }

    // Release work is admitted once per owned lease, never once per request.
    const result = this.schedule(async () => {
      this.pages.delete(page)
      await page.close().catch(() => undefined)
      // Shared login sessions outlive individual tabs and viewer connections.
    }).finally(() => {
      this.closingPages.delete(page)
    })
    this.closingPages.set(page, result)
    return result
  }

  close(): Promise<void> {
    if (this.closeOperation) {
      return this.closeOperation
    }

    this.closing = true
    this.closeOperation = this.schedule(async () => {
      const context = this.context
      this.context = null
      this.browser = null
      this.pages.clear()
      this.debuggingEndpoint = null
      await context?.close().catch(() => undefined)
    })
    return this.closeOperation
  }
}
