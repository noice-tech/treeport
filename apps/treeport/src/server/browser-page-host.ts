import crypto from 'node:crypto'
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
import { startBrowserDisplay, type BrowserDisplay } from './browser-display'
import type { BrowserRelay } from './browser-relay-client'

interface PlaywrightBrowserLease {
  browser: Browser
  context: BrowserContext
  page: Page
  extensionId: string
  relay: BrowserRelay | null
  input: string | null
  openCapturePage(): Promise<BrowserCapturePage>
}

// EXTERNAL: Playwright opens every page as the foreground tab of a shared window.
// Chromium throttles a background tab to 1 fps once a few of its frames go
// undrawn, and capture does not count as drawing: the captured page froze for
// a second after each scroll. Each hosted page gets its own window, and the
// capture helper opens behind it.
async function createPage(
  browser: Browser,
  context: BrowserContext,
  options: { newWindow?: boolean; background?: boolean }
): Promise<Page> {
  const url = `about:blank#treeport-${crypto.randomUUID()}`
  const session = await browser.newBrowserCDPSession()

  const [page] = await Promise.all([
    context.waitForEvent('page', { predicate: (page) => page.url() === url }),
    session
      .send('Target.createTarget', { url, ...options })
      .finally(() => session.detach())
  ])

  return page
}

export class PlaywrightBrowserHost {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private readonly pages = new Set<Page>()
  private readonly lifecycle = Effect.unsafeMakeSemaphore(1)
  private pendingOpens = 0
  private closing = false
  private debuggingEndpoint: string | null = null
  private display: BrowserDisplay | null = null
  private captureExtensionId = ''
  private closeOperation: Promise<void> | null = null
  private readonly closingPages = new Map<Page, Promise<void>>()

  constructor(
    readonly profilePath: string,
    private readonly relay: BrowserRelay | null
  ) {}

  get started(): boolean {
    return this.context !== null
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
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
          // EXTERNAL: Only the private loopback CDP connection can load our extension.
          // Modern branded Chrome does not support --load-extension.
          '--enable-unsafe-extension-debugging',
          `--allowlisted-extension-id=${extension.id}`,
          '--remote-debugging-address=127.0.0.1',
          '--remote-debugging-port=0',
          // EXTERNAL: Remote debugging sets navigator.webdriver, and Google sign-in
          // rejects such browsers as insecure.
          '--disable-blink-features=AutomationControlled'
        ]

        // EXTERNAL: WSLg exposes Windows GPUs through Mesa's D3D12 OpenGL driver, not
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
          // EXTERNAL: GPU compositing synchronizes every shared image (tiles, WebGL,
          // video) across D3D12 contexts through WSL, which stalls the GPU
          // thread while pages load. WebGL stays on the GPU; compositing and
          // raster run on the CPU, which is several times faster here.
          args.push(
            '--enable-gpu',
            '--use-angle=gl',
            '--disable-gpu-compositing'
          )
        }

        const display = await startBrowserDisplay(this.profilePath)

        if (display) {
          env.DISPLAY = display.name
          delete env.WAYLAND_DISPLAY
          args.push(
            '--ozone-platform=x11',
            '--hide-scrollbars',
            // EXTERNAL: Tab capture loopback still receives audio from Chromium's
            // fake output device, but --mute-audio silences the capture too.
            '--disable-audio-output',
            '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'
          )
        }

        await fs.rm(path.join(this.profilePath, 'DevToolsActivePort'), {
          force: true
        })
        context = await chromium
          .launchPersistentContext(this.profilePath, {
            executablePath: runtime.executablePath,
            chromiumSandbox: true,
            headless: display === null,
            acceptDownloads: true,
            ignoreDefaultArgs: ['--disable-extensions'],
            args,
            env,
            // EXTERNAL: Each browser page sets its own viewport in launch(). A context
            // default also resizes the shared native window when a capture
            // helper tab opens, changing the streamed resolution on every tree
            // switch.
            viewport: null
          })
          .catch((error) => {
            display?.close()
            throw error
          })
        browser = context.browser()
        this.display = display
        browser?.once('disconnected', () => {
          display?.close()

          if (this.display === display) {
            this.display = null
          }
        })
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
          : await createPage(browser, context, { newWindow: true })

      this.pages.add(page)
      const display = this.display
      const input = display?.input ?? null

      if (display && input) {
        // EXTERNAL: Native input addresses screen pixels. A fullscreen window has no
        // toolbar, so the viewport's corner sits at the screen's origin.
        // Without a window manager, fullscreen keeps the window's size.
        const cdp = await context.newCDPSession(page)

        const { targetInfo } = await cdp
          .send('Target.getTargetInfo')
          .finally(() => cdp.detach())

        const session = await browser.newBrowserCDPSession()
        await session
          .send('Browser.getWindowForTarget', {
            targetId: targetInfo.targetId
          })
          .then(async ({ windowId }) => {
            await session.send('Browser.setWindowBounds', {
              windowId,
              bounds: {
                left: 0,
                top: 0,
                width: display.width,
                height: display.height
              }
            })
            await session.send('Browser.setWindowBounds', {
              windowId,
              bounds: { windowState: 'fullscreen' }
            })
          })
          .finally(() => session.detach())
      }

      return {
        browser,
        context,
        page,
        extensionId: this.captureExtensionId,
        relay: this.relay,
        input,
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
              page: await createPage(browser, context, { background: true }),
              targetId: targetInfo.targetId
            }
          })
      }
    }).finally(() => {
      this.pendingOpens -= 1
    })
  }

  setPageFocus(page: Page, enabled: boolean): Promise<void> {
    // EXTERNAL: Playwright's pinned in-process driver enables focus emulation on its own
    // CDP session. That owns a Chromium capturer handle which prevents freezing;
    // disabling emulation on a second CDP session cannot release that handle.
    // SAFETY: Hosted pages come from our pinned Playwright in-process Chromium
    // driver, whose Page connection maps directly to this server-side CDP client.
    const clientPage = page as Page & {
      _connection: {
        toImpl(page: Page): {
          delegate: {
            _mainFrameSession: {
              _client: {
                send(
                  method: string,
                  params: { enabled: boolean }
                ): Promise<void>
              }
            }
          }
        }
      }
    }

    return clientPage._connection
      .toImpl(page)
      .delegate._mainFrameSession._client.send(
        'Emulation.setFocusEmulationEnabled',
        { enabled }
      )
  }

  copy(page: Page): ReturnType<typeof browserClipboard> {
    return this.schedule(() =>
      browserClipboard(page, async (read) => {
        const browser = this.browser

        if (!browser || !this.pages.has(page)) {
          throw new Error('The hosted browser page is unavailable.')
        }

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

  setRefreshRate(hz: number): void {
    this.display?.setRefreshRate(hz)
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

    const result = this.schedule(async () => {
      this.pages.delete(page)
      await page.close().catch(() => undefined)
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
      this.relay?.close()
      await context?.close().catch(() => undefined)
    })

    return this.closeOperation
  }
}
