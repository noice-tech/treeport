import fs from 'node:fs/promises'
import path from 'node:path'
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright'
import type {
  BrowserClientMessage,
  BrowserFrame,
  BrowserSessionState
} from '@treeport/shared'

export interface PlaywrightBrowserCallbacks {
  state(
    state: Omit<
      BrowserSessionState,
      'controlled' | 'hasController' | 'controller'
    >
  ): void
  frame(frame: Omit<BrowserFrame, 'sequence'>): void
  navigationError(message: string): void
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
const DEFAULT_MAX_FRAME_RATE = 15

interface BrowserScreencastFrame {
  data: string
  metadata: {
    timestamp?: number
    deviceWidth: number
    deviceHeight: number
  }
  sessionId: number
}

export class LatestBrowserFrameProducer {
  private active = false
  private pending: BrowserScreencastFrame | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastPublishedAt = 0

  constructor(
    private readonly publish: (frame: Omit<BrowserFrame, 'sequence'>) => void,
    private readonly acknowledge: (sessionId: number) => void,
    private readonly maxFrameRate = DEFAULT_MAX_FRAME_RATE
  ) {}

  start(): void {
    this.active = true
    this.lastPublishedAt = 0
  }

  receive(frame: BrowserScreencastFrame): void {
    if (!this.active) {
      this.acknowledge(frame.sessionId)
      return
    }

    if (this.pending) {
      this.acknowledge(this.pending.sessionId)
    }

    this.pending = frame

    if (this.timer) {
      return
    }

    const minimumInterval = 1_000 / this.maxFrameRate
    const delay = Math.max(
      0,
      this.lastPublishedAt + minimumInterval - Date.now()
    )
    if (delay === 0) {
      this.publishPending()
      return
    }

    this.timer = setTimeout(() => {
      this.timer = null
      this.publishPending()
    }, delay)
    this.timer.unref?.()
  }

  stop(): void {
    this.active = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.pending) {
      this.acknowledge(this.pending.sessionId)
      this.pending = null
    }
  }

  private publishPending(): void {
    const frame = this.pending
    this.pending = null
    if (!frame) {
      return
    }

    if (!this.active) {
      this.acknowledge(frame.sessionId)
      return
    }

    this.lastPublishedAt = Date.now()
    try {
      const data = Buffer.from(frame.data, 'base64')
      if (data.byteLength <= 8 * 1024 * 1024) {
        this.publish({
          mimeType: 'image/jpeg',
          timestamp: frame.metadata.timestamp
            ? frame.metadata.timestamp * 1_000
            : Date.now(),
          width: frame.metadata.deviceWidth,
          height: frame.metadata.deviceHeight,
          data
        })
      }
    } finally {
      this.acknowledge(frame.sessionId)
    }
  }
}

export class PlaywrightBrowser {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private cdp: CDPSession | null = null
  private frameProducer: LatestBrowserFrameProducer | null = null
  private screencasting = false
  private screencastTail: Promise<void> = Promise.resolve()
  private closing = false
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
    private readonly cachePath: string,
    private readonly workspacePath: string,
    private readonly title: string,
    private readonly panelId: string,
    private readonly worktreeId: string,
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

    process.env.PLAYWRIGHT_BROWSERS_PATH = this.cachePath
    const { chromium } = await import('playwright')
    const context = await chromium.launchPersistentContext(
      path.join(this.workspacePath, 'profile'),
      {
        channel: 'chromium',
        headless: true,
        acceptDownloads: false,
        viewport: this.stateValue.viewport
      }
    )
    this.context = context
    const browser = context.browser()
    if (!browser) {
      await context.close()
      throw new Error('Playwright did not expose the hosted browser process.')
    }

    this.browser = browser
    browser.once('disconnected', () => {
      if (!this.closing) {
        this.callbacks.crashed('The hosted browser process stopped.')
      }
    })

    const page = context.pages()[0] ?? (await context.newPage())
    this.page = page
    const cdp = await context.newCDPSession(page)
    this.cdp = cdp
    this.frameProducer = new LatestBrowserFrameProducer(
      (frame) => this.callbacks.frame(frame),
      (sessionId) => {
        void cdp
          .send('Page.screencastFrameAck', { sessionId })
          .catch(() => undefined)
      }
    )
    cdp.on('Page.screencastFrame', (frame) =>
      this.frameProducer?.receive(frame)
    )
    context.on('page', (candidate) => {
      if (candidate !== page) {
        this.callbacks.navigationError(
          'Popups are not supported in the Remote Browser panel.'
        )
        void candidate.close()
      }
    })
    page.on('download', (download) => {
      this.callbacks.navigationError(
        'Downloads are not supported in the Remote Browser panel.'
      )
      void download.cancel()
    })
    page.on('filechooser', () => {
      this.callbacks.navigationError(
        'File pickers are not supported in the Remote Browser panel.'
      )
    })
    page.on('close', () => {
      if (!this.closing) {
        this.callbacks.crashed('The hosted browser page closed.')
      }
    })

    page.on('request', (request) => {
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
    page.on('download', (download) => void download.cancel())
    page.on('dialog', (dialog) => void dialog.dismiss())
    page.on(
      'filechooser',
      (chooser) => void chooser.setFiles([]).catch(() => undefined)
    )
    page.once('crash', () =>
      this.callbacks.crashed('The hosted browser page crashed.')
    )
    context.on('page', (candidate) => {
      if (candidate !== page) {
        void candidate.close().catch(() => undefined)
        this.callbacks.navigationError('Pop-up windows are not supported.')
      }
    })
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
    await browser.bind(`treeport-${this.panelId}`, {
      workspaceDir: this.workspacePath,
      metadata: {
        treeportPanelId: this.panelId,
        treeportWorktreeId: this.worktreeId,
        title: this.title
      }
    })
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

  async setScreencasting(enabled: boolean): Promise<void> {
    const operation = this.screencastTail.then(async () => {
      const page = this.page
      const cdp = this.cdp
      const frameProducer = this.frameProducer
      if (
        !page ||
        page.isClosed() ||
        !cdp ||
        !frameProducer ||
        enabled === this.screencasting
      ) {
        return
      }

      this.screencasting = enabled
      if (!enabled) {
        frameProducer.stop()
        await cdp.send('Page.stopScreencast').catch(() => undefined)
        return
      }

      frameProducer.start()
      await cdp
        .send('Page.startScreencast', {
          format: 'jpeg',
          quality: 75,
          maxWidth: this.stateValue.viewport.width,
          maxHeight: this.stateValue.viewport.height,
          everyNthFrame: 1
        })
        .catch((error) => {
          this.screencasting = false
          frameProducer.stop()
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
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      return
    }

    this.closing = true
    this.frameProducer?.stop()
    await this.setScreencasting(false).catch(() => undefined)
    if (this.titleTimer) {
      clearInterval(this.titleTimer)
      this.titleTimer = null
    }

    await this.screencastTail
    await this.browser?.unbind().catch(() => undefined)
    await this.context?.close().catch(() => undefined)
    await this.browser
      ?.close({ reason: 'Treeport browser session closed' })
      .catch(() => undefined)
    this.page = null
    this.context = null
    this.cdp = null
    this.frameProducer = null
    this.browser = null
  }
}
