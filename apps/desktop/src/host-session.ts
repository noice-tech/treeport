import { createHash } from 'node:crypto'
import {
  WebContentsView,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import { checkHealth } from './backend-connection'
import {
  installBrowserWebviewPolicy,
  type BrowserWebviewPolicy
} from './browser-webview-policy'
import type { ConnectionState } from './desktop-contract'
import { DesktopRuntime } from './desktop-runtime'
import { loadRenderer } from './renderer-load'
import { isLoopbackUrl } from './renderer-url'

type HostSessionPhase =
  | 'idle'
  | 'connecting'
  | 'retrying'
  | 'loaded'
  | 'ready'
  | 'lost'
  | 'disposed'

export class HostSession {
  readonly view: WebContentsView
  readonly runtime: DesktopRuntime
  readonly browser: BrowserWebviewPolicy
  connection: ConnectionState
  private generation = 0
  private connectionFiber: Fiber.RuntimeFiber<void> | null = null
  private phase: HostSessionPhase = 'idle'
  private documentGeneration: number | null = null
  private historyInitialized = false
  private lastUrl: string

  constructor(
    readonly computer: { id: string; origin: string },
    private readonly options: {
      window: BrowserWindow
      runtime: DesktopRuntime
      preferences: Electron.WebPreferences
      isForeground(): boolean
      changed(): void
      ready(): void
      rememberHostname(hostname: string): Effect.Effect<void, unknown>
    }
  ) {
    this.runtime = new DesktopRuntime(options.runtime)
    this.view = new WebContentsView({ webPreferences: options.preferences })
    this.view.setBackgroundColor(options.window.getBackgroundColor())
    this.view.setVisible(false)
    this.connection = { status: 'connecting', computerId: computer.id }
    this.lastUrl = computer.origin
    options.window.contentView.addChildView(this.view)
    const renderer = this.view.webContents

    const storageKey = createHash('sha256')
      .update(`${computer.id}|${computer.origin}`)
      .digest('hex')

    this.browser = installBrowserWebviewPolicy({
      runtime: this.runtime,
      window: options.window,
      trustedRenderer: renderer,
      storageKey,
      computer: { loopback: isLoopbackUrl(new URL(computer.origin)) },
      isForeground: options.isForeground,
      isTrustedEvent: (event) => this.trusts(event)
    })
    Effect.runSync(
      Scope.addFinalizer(
        this.runtime.scope,
        Effect.sync(() => {
          this.transition('disposed')

          if (!options.window.isDestroyed()) {
            options.window.contentView.removeChildView(this.view)
          }

          if (!renderer.isDestroyed()) {
            renderer.close({ waitForBeforeUnload: false })
          }
        })
      )
    )
    renderer.on('did-navigate', (_event, url, status) => {
      this.documentGeneration =
        status < 400 && this.ownsUrl(url) ? this.generation : null

      if (this.ownsUrl(url)) {
        this.lastUrl = url
      }

      if (status >= 400 && !this.loading) {
        this.transition('lost')
        this.connect()
      }

      options.changed()
    })
    renderer.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && this.ownsUrl(url)) {
        this.lastUrl = url
        options.changed()
      }
    })
    renderer.on('did-finish-load', () => {
      if (
        this.documentGeneration !== this.generation ||
        !this.ownsUrl(renderer.getURL())
      ) {
        return
      }

      if (!this.historyInitialized) {
        renderer.navigationHistory.clear()
        this.historyInitialized = true
      }

      this.transition('ready')
      this.connection = {
        status: 'ready',
        computerId: computer.id,
        serverVersion:
          this.connection.status === 'ready'
            ? this.connection.serverVersion
            : null,
        url: renderer.getURL()
      }
      options.changed()
      options.ready()
    })
    renderer.on('did-fail-load', (_event, code, _description, url, main) => {
      if (main && code !== -3 && this.ownsUrl(url)) {
        this.documentGeneration = null
        this.lastUrl = url

        if (!this.loading) {
          this.transition('lost')
          this.connect()
        }
      }
    })
    renderer.on('render-process-gone', () => {
      this.documentGeneration = null
      this.transition('lost')
      this.connect(this.lastUrl)
    })
    renderer.on('page-title-updated', () => options.changed())
  }

  ownsUrl(url: string): boolean {
    return URL.canParse(url) && new URL(url).origin === this.computer.origin
  }

  trusts(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return (
      this.phase !== 'disposed' &&
      !this.runtime.isClosed &&
      event.sender === this.view.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      this.ownsUrl(event.senderFrame.url)
    )
  }

  deactivate(): void {
    this.view.setVisible(false)
    this.browser.suspendPresentation()
  }

  private get loading(): boolean {
    return this.phase === 'connecting' || this.phase === 'retrying'
  }

  private transition(phase: HostSessionPhase): void {
    if (this.phase !== 'disposed') {
      this.phase = phase
    }
  }

  connect(url?: string, options: { force: boolean } = { force: false }): void {
    if (this.phase === 'disposed' || this.runtime.isClosed) {
      return
    }

    if (
      !url &&
      !options.force &&
      (this.documentGeneration !== null || this.loading)
    ) {
      return
    }

    const requestedUrl = url && this.ownsUrl(url) ? url : this.lastUrl
    const generation = ++this.generation
    const previous = this.connectionFiber
    this.transition('connecting')
    this.view.webContents.stop()
    this.connection = { status: 'connecting', computerId: this.computer.id }
    this.options.changed()
    this.connectionFiber = this.runtime.fork(
      Effect.gen(this, function* () {
        if (previous) {
          yield* Fiber.interrupt(previous)
        }

        yield* this.browser.disposeAll()

        if (generation !== this.generation) {
          return
        }

        const loaded = yield* loadRenderer(
          this.view.webContents,
          requestedUrl,
          () => {
            if (generation !== this.generation) {
              return
            }

            const message = `The desktop app could not reach ${this.computer.origin}.`

            const unchanged =
              this.connection.status === 'unavailable' &&
              this.connection.message === message

            this.transition('retrying')

            this.connection = {
              status: 'unavailable',
              computerId: this.computer.id,
              message
            }

            if (!unchanged) {
              this.options.changed()
            }
          }
        )

        if (!loaded || generation !== this.generation) {
          return
        }

        if (this.loading) {
          this.transition('loaded')
        }

        const health = yield* checkHealth(this.computer.origin)

        if (!health || generation !== this.generation) {
          return
        }

        if (health.hostname) {
          yield* this.options
            .rememberHostname(health.hostname)
            .pipe(Effect.catchAll(() => Effect.void))
        }

        if (
          generation === this.generation &&
          this.connection.status === 'ready'
        ) {
          this.connection = {
            ...this.connection,
            serverVersion: health.version
          }
          this.options.changed()
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (generation === this.generation && this.loading) {
              this.transition('lost')
            }
          })
        )
      )
    )
  }

  dispose(): Effect.Effect<void> {
    this.transition('disposed')
    this.generation++
    this.deactivate()
    this.browser.detach()

    return this.runtime.close
  }
}

export class HostSessions {
  readonly visited = new Map<string, HostSession>()
  active: HostSession | null = null

  constructor(readonly window: BrowserWindow) {}

  sender(event: IpcMainEvent | IpcMainInvokeEvent): HostSession | null {
    for (const host of this.visited.values()) {
      if (host.trusts(event)) {
        return host
      }
    }

    return null
  }
}
