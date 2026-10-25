import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  FileChooser,
  Page,
  Request
} from 'playwright'
import {
  browserObservedUrlSchema,
  browserUrlSchema,
  browserContextResultSchema,
  decodeUnknownOrNull,
  normalizeBrowserTitle,
  normalizeBrowserFaviconUrl,
  readBrowserPageMetadata
} from '@treeport/shared'
import type {
  BrowserAgentCommand,
  BrowserClipboard,
  BrowserClientMessage,
  BrowserContextResult,
  BrowserContextActionResult,
  BrowserRuntimeState
} from '@treeport/shared'

import { ChromiumWebCodecsVideo } from './chromium-webcodecs-video'
import { PlaywrightBrowserHost } from './browser-page-host'
import { browserRuntime } from './browser-runtime'
import { browserNavigation } from './browser-navigation'
import { browserKey, browserTouch, browserWheel } from './browser-input'
import { installBrowserClipboardBridge } from './browser-clipboard-bridge'
import { browserCursor } from './browser-cursor'

export interface PlaywrightBrowserCallbacks {
  state(state: BrowserRuntimeState): void
  clipboard(clipboard: BrowserClipboard): boolean
  fileChooser(chooser: FileChooser | null): void
  popup(url: string): void
  navigationError(message: string, source?: 'video'): void
  crashed(message: string): void
}

export interface BrowserInstallStatus {
  installed: boolean
  executablePath: string | null
  playwrightVersion: string
  browserRevision: string
  channel: 'chromium' | 'chrome'
  launchReady: boolean
  launchError: string | null
}

// CDP can resolve nodes inside closed shadow roots that composedPath hides.
// Use the owning target's session, and release the remote object on all paths.
async function readContextLink(
  cdp: CDPSession,
  backendNodeId: number
): Promise<string | null> {
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId })

  if (!object.objectId) {
    return null
  }

  try {
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      arguments: [{ objectId: object.objectId }],
      functionDeclaration: function (node: Node | null) {
        while (node) {
          if (
            node instanceof HTMLAnchorElement ||
            node instanceof HTMLAreaElement
          ) {
            return node.href || null
          }

          const root = node.getRootNode()
          node =
            node.parentNode ?? (root instanceof ShadowRoot ? root.host : null)
        }

        return null
      }.toString(),
      returnByValue: true
    })

    return decodeUnknownOrNull(
      browserContextResultSchema.fields.linkUrl,
      result.value
    )
  } finally {
    await cdp
      .send('Runtime.releaseObject', { objectId: object.objectId })
      .catch(() => undefined)
  }
}

const DEFAULT_VIEWPORT = { width: 1_280, height: 800 }

export class PlaywrightBrowser {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private cdp: CDPSession | null = null
  private video: ChromiumWebCodecsVideo | null = null
  private screencasting = false
  private frozenValue = false
  private freezingSupported = true
  private readonly pendingRequests = new Set<Request>()
  private readonly pressedInputs = new Set<string>()
  private networkActivityAt = Date.now()
  private metadataUpdate: Promise<void> | null = null
  private closing = false
  private dialogHandler: ((dialog: Dialog) => void) | null = null
  private readonly consoleMessages: string[] = []
  private readonly requests: string[] = []
  private contextMenu: {
    id: string
    linkUrl: string | null
    backendNodeId: number | null
    targetId: string | null
    createdAt: number
  } | null = null
  private historyRevision = 0
  private pointerPoint: { x: number; y: number } | null = null
  private titleTimer: NodeJS.Timeout | null = null
  private faviconSource: string | null = null
  private stateValue: BrowserRuntimeState = {
    url: 'about:blank',
    title: '',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: { ...DEFAULT_VIEWPORT }
  }

  constructor(
    private readonly host: PlaywrightBrowserHost,
    private readonly workspacePath: string,
    private readonly callbacks: PlaywrightBrowserCallbacks
  ) {}

  static async status(cachePath: string): Promise<BrowserInstallStatus> {
    const packageJson = await import('playwright/package.json', {
      with: { type: 'json' }
    })

    const runtime = await browserRuntime()
    const { executablePath, channel } = runtime
    let launchError = runtime.launchError
    const installed = executablePath !== null && launchError === null
    let browserRevision = 'unknown'
    let launchReady = false

    if (installed) {
      await fs.mkdir(cachePath, { recursive: true })

      const statusProfile = await fs.mkdtemp(
        path.join(cachePath, '.launch-status-')
      )

      const host = new PlaywrightBrowserHost(statusProfile, null)
      await host
        .openPage()
        .then((lease) => {
          browserRevision = lease.browser.version()
          launchReady = true
        })
        .catch((error) => {
          launchError = error instanceof Error ? error.message : String(error)
        })
      await host.close()
      await fs.rm(statusProfile, { recursive: true, force: true })
    }

    return {
      installed,
      executablePath,
      playwrightVersion: String(packageJson.default.version),
      browserRevision,
      channel,
      launchReady,
      launchError
    }
  }

  get state() {
    return this.stateValue
  }

  get connected(): boolean {
    return this.browser?.isConnected() ?? false
  }

  async devtoolsEndpoint(): Promise<string> {
    // An agent using another CDP connection can reposition the pointer.
    this.pointerPoint = null

    if (!this.page || this.page.isClosed() || !this.cdp) {
      throw new Error('The hosted browser page is not available.')
    }

    const endpoint = this.host.getDebuggingEndpoint()

    if (!endpoint) {
      throw new Error('The hosted browser debugger is not available.')
    }

    const { targetInfo } = await this.cdp.send('Target.getTargetInfo')

    if (!/^[a-fA-F0-9]{32}$/.test(targetInfo.targetId)) {
      throw new Error('Chrome returned an invalid page target.')
    }

    const url = new URL(endpoint)
    url.pathname = `/devtools/page/${targetInfo.targetId}`

    return url.href
  }

  async launch(): Promise<void> {
    if (this.browser) {
      return
    }

    const {
      browser,
      context,
      page,
      extensionId,
      relay,
      input,
      openCapturePage
    } = await this.host.openPage()

    this.context = context
    this.browser = browser
    browser.once('disconnected', () => {
      if (!this.closing) {
        this.callbacks.crashed('The hosted browser process stopped.')
      }
    })

    this.page = page
    this.pointerPoint = null
    await installBrowserClipboardBridge(page, (clipboard) =>
      this.callbacks.clipboard(clipboard)
    )
    await page.setViewportSize(this.stateValue.viewport)
    const cdp = await context.newCDPSession(page)
    this.cdp = cdp
    // Streamed tabs retain DOM focus even when a different hosted tab is active.
    await this.host.setPageFocus(page, true)
    // Match Treeport's dark chrome, including sites that switch favicon URLs in JS.
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }]
    })
    this.video =
      relay &&
      new ChromiumWebCodecsVideo(
        openCapturePage,
        extensionId,
        relay,
        input,
        () => this.host.getDebuggingEndpoint(),
        (message) => {
          this.screencasting = false
          void this.video?.stop()
          this.callbacks.navigationError(message, 'video')
        }
      )
    page.on('popup', (candidate) => {
      void (async () => {
        const supportedUrl = (value: string): string | null => {
          const parsed = decodeUnknownOrNull(browserUrlSchema, value)

          return parsed === null ? null : new URL(parsed).href
        }

        let popupUrl = supportedUrl(candidate.url())

        if (!popupUrl) {
          await candidate
            .waitForURL((url) => supportedUrl(url.href) !== null, {
              timeout: 5_000
            })
            .catch(() => undefined)
          popupUrl = supportedUrl(candidate.url())
        }

        if (popupUrl) {
          this.callbacks.popup(popupUrl)
        } else {
          this.callbacks.navigationError(
            'The popup did not supply a supported HTTP, HTTPS, or local file URL.'
          )
        }

        await candidate.close().catch(() => undefined)
      })()
    })
    page.on('download', (download) => {
      this.callbacks.navigationError('Downloads are not supported in Browser.')
      void download.cancel()
    })
    page.on('filechooser', (chooser) => this.callbacks.fileChooser(chooser))
    page.on('close', () => {
      if (!this.closing) {
        this.callbacks.crashed('The hosted browser page closed.')
      }
    })

    page.on('console', (message) => {
      this.consoleMessages.push(`${message.type()}: ${message.text()}`)

      if (this.consoleMessages.length > 1_000) {
        this.consoleMessages.shift()
      }
    })
    page.on('pageerror', (error) => {
      this.consoleMessages.push(`error: ${error.message}`)

      if (this.consoleMessages.length > 1_000) {
        this.consoleMessages.shift()
      }
    })
    page.on('websocket', (socket) => {
      this.networkActivityAt = Date.now()
      socket.on('framesent', () => {
        this.networkActivityAt = Date.now()
      })
      socket.on('framereceived', () => {
        this.networkActivityAt = Date.now()
      })
      socket.on('close', () => {
        this.networkActivityAt = Date.now()
      })
    })
    page.on('requestfinished', (request) => {
      this.pendingRequests.delete(request)
      this.networkActivityAt = Date.now()
    })
    page.on('request', (request) => {
      this.pendingRequests.add(request)
      this.networkActivityAt = Date.now()
      this.requests.push(`${request.method()} ${request.url()}`)

      if (this.requests.length > 2_000) {
        this.requests.shift()
      }

      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        this.contextMenu = null
        this.faviconSource = null
        this.updateState({
          url: request.url(),
          loading: true,
          faviconUrl: null
        })
      }
    })
    page.on('requestfailed', (request) => {
      this.pendingRequests.delete(request)
      this.networkActivityAt = Date.now()

      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        this.updateState({ loading: false })
        // Chromium presents failed document requests in the page itself.
        // Command failures without a visible error page are reported separately.
      }
    })
    page.on('framedetached', () => {
      this.callbacks.fileChooser(null)
      this.contextMenu = null
    })
    page.on('framenavigated', (frame) => {
      this.callbacks.fileChooser(null)
      this.contextMenu = null
      this.pointerPoint = null

      if (frame === page.mainFrame()) {
        void this.refreshPageState()
      }
    })
    page.on('domcontentloaded', () => void this.refreshPageState())
    page.on('load', () => {
      this.updateState({ loading: false })
      void this.refreshPageState()
    })
    // Keep unload protection: dismiss means stay on the current page. Dialogs
    // can disappear or the browser can disconnect while the reply is in flight.
    this.dialogHandler = (dialog) => {
      void dialog.dismiss().catch(() => undefined)
    }

    page.on('dialog', this.dialogHandler)
    page.once('crash', () =>
      this.callbacks.crashed('The hosted browser page crashed.')
    )
    this.cdp.on('Page.navigatedWithinDocument', () => {
      this.contextMenu = null
      void this.refreshPageState()
    })
    await this.cdp.send('Page.enable')
    this.titleTimer = setInterval(() => {
      // Do not enqueue renderer evaluations while frozen (or overlap slow reads).
      if (this.frozenValue || this.metadataUpdate) {
        return
      }

      this.metadataUpdate = page
        .evaluate(readBrowserPageMetadata)
        .then(async ({ title, faviconUrl }) => {
          if (normalizeBrowserTitle(title) !== this.stateValue.title) {
            this.updateState({ title })
          }

          const source = normalizeBrowserFaviconUrl(faviconUrl)

          if (source === this.faviconSource) {
            return
          }

          this.faviconSource = source
          this.updateState({ faviconUrl: null })

          if (!source) {
            return
          }

          // Hosted icons travel as data, never fetching on the viewer's network.
          let icon = source.startsWith('data:') ? source : null

          if (!icon) {
            const response = await this.context?.request
              .get(source, { timeout: 3_000 })
              .catch(() => null)

            if (response) {
              const type = response.headers()['content-type']?.split(';')[0]

              const body =
                response.ok() && type?.startsWith('image/')
                  ? await response.body().catch(() => null)
                  : null

              if (body && body.length <= 256 * 1024) {
                icon = normalizeBrowserFaviconUrl(
                  `data:${type};base64,${body.toString('base64')}`
                )
              }

              await response.dispose()
            }
          }

          if (this.faviconSource === source && !page.isClosed()) {
            this.updateState({ faviconUrl: icon })
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.metadataUpdate = null
        })
    }, 500)
    this.titleTimer.unref()
    await this.refreshPageState()
  }

  private updateState(patch: Partial<BrowserRuntimeState>): void {
    const observedUrl = patch.url ?? this.stateValue.url

    // Chromium error pages are not navigable protocol URLs. Keep the last
    // supported address (including a failed navigation's target) for recovery.
    const url =
      observedUrl === 'about:blank' ||
      decodeUnknownOrNull(browserObservedUrlSchema, observedUrl) !== null
        ? observedUrl
        : this.stateValue.url

    this.stateValue = {
      ...this.stateValue,
      ...patch,
      url,
      title: normalizeBrowserTitle(patch.title ?? this.stateValue.title),
      viewport: patch.viewport ?? this.stateValue.viewport
    }
    this.callbacks.state(this.stateValue)
  }

  private async refreshPageState(): Promise<void> {
    const page = this.page
    const cdp = this.cdp

    if (!page || !cdp || page.isClosed()) {
      return
    }

    const revision = ++this.historyRevision

    const [title, history] = await Promise.all([
      page.title().catch(() => ''),
      cdp.send('Page.getNavigationHistory').catch(() => ({
        currentIndex: 0,
        entries: [
          {
            id: 0,
            url: page.url(),
            userTypedURL: '',
            title: '',
            transitionType: 'typed' as const
          }
        ]
      }))
    ])

    if (revision !== this.historyRevision || page.isClosed()) {
      return
    }

    this.updateState({
      url: page.url(),
      title,
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1
    })
  }

  get frozen(): boolean {
    return this.frozenValue
  }

  get idle(): boolean {
    // Long-running fetches/streams and active WebSockets must not be suspended.
    return (
      this.freezingSupported &&
      !this.stateValue.loading &&
      this.pendingRequests.size === 0 &&
      this.pressedInputs.size === 0 &&
      Date.now() - this.networkActivityAt >= 30_000
    )
  }

  async setFrozen(frozen: boolean): Promise<void> {
    const cdp = this.cdp
    const page = this.page

    if (
      !cdp ||
      !page ||
      this.frozenValue === frozen ||
      (frozen && !this.idle)
    ) {
      return
    }

    if (frozen) {
      // Pause polling before draining its last read, then recheck network/load.
      this.frozenValue = true
      await this.metadataUpdate

      if (!this.idle) {
        this.frozenValue = false

        return
      }

      await this.host.setPageFocus(page, false)

      if (!this.idle) {
        await this.host.setPageFocus(page, true)
        this.frozenValue = false

        return
      }

      await cdp
        .send('Page.setWebLifecycleState', { state: 'frozen' })
        .catch(async () => {
          // Unsupported Chromium versions keep the page alive; never close it.
          this.freezingSupported = false
          this.frozenValue = false
          await this.host.setPageFocus(page, true)
        })
    } else {
      // A failed thaw must fail the operation rather than run against a frozen page.
      await cdp.send('Page.setWebLifecycleState', { state: 'active' })
      await this.host.setPageFocus(page, true)
      this.frozenValue = false
    }
  }

  async cursor(point: { x: number; y: number }) {
    return this.page ? browserCursor(this.page, point) : ('default' as const)
  }

  webcodecsViewer(viewerId: string) {
    if (!this.video) {
      throw new Error('Browser video is unavailable.')
    }

    return this.video.viewerSource(viewerId)
  }

  async closeVideoViewer(viewerId: string): Promise<void> {
    await this.video?.closeViewer(viewerId)
  }

  async setScreencasting(enabled: boolean): Promise<void> {
    // Commands, resize stop/start pairs and cleanup share the session consumer.
    const page = this.page
    const video = this.video

    if (!page || page.isClosed() || !video || enabled === this.screencasting) {
      return
    }

    this.screencasting = enabled

    if (!enabled) {
      await video.stop()

      return
    }

    await video
      .start(this.stateValue.viewport.width, this.stateValue.viewport.height)
      .catch((error) => {
        this.screencasting = false
        throw error
      })
  }

  async copy(): Promise<BrowserClipboard | null> {
    if (!this.page || this.page.isClosed()) {
      throw new Error('The hosted browser page is unavailable.')
    }

    return this.host.copy(this.page)
  }

  async command(
    message: BrowserClientMessage
  ): Promise<void | BrowserContextResult | BrowserContextActionResult> {
    const page = this.page

    if (!page || page.isClosed()) {
      throw new Error('The hosted browser page is unavailable.')
    }

    if (message.type === 'key' || message.type === 'pointer') {
      const input =
        message.type === 'key'
          ? `key:${message.key}`
          : `pointer:${message.button ?? 'left'}`

      if (message.phase === 'down') {
        this.pressedInputs.add(input)
      } else if (message.phase === 'up') {
        this.pressedInputs.delete(input)
      }
    }

    if (message.type !== 'pointer' && message.type !== 'wheel') {
      this.pointerPoint = null
    }

    if (message.type === 'dismissContext') {
      if (this.contextMenu?.id === message.contextId) {
        this.contextMenu = null
      }

      return
    }

    if (message.type === 'contextMenu') {
      const context: NonNullable<typeof this.contextMenu> = {
        id: randomUUID(),
        linkUrl: null,
        backendNodeId: null,
        targetId: null,
        createdAt: Date.now()
      }

      this.contextMenu = context

      // Observe the real Chromium event in every frame, including cross-origin
      // frames. Do not synthesize another contextmenu or suppress the site's one.
      const observers = await Promise.all(
        page.frames().map((frame) =>
          frame
            .evaluateHandle(() => {
              interface CapturedContextMenu {
                event: MouseEvent | null
                linkUrl: string | null
                listener: (event: MouseEvent) => void
              }

              const captured: CapturedContextMenu = {
                event: null,
                linkUrl: null,
                listener: (event: MouseEvent) => {
                  if (!event.isTrusted) {
                    return
                  }

                  captured.event = event

                  for (const node of event.composedPath()) {
                    if (
                      node instanceof HTMLAnchorElement ||
                      node instanceof HTMLAreaElement
                    ) {
                      captured.linkUrl = node.href || null
                      break
                    }
                  }
                }
              }

              window.addEventListener('contextmenu', captured.listener, {
                capture: true
              })

              return captured
            })
            .then((observer) => ({ frame, observer }))
            .catch(() => null)
        )
      )

      let captured: { prevented: boolean; linkUrl: string | null } | null = null

      try {
        // CDP hit testing pierces shadow roots and reports a remote backend node,
        // never a node in the viewer's streamed canvas.
        const hit = await this.cdp
          ?.send('DOM.getNodeForLocation', {
            x: Math.round(message.x),
            y: Math.round(message.y),
            includeUserAgentShadowDOM: true
          })
          .catch(() => null)

        context.backendNodeId = hit?.backendNodeId ?? null

        if (this.cdp && context.backendNodeId !== null) {
          context.linkUrl = await readContextLink(
            this.cdp,
            context.backendNodeId
          ).catch(() => null)
        }

        await page.mouse.click(message.x, message.y, { button: 'right' })

        for (const entry of observers) {
          const value = await entry?.observer
            .evaluate((observed) =>
              observed.event
                ? {
                    prevented: observed.event.defaultPrevented,
                    linkUrl: observed.linkUrl,
                    x: observed.event.clientX,
                    y: observed.event.clientY
                  }
                : null
            )
            .catch(() => null)

          if (value && entry) {
            captured = value

            if (entry.frame !== page.mainFrame()) {
              // Page-target hit testing stops at out-of-process iframes. Keep
              // that frame's target identity to route inspection in DevTools.
              const frameCdp = await this.context
                ?.newCDPSession(entry.frame)
                .catch(() => null)

              if (frameCdp) {
                try {
                  const frameHit = await frameCdp
                    .send('DOM.getNodeForLocation', {
                      x: Math.round(value.x),
                      y: Math.round(value.y),
                      includeUserAgentShadowDOM: true
                    })
                    .catch(() => null)

                  const info = await frameCdp.send('Target.getTargetInfo')
                  context.backendNodeId = frameHit?.backendNodeId ?? null
                  context.targetId = info.targetInfo.targetId

                  if (context.backendNodeId !== null) {
                    context.linkUrl = await readContextLink(
                      frameCdp,
                      context.backendNodeId
                    ).catch(() => null)
                  }
                } finally {
                  await frameCdp.detach().catch(() => undefined)
                }
              }
            }
          }
        }
      } finally {
        await Promise.all(
          observers.map(async (entry) => {
            await entry?.observer
              .evaluate((observed) => {
                window.removeEventListener('contextmenu', observed.listener, {
                  capture: true
                })
              })
              .catch(() => undefined)
            await entry?.observer.dispose().catch(() => undefined)
          })
        )
      }

      if (!captured || captured.prevented || this.contextMenu !== context) {
        this.contextMenu = null

        return {
          type: 'contextResult',
          requestId: message.requestId,
          contextId: null,
          linkUrl: null,
          canOpenLink: false,
          canInspect: false
        }
      }

      context.linkUrl = decodeUnknownOrNull(
        browserContextResultSchema.fields.linkUrl,
        captured.linkUrl ?? context.linkUrl
      )

      return {
        type: 'contextResult',
        requestId: message.requestId,
        contextId: context.id,
        linkUrl: context.linkUrl,
        canOpenLink:
          decodeUnknownOrNull(browserUrlSchema, context.linkUrl) !== null,
        canInspect: context.backendNodeId !== null
      }
    }

    if (message.type === 'contextAction') {
      const context = this.contextMenu
      this.contextMenu = null

      if (
        !context ||
        context.id !== message.contextId ||
        Date.now() - context.createdAt > 30_000
      ) {
        throw new Error(
          'The browser context menu is stale. Right-click the page again.'
        )
      }

      if (message.action === 'openLink') {
        const url = decodeUnknownOrNull(browserUrlSchema, context.linkUrl)

        if (!url) {
          throw new Error('This link cannot be opened in Browser.')
        }

        this.callbacks.popup(url)
      } else if (
        message.action !== 'copyLink' &&
        message.action !== 'inspect'
      ) {
        await this.command({ type: message.action })
      }

      return {
        type: 'contextActionResult',
        requestId: message.requestId,
        action: message.action,
        linkUrl: message.action === 'copyLink' ? context.linkUrl : null,
        backendNodeId:
          message.action === 'inspect' ? context.backendNodeId : null,
        targetId: message.action === 'inspect' ? context.targetId : null
      }
    }

    // Other input invalidates a previously resolved location/link.
    if (message.type !== 'videoOffer') {
      this.contextMenu = null
    }

    // Commit and publish the address before releasing the input barrier.
    // Renderer-dependent title/history reads must not hold subsequent input;
    // refreshPageState's revision guard retires stale background results.
    if (message.type === 'navigate') {
      this.updateState({ loading: true })
      await browserNavigation(
        page,
        () => page.goto(message.url, { waitUntil: 'commit' }),
        null,
        'page'
      ).catch((error) => {
        this.updateState({ loading: false })
        throw error
      })
      this.updateState({ url: page.url() })
      void this.refreshPageState()

      return
    }

    if (message.type === 'back') {
      await browserNavigation(
        page,
        () => page.goBack({ waitUntil: 'commit' }),
        null,
        'page'
      )
      this.updateState({ url: page.url() })
      void this.refreshPageState()

      return
    }

    if (message.type === 'forward') {
      await browserNavigation(
        page,
        () => page.goForward({ waitUntil: 'commit' }),
        null,
        'page'
      )
      this.updateState({ url: page.url() })
      void this.refreshPageState()

      return
    }

    if (message.type === 'reload') {
      this.updateState({ loading: true })
      await browserNavigation(
        page,
        () => page.reload({ waitUntil: 'commit' }),
        null,
        'page'
      ).catch((error) => {
        this.updateState({ loading: false })
        throw error
      })
      this.updateState({ url: page.url() })
      void this.refreshPageState()

      return
    }

    if (message.type === 'stop') {
      await this.cdp?.send('Page.stopLoading')
      this.updateState({ loading: false })

      return
    }

    if (message.type === 'resize') {
      if (
        this.state.viewport.width === message.width &&
        this.state.viewport.height === message.height
      ) {
        return
      }

      await page.setViewportSize({
        width: message.width,
        height: message.height
      })
      this.updateState({
        viewport: { width: message.width, height: message.height }
      })

      if (this.screencasting) {
        await this.video?.start(message.width, message.height)
      }

      return
    }

    if (message.type === 'pointer') {
      const { cssVisualViewport } = await this.cdp!.send(
        'Page.getLayoutMetrics'
      )

      const x = message.x / cssVisualViewport.scale
      const y = message.y / cssVisualViewport.scale

      // A button event at the already-positioned pointer does not need a
      // second move/compositor ACK. Explicit moves still deliver hover/drag.
      if (
        message.phase === 'move' ||
        this.pointerPoint?.x !== x ||
        this.pointerPoint?.y !== y
      ) {
        this.pointerPoint = { x, y }
        await page.mouse.move(x, y).catch((error) => {
          this.pointerPoint = null
          throw error
        })
      }

      if (message.phase === 'down') {
        await page.mouse.down({
          button: message.button ?? 'left',
          clickCount: message.clickCount ?? 1
        })
      } else if (message.phase === 'up') {
        await page.mouse.up({
          button: message.button ?? 'left',
          clickCount: message.clickCount ?? 1
        })
      }

      return
    }

    if (message.type === 'touch') {
      await browserTouch(this.cdp!, message)

      return
    }

    if (message.type === 'wheel') {
      await browserWheel(this.cdp!, message)

      return
    }

    if (message.type === 'key') {
      await browserKey(page, message)

      return
    }

    if (message.type === 'insertText') {
      await page.keyboard.insertText(message.text)

      return
    }

    if (message.type === 'find') {
      await page.evaluate(({ text, forward, findNext }) => {
        if (!findNext) {
          window.getSelection()?.removeAllRanges()
        }

        // @ts-expect-error -- Chromium supplies the nonstandard window.find API.
        window.find(text, false, !forward, true, false, true, false)
      }, message)

      return
    }

    if (message.type === 'stopFind') {
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
    }
  }

  async agentCommand(input: BrowserAgentCommand): Promise<string> {
    this.pointerPoint = null
    const page = this.page

    if (!page || page.isClosed()) {
      throw new Error('The hosted browser page is unavailable.')
    }

    const target = (value: string) => page.locator(`aria-ref=${value}`)

    if (input.command === 'snapshot') {
      // eslint-disable-next-line anti-slop/no-reflect-apply -- Playwright exposes CLI element references through this internal snapshot option.
      return Reflect.apply(page.ariaSnapshot, page, [{ mode: 'ai' }])
    }

    if (input.command === 'click') {
      await target(input.args[0]).click()

      return `Clicked ${input.args[0]}`
    }

    if (input.command === 'fill') {
      await target(input.args[0]).fill(input.args[1])

      return `Filled ${input.args[0]}`
    }

    if (input.command === 'press') {
      await page.keyboard.press(input.args[0])

      return `Pressed ${input.args[0]}`
    }

    if (input.command === 'console') {
      const minimum = input.args[0] ?? 'info'
      const levels = ['debug', 'info', 'warning', 'error']
      const minimumIndex = Math.max(0, levels.indexOf(minimum))

      return (
        this.consoleMessages
          .filter((line) => {
            const level = line.slice(0, line.indexOf(':'))
            const index = levels.indexOf(level)

            return index < 0 || index >= minimumIndex
          })
          .join('\n') || 'No console messages.'
      )
    }

    if (input.command === 'requests') {
      return this.requests.join('\n') || 'No network requests.'
    }

    if (input.command === 'screenshot') {
      const screenshotPath = path.join(
        this.workspacePath,
        `screenshot-${Date.now()}.png`
      )

      await page.screenshot({ path: screenshotPath })

      return `Screenshot saved to ${screenshotPath}`
    }

    if (input.command === 'goto') {
      await browserNavigation(page, () => page.goto(input.args[0]))
      await this.refreshPageState()

      return `Navigated to ${page.url()}`
    }

    if (input.command === 'go-back') {
      await browserNavigation(page, () => page.goBack())
      await this.refreshPageState()

      return `Navigated to ${page.url()}`
    }

    if (input.command === 'go-forward') {
      await browserNavigation(page, () => page.goForward())
      await this.refreshPageState()

      return `Navigated to ${page.url()}`
    }

    await browserNavigation(page, () => page.reload())
    await this.refreshPageState()

    return `Reloaded ${page.url()}`
  }

  async requestClose(force: boolean): Promise<boolean> {
    const page = this.page

    if (!page || page.isClosed()) {
      return true
    }

    const previousClosing = this.closing
    this.closing = true

    if (this.dialogHandler) {
      page.off('dialog', this.dialogHandler)
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    let closeHandler: (() => void) | null = null
    let dialogHandler: ((dialog: Dialog) => void) | null = null

    try {
      return await new Promise<boolean>((resolve, reject) => {
        closeHandler = () => resolve(true)
        dialogHandler = (dialog) => {
          if (dialog.type() !== 'beforeunload') {
            void dialog.dismiss().catch(reject)

            return
          }

          if (force) {
            void dialog.accept().catch(reject)
          } else {
            void dialog.dismiss().then(() => resolve(false), reject)
          }
        }

        page.once('close', closeHandler)
        page.on('dialog', dialogHandler)
        timer = setTimeout(
          // runBeforeUnload does not cancel on timeout. Keep the session
          // occupied until close or dismissal, rather than race fresh commands
          // against a close that Chromium may still complete later.
          () =>
            this.callbacks.navigationError(
              'The page has not finished closing. Browser commands are waiting for it to close or dismiss its beforeunload dialog.'
            ),
          5_000
        )
        timer.unref()
        void page.close({ runBeforeUnload: true }).catch(reject)
      })
    } finally {
      if (timer) {
        clearTimeout(timer)
      }

      if (closeHandler) {
        page.off('close', closeHandler)
      }

      if (dialogHandler) {
        page.off('dialog', dialogHandler)
      }

      if (!page.isClosed() && this.dialogHandler) {
        page.on('dialog', this.dialogHandler)
      }

      this.closing = previousClosing
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      return
    }

    this.closing = true
    await this.setScreencasting(false).catch(() => undefined)
    await this.video?.stop().catch(() => undefined)

    if (this.titleTimer) {
      clearInterval(this.titleTimer)
      this.titleTimer = null
    }

    const page = this.page

    if (page) {
      await this.host.closePage(page)
    }

    this.page = null
    this.context = null
    this.cdp = null
    this.video = null
    this.browser = null
  }
}
