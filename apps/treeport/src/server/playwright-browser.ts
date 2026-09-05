import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  Page
} from 'playwright'
import type {
  BrowserAgentCommand,
  BrowserClientMessage,
  BrowserFrame,
  BrowserSessionState
} from '@treeport/shared'

import {
  PlaywrightBrowserVideo,
  prepareBrowserVideoExtension
} from './browser-video'

export interface PlaywrightBrowserCallbacks {
  state(
    state: Omit<
      BrowserSessionState,
      'controlled' | 'hasController' | 'controller'
    >
  ): void
  frame(frame: Omit<BrowserFrame, 'sequence'>): void
  popup(url: string): void
  navigationError(message: string, source?: 'video'): void
  crashed(message: string): void
}

export interface BrowserInstallStatus {
  installed: boolean
  executablePath: string
  playwrightVersion: string
  browserRevision: string
  channel: 'chromium'
  launchReady: boolean
  launchError: string | null
}

const DEFAULT_VIEWPORT = { width: 1_280, height: 800 }

interface PlaywrightBrowserLease {
  browser: Browser
  context: BrowserContext
  page: Page
}

export class PlaywrightBrowserHost {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private readonly pages = new Set<Page>()
  private operation: Promise<void> = Promise.resolve()

  constructor(
    private readonly cachePath: string,
    readonly profilePath: string
  ) {}

  get started(): boolean {
    return this.context !== null
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  openPage(): Promise<PlaywrightBrowserLease> {
    return this.schedule(async () => {
      let context = this.context
      let browser = this.browser
      let initialPage: Page | null = null
      if (!context || !browser?.isConnected()) {
        await fs.mkdir(this.profilePath, { recursive: true, mode: 0o700 })
        await fs.chmod(this.profilePath, 0o700)
        process.env.PLAYWRIGHT_BROWSERS_PATH = this.cachePath
        const { chromium } = await import('playwright')
        context = await chromium.launchPersistentContext(this.profilePath, {
          channel: 'chromium',
          headless: true,
          acceptDownloads: false,
          viewport: DEFAULT_VIEWPORT,
          args: await prepareBrowserVideoExtension(this.cachePath)
        })
        browser = context.browser()
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
          }
        })
      }

      const page =
        initialPage && !initialPage.isClosed()
          ? initialPage
          : await context.newPage()
      this.pages.add(page)
      return { browser, context, page }
    })
  }

  closePage(page: Page): Promise<void> {
    return this.schedule(async () => {
      this.pages.delete(page)
      await page.close().catch(() => undefined)
      if (this.pages.size > 0 || !this.context) {
        return
      }

      const context = this.context
      this.context = null
      this.browser = null
      await context.close().catch(() => undefined)
    })
  }

  close(): Promise<void> {
    return this.schedule(async () => {
      const context = this.context
      this.context = null
      this.browser = null
      this.pages.clear()
      await context?.close().catch(() => undefined)
    })
  }
}

export class PlaywrightBrowser {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private cdp: CDPSession | null = null
  private video: PlaywrightBrowserVideo | null = null
  private screencasting = false
  private screencastTail: Promise<void> = Promise.resolve()
  private closing = false
  private dialogHandler: ((dialog: Dialog) => void) | null = null
  private readonly consoleMessages: string[] = []
  private readonly requests: string[] = []
  private historyRevision = 0
  private titleTimer: NodeJS.Timeout | null = null
  private stateValue: Omit<
    BrowserSessionState,
    'controlled' | 'hasController' | 'controller'
  > = {
    url: 'about:blank',
    title: '',
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
    process.env.PLAYWRIGHT_BROWSERS_PATH = cachePath
    const [{ chromium }, packageJson] = await Promise.all([
      import('playwright'),
      import('playwright/package.json', { with: { type: 'json' } })
    ])
    const executablePath = chromium.executablePath()
    const installed = await fs.access(executablePath).then(
      () => true,
      () => false
    )
    const browserRevision = executablePath
      .split(/[/\\]/u)
      .find((part) => part.startsWith('chromium-'))
    let launchReady = false
    let launchError: string | null = null
    if (installed) {
      const statusProfile = await fs.mkdtemp(
        path.join(cachePath, '.launch-status-')
      )
      const context = await chromium
        .launchPersistentContext(statusProfile, {
          channel: 'chromium',
          headless: true,
          acceptDownloads: false
        })
        .catch((error) => {
          launchError = error instanceof Error ? error.message : String(error)
          return null
        })
      if (context) {
        launchReady = true
        await context.close()
      }

      await fs.rm(statusProfile, { recursive: true, force: true })
    }

    return {
      installed,
      executablePath,
      playwrightVersion: String(packageJson.default.version),
      browserRevision: browserRevision ?? 'unknown',
      channel: 'chromium',
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

  async launch(): Promise<void> {
    if (this.browser) {
      return
    }

    const { browser, context, page } = await this.host.openPage()
    this.context = context
    this.browser = browser
    browser.once('disconnected', () => {
      if (!this.closing) {
        this.callbacks.crashed('The hosted browser process stopped.')
      }
    })

    this.page = page
    await page.setViewportSize(this.stateValue.viewport)
    const cdp = await context.newCDPSession(page)
    this.cdp = cdp
    this.video = new PlaywrightBrowserVideo(
      context,
      page,
      (frame) => this.callbacks.frame(frame),
      (message) => {
        this.screencasting = false
        void this.video?.stop()
        this.callbacks.navigationError(message, 'video')
      }
    )
    page.on('popup', (candidate) => {
      void (async () => {
        const supportedUrl = (value: string): string | null => {
          if (!URL.canParse(value)) {
            return null
          }

          const url = new URL(value)
          return url.protocol === 'http:' || url.protocol === 'https:'
            ? url.href
            : null
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
            'The popup did not supply a supported HTTP or HTTPS URL.'
          )
        }

        await candidate.close().catch(() => undefined)
      })()
    })
    page.on('download', (download) => {
      this.callbacks.navigationError('Downloads are not supported in Browser.')
      void download.cancel()
    })
    page.on('filechooser', (chooser) => {
      this.callbacks.navigationError(
        'File pickers are not supported in Browser.'
      )
      void chooser.setFiles([]).catch(() => undefined)
    })
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
    page.on('request', (request) => {
      this.requests.push(`${request.method()} ${request.url()}`)
      if (this.requests.length > 2_000) {
        this.requests.shift()
      }

      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        this.updateState({ loading: true })
      }
    })
    page.on('requestfailed', (request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        this.updateState({ loading: false })
        this.callbacks.navigationError(
          request.failure()?.errorText ?? 'Navigation failed.'
        )
      }
    })
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        void this.refreshPageState()
      }
    })
    page.on('domcontentloaded', () => void this.refreshPageState())
    page.on('load', () => {
      this.updateState({ loading: false })
      void this.refreshPageState()
    })
    this.dialogHandler = (dialog) => void dialog.dismiss()
    page.on('dialog', this.dialogHandler)
    page.once('crash', () =>
      this.callbacks.crashed('The hosted browser page crashed.')
    )
    this.cdp.on('Page.navigatedWithinDocument', () => {
      void this.refreshPageState()
    })
    await this.cdp.send('Page.enable')
    this.titleTimer = setInterval(() => {
      void page
        .title()
        .then((title) => {
          if (title !== this.stateValue.title) {
            this.updateState({ title })
          }
        })
        .catch(() => undefined)
    }, 500)
    this.titleTimer.unref()
    await this.refreshPageState()
  }

  private updateState(
    patch: Partial<
      Omit<BrowserSessionState, 'controlled' | 'hasController' | 'controller'>
    >
  ): void {
    this.stateValue = {
      ...this.stateValue,
      ...patch,
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

  async requestVideoKeyframe(): Promise<void> {
    await this.video?.requestKeyframe()
  }

  async setScreencasting(enabled: boolean): Promise<void> {
    const operation = this.screencastTail.then(async () => {
      const page = this.page
      const video = this.video
      if (
        !page ||
        page.isClosed() ||
        !video ||
        enabled === this.screencasting
      ) {
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
    })
    this.screencastTail = operation.catch(() => undefined)
    return operation
  }

  async command(message: BrowserClientMessage): Promise<void> {
    const page = this.page
    if (!page || page.isClosed()) {
      throw new Error('The hosted browser page is unavailable.')
    }

    if (message.type === 'navigate') {
      this.updateState({ loading: true })
      await page.goto(message.url, { waitUntil: 'commit' }).catch((error) => {
        this.updateState({ loading: false })
        throw error
      })
      await this.refreshPageState()
      return
    }

    if (message.type === 'back') {
      await page.goBack({ waitUntil: 'commit' })
      await this.refreshPageState()
      return
    }

    if (message.type === 'forward') {
      await page.goForward({ waitUntil: 'commit' })
      await this.refreshPageState()
      return
    }

    if (message.type === 'reload') {
      this.updateState({ loading: true })
      await page.reload({ waitUntil: 'commit' }).catch((error) => {
        this.updateState({ loading: false })
        throw error
      })
      await this.refreshPageState()
      return
    }

    if (message.type === 'stop') {
      await this.cdp?.send('Page.stopLoading')
      this.updateState({ loading: false })
      return
    }

    if (message.type === 'resize') {
      const wasScreencasting = this.screencasting
      if (wasScreencasting) {
        await this.setScreencasting(false)
      }

      await page.setViewportSize({
        width: message.width,
        height: message.height
      })
      this.updateState({
        viewport: { width: message.width, height: message.height }
      })
      if (wasScreencasting) {
        await this.setScreencasting(true)
      }

      return
    }

    if (message.type === 'pointer') {
      if (message.phase === 'move') {
        await page.mouse.move(message.x, message.y)
      } else if (message.phase === 'down') {
        await page.mouse.move(message.x, message.y)
        await page.mouse.down({ button: message.button ?? 'left' })
      } else {
        await page.mouse.move(message.x, message.y)
        await page.mouse.up({ button: message.button ?? 'left' })
      }

      return
    }

    if (message.type === 'wheel') {
      await page.mouse.wheel(message.deltaX, message.deltaY)
      return
    }

    if (message.type === 'key') {
      if (message.phase === 'down') {
        await page.keyboard.down(message.key)
      } else {
        await page.keyboard.up(message.key)
      }

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
      await page.goto(input.args[0])
      await this.refreshPageState()
      return `Navigated to ${page.url()}`
    }

    if (input.command === 'go-back') {
      await page.goBack()
      await this.refreshPageState()
      return `Navigated to ${page.url()}`
    }

    if (input.command === 'go-forward') {
      await page.goForward()
      await this.refreshPageState()
      return `Navigated to ${page.url()}`
    }

    await page.reload()
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
          () => reject(new Error('The page did not finish closing.')),
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
    await this.video?.stop()
    if (this.titleTimer) {
      clearInterval(this.titleTimer)
      this.titleTimer = null
    }

    await this.screencastTail
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
