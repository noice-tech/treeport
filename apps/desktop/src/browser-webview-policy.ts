import {
  browserPanelIdSchema,
  browserUrlSchema,
  decodeUnknownOrNull
} from '@treeport/shared'
import {
  clipboard,
  Menu,
  session,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type PopupOptions,
  type WebContents
} from 'electron'
import {
  createBrowserCdpBridge,
  type BrowserCdpBridge
} from './browser-cdp-bridge'
import type {
  DesktopBrowserBridgeDescriptor,
  DesktopBrowserCommandResult,
  DesktopBrowserToolbarCommand,
  DesktopCommand
} from './desktop-contract'

import { permitsBrowserVideoCapture } from './browser-video'
import * as Effect from 'effect/Effect'
import * as Scope from 'effect/Scope'
import { DesktopRuntime } from './desktop-runtime'

const BROWSER_PARTITION = 'persist:treeport-browser'

function browserBootstrapPanelId(value: string): string | null {
  if (!value.startsWith('about:blank#')) {
    return null
  }

  return new URLSearchParams(value.slice('about:blank#'.length)).get(
    'treeport-panel'
  )
}

interface BrowserEntry {
  panelId: string | null
  guest: WebContents
  bridge: BrowserCdpBridge | null
  inputLocked: boolean
  runtime: DesktopRuntime
  registrations: Effect.Semaphore
}

export interface BrowserWebviewPolicy {
  register(
    event: IpcMainInvokeEvent,
    panelId: string,
    webContentsId: number,
    challenge: string
  ): Effect.Effect<DesktopBrowserBridgeDescriptor | null, unknown>
  command(
    event: IpcMainInvokeEvent,
    panelId: string,
    command: DesktopBrowserToolbarCommand
  ): Effect.Effect<DesktopBrowserCommandResult>
  setInputControl(
    event: IpcMainInvokeEvent,
    panelId: string,
    locked: boolean
  ): Effect.Effect<boolean>
  requestClose(
    event: IpcMainInvokeEvent,
    panelId: string,
    force: boolean
  ): Effect.Effect<boolean>
  dispose(event: IpcMainEvent, panelId: string): Effect.Effect<void>
  disposeAll(): Effect.Effect<void>
}

export function installBrowserWebviewPolicy(options: {
  runtime: DesktopRuntime
  window: BrowserWindow
  trustedRenderer: WebContents
  selectedComputer(): { loopback: boolean } | null
  isTrustedEvent(event: IpcMainEvent | IpcMainInvokeEvent): boolean
}): BrowserWebviewPolicy {
  const entries = new Map<string, BrowserEntry>()
  const pendingGuests = new Map<number, BrowserEntry>()

  const disposeEntry = (entry: BrowserEntry) =>
    Effect.gen(function* () {
      if (entry.panelId && entries.get(entry.panelId) === entry) {
        entries.delete(entry.panelId)
      }

      pendingGuests.delete(entry.guest.id)

      yield* entry.runtime.close
    })

  options.trustedRenderer.on(
    'will-attach-webview',
    (event, webPreferences, params) => {
      const computer = options.selectedComputer()
      const partition = params.partition ?? webPreferences.partition ?? ''
      const panelId = browserBootstrapPanelId(params.src ?? '') ?? ''
      if (
        !computer?.loopback ||
        partition !== BROWSER_PARTITION ||
        !decodeUnknownOrNull(browserPanelIdSchema, panelId) ||
        entries.has(panelId)
      ) {
        event.preventDefault()
        options.trustedRenderer.send('native-browser:unavailable', {
          panelId,
          message:
            'The desktop app rejected this Browser. Select Retry to reopen it.'
        })
        return
      }

      delete webPreferences.preload
      webPreferences.partition = partition
      webPreferences.nodeIntegration = false
      webPreferences.nodeIntegrationInSubFrames = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webSecurity = true
      webPreferences.allowRunningInsecureContent = false
      webPreferences.experimentalFeatures = false
      webPreferences.enableBlinkFeatures = ''
    }
  )

  options.trustedRenderer.on('did-attach-webview', (_event, guest) => {
    const computer = options.selectedComputer()
    if (
      !computer?.loopback ||
      guest.hostWebContents !== options.trustedRenderer ||
      guest.session !== session.fromPartition(BROWSER_PARTITION)
    ) {
      guest.close({ waitForBeforeUnload: false })
      return
    }

    const entry: BrowserEntry = {
      panelId: null,
      guest,
      bridge: null,
      inputLocked: false,
      runtime: new DesktopRuntime(options.runtime),
      registrations: Effect.unsafeMakeSemaphore(1)
    }
    Effect.runSync(
      Scope.addFinalizer(
        entry.runtime.scope,
        Effect.sync(() => {
          pendingGuests.delete(guest.id)
          if (entry.panelId && entries.get(entry.panelId) === entry) {
            entries.delete(entry.panelId)
          }

          entry.bridge = null
          if (!guest.isDestroyed()) {
            guest.close({ waitForBeforeUnload: false })
          }
        })
      )
    )
    pendingGuests.set(guest.id, entry)
    const refreshErrorPage = (
      errorDescription: string,
      validatedUrl: string
    ) => {
      const parsedUrl = decodeUnknownOrNull(browserUrlSchema, validatedUrl)
      if (!parsedUrl) {
        return
      }

      const failedUrl = new URL(parsedUrl).href
      if (guest.getURL() !== failedUrl) {
        return
      }

      const host = new URL(failedUrl).hostname
      const detail =
        errorDescription === 'ERR_CONNECTION_REFUSED'
          ? `${host} refused the connection.`
          : 'Treeport could not load this page.'
      const script = `(() => {
        if (window.location.href !== 'chrome-error://chromewebdata/') return false
        document.documentElement.lang = 'en'
        document.title = ${JSON.stringify(host)}
        const style = document.createElement('style')
        style.textContent = ${JSON.stringify(`
          :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
          body { min-height: 100vh; margin: 0; background: #fff; color: #202124; }
          main { box-sizing: border-box; width: min(100%, 640px); margin: 0 auto; padding: clamp(4rem, 14vh, 8rem) 2rem 3rem; }
          h1 { margin: 0 0 1rem; font-size: 1.75rem; font-weight: 500; line-height: 1.25; }
          p { margin: 0 0 0.75rem; color: #5f6368; font-size: 0.95rem; line-height: 1.5; }
          button { margin: 1rem 0 1.5rem; border: 0; border-radius: 999px; padding: 0.65rem 1.15rem; background: #1a73e8; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
          button:focus-visible { outline: 3px solid #8ab4f8; outline-offset: 3px; }
          code { display: block; overflow-wrap: anywhere; color: #5f6368; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
          @media (prefers-color-scheme: dark) { body { background: #202124; color: #e8eaed; } p, code { color: #9aa0a6; } button { background: #8ab4f8; color: #202124; } }
        `)}
        const main = document.createElement('main')
        const heading = document.createElement('h1')
        heading.textContent = 'This site cannot be reached'
        const detail = document.createElement('p')
        detail.textContent = ${JSON.stringify(detail)}
        const suggestion = document.createElement('p')
        suggestion.textContent = 'Make sure that the server is running and that the address is correct.'
        const reload = document.createElement('button')
        reload.type = 'button'
        reload.textContent = 'Reload'
        reload.addEventListener('click', () => window.location.reload())
        const code = document.createElement('code')
        code.textContent = ${JSON.stringify(errorDescription)}
        main.append(heading, detail, suggestion, reload, code)
        document.head.replaceChildren(style)
        document.body.replaceChildren(main)
        return true
      })()`
      entry.runtime.fork(
        Effect.tryPromise(() => guest.executeJavaScript(script))
      )
    }

    guest.on(
      'did-fail-load',
      (_event, _errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (isMainFrame && errorDescription !== 'ERR_ABORTED') {
          refreshErrorPage(errorDescription, validatedUrl)
        }
      }
    )
    const preventUnsupportedNavigation = (
      event: Electron.Event,
      targetUrl: string
    ) => {
      if (
        targetUrl !== 'about:blank' &&
        !decodeUnknownOrNull(browserUrlSchema, targetUrl)
      ) {
        event.preventDefault()
      }
    }
    guest.on('will-navigate', preventUnsupportedNavigation)
    guest.on('will-redirect', preventUnsupportedNavigation)
    const openInNewPanel = (url: string) => {
      const popup = decodeUnknownOrNull(browserUrlSchema, url)
      const panelId = entry.panelId
      if (!popup || !panelId || options.trustedRenderer.isDestroyed()) {
        return
      }

      options.trustedRenderer.send('native-browser:popup', {
        panelId,
        url: new URL(popup).href
      })
    }
    guest.setWindowOpenHandler(({ url }) => {
      openInNewPanel(url)
      return { action: 'deny' }
    })
    guest.session.setPermissionRequestHandler(
      (contents, permission, callback, details) =>
        callback(permitsBrowserVideoCapture(contents, permission, details))
    )
    const reportBrowserFocus = () => {
      if (
        entry.panelId &&
        !entry.inputLocked &&
        !options.trustedRenderer.isDestroyed()
      ) {
        options.trustedRenderer.send('native-browser:focus', entry.panelId)
      }
    }
    guest.on('focus', reportBrowserFocus)
    guest.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown') {
        reportBrowserFocus()
      }
    })
    guest.on('before-input-event', (event, input) => {
      // Agent/remote page shortcuts must not invoke Treeport's native menu
      // commands (for example Ctrl+W must not close a workspace panel).
      if (entry.inputLocked) {
        return
      }

      const commandModifier =
        process.platform === 'darwin' ? input.meta : input.control
      const key = input.key.toLowerCase()
      const code = input.code.toLowerCase()
      // SAFETY: The digit expression restricts the interpolated command to the DesktopCommand tab range.
      const command: DesktopCommand | undefined = input.alt
        ? !input.shift && code === 'keyb'
          ? 'toggle-side-panel'
          : undefined
        : input.shift
          ? code === 'bracketleft'
            ? 'select-previous-worktree'
            : code === 'bracketright'
              ? 'select-next-worktree'
              : key === 't'
                ? 'new-panel'
                : undefined
          : key === 't'
            ? 'new-terminal'
            : key === 'w'
              ? 'close-panel'
              : key === 'l'
                ? 'focus-location'
                : key === 'f'
                  ? 'find-in-page'
                  : /^[1-9]$/.test(key)
                    ? (`select-tab-${key}` as DesktopCommand)
                    : undefined
      if (
        input.type !== 'keyDown' ||
        input.isAutoRepeat ||
        input.isComposing ||
        !commandModifier ||
        !command
      ) {
        return
      }

      event.preventDefault()
      if (!options.trustedRenderer.isDestroyed()) {
        options.trustedRenderer.send('desktop-command', command)
      }
    })
    guest.on('context-menu', (event, params) => {
      if (entry.inputLocked) {
        event.preventDefault()
        return
      }

      const template: MenuItemConstructorOptions[] = []
      const link = decodeUnknownOrNull(browserUrlSchema, params.linkURL)
      if (params.linkURL) {
        if (link) {
          template.push({
            label: 'Open Link in New Tab',
            click: () => openInNewPanel(link)
          })
        }

        template.push({
          label: 'Copy Link Address',
          click: () => clipboard.writeText(params.linkURL)
        })
        template.push({ type: 'separator' })
      }

      if (params.isEditable) {
        template.push(
          { role: 'undo', enabled: params.editFlags.canUndo },
          { role: 'redo', enabled: params.editFlags.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { role: 'selectAll', enabled: params.editFlags.canSelectAll },
          { type: 'separator' }
        )
      } else if (params.selectionText) {
        template.push(
          { role: 'copy', enabled: params.editFlags.canCopy },
          { type: 'separator' }
        )
      }

      template.push(
        {
          label: 'Back',
          enabled: guest.navigationHistory.canGoToOffset(-1),
          click: () => guest.navigationHistory.goToOffset(-1)
        },
        {
          label: 'Forward',
          enabled: guest.navigationHistory.canGoToOffset(1),
          click: () => guest.navigationHistory.goToOffset(1)
        },
        { label: 'Reload', click: () => guest.reload() },
        { type: 'separator' },
        {
          label: 'Inspect Element',
          click: () => {
            guest.inspectElement(params.x, params.y)
            guest.openDevTools({ mode: 'detach', activate: true })
          }
        }
      )
      const popupOptions: PopupOptions = {
        window: options.window,
        sourceType: params.menuSourceType
      }
      if (params.frame) {
        popupOptions.frame = params.frame
      }

      Menu.buildFromTemplate(template).popup(popupOptions)
    })
    guest.once('destroyed', () => {
      options.runtime.fork(disposeEntry(entry))
    })
  })

  return {
    register(event, panelId, webContentsId, challenge) {
      return Effect.gen(function* () {
        if (!options.isTrustedEvent(event) || options.runtime.isClosed) {
          return null
        }

        let entry = entries.get(panelId)
        if (!entry) {
          const pending = pendingGuests.get(webContentsId)
          if (
            pending &&
            browserBootstrapPanelId(pending.guest.getURL()) === panelId &&
            decodeUnknownOrNull(browserPanelIdSchema, panelId) !== null
          ) {
            pendingGuests.delete(webContentsId)
            pending.panelId = panelId
            entries.set(panelId, pending)
            entry = pending
          }
        }

        if (
          !entry ||
          entry.guest.id !== webContentsId ||
          entry.guest.hostWebContents !== options.trustedRenderer ||
          entry.guest.isDestroyed()
        ) {
          return null
        }

        const registered = entry
        return yield* registered.registrations.withPermits(1)(
          Effect.gen(function* () {
            // Validate after admission, not only before waiting for a replacement.
            if (
              registered.runtime.isClosed ||
              entries.get(panelId) !== registered ||
              registered.guest.isDestroyed()
            ) {
              return null
            }

            const previousBridge = registered.bridge
            registered.bridge = null
            if (previousBridge) {
              yield* previousBridge.stop
            }

            const bridge = yield* createBrowserCdpBridge(
              registered.guest,
              { panelId, challenge },
              registered.runtime,
              () => registered.inputLocked
            )
            if (
              registered.runtime.isClosed ||
              entries.get(panelId) !== registered ||
              registered.guest.isDestroyed()
            ) {
              yield* bridge.stop
              return null
            }

            registered.bridge = bridge
            return bridge.descriptor
          })
        )
      })
    },
    command(event, panelId, command) {
      return Effect.gen(function* () {
        const entry = entries.get(panelId)
        if (
          !options.isTrustedEvent(event) ||
          !entry ||
          entry.guest.isDestroyed()
        ) {
          return { ok: false, error: 'The Browser page is not available.' }
        }

        if (entry.inputLocked) {
          return {
            ok: false,
            error: 'Another Treeport client controls this Browser.'
          }
        }

        // Dispatch immediately: Stop and newer navigations must interrupt loadURL.
        return yield* Effect.gen(function* () {
          if (entry.runtime.isClosed || entry.guest.isDestroyed()) {
            return yield* Effect.fail(
              new Error('The Browser page is not available.')
            )
          }

          if (command.type === 'navigate') {
            yield* Effect.tryPromise({
              try: () => entry.guest.loadURL(command.url),
              catch: (cause) => cause
            })
          } else if (
            command.type === 'back' &&
            entry.guest.navigationHistory.canGoBack()
          ) {
            entry.guest.navigationHistory.goBack()
          } else if (
            command.type === 'forward' &&
            entry.guest.navigationHistory.canGoForward()
          ) {
            entry.guest.navigationHistory.goForward()
          } else if (command.type === 'reload') {
            entry.guest.reload()
          } else if (command.type === 'stop') {
            entry.guest.stop()
          }
        }).pipe(
          Effect.match({
            onSuccess: () => ({ ok: true, error: null }),
            onFailure: (cause: unknown) => {
              const error: NodeJS.ErrnoException =
                cause instanceof Error ? cause : new Error(String(cause))
              // Chromium aborts the previous load when the user stops or replaces it.
              return error.code === 'ERR_ABORTED'
                ? { ok: true, error: null }
                : { ok: false, error: error.message }
            }
          })
        )
      })
    },
    setInputControl(event, panelId, locked) {
      return Effect.sync(() => {
        const entry = entries.get(panelId)
        if (
          !options.isTrustedEvent(event) ||
          !entry ||
          entry.guest.isDestroyed()
        ) {
          return false
        }

        entry.inputLocked = locked
        return entries.get(panelId) === entry && !entry.guest.isDestroyed()
      })
    },
    requestClose(event, panelId, force) {
      return Effect.gen(function* () {
        if (!options.isTrustedEvent(event)) {
          return false
        }

        const entry = entries.get(panelId)
        if (!entry || entry.guest.isDestroyed()) {
          return true
        }

        return yield* Effect.async<boolean>((resume) => {
          const cleanup = () => {
            entry.guest.removeListener('destroyed', closed)
            entry.guest.removeListener('will-prevent-unload', prevented)
          }
          const closed = () => {
            cleanup()
            resume(Effect.succeed(true))
          }
          const prevented = (closeEvent: Electron.Event) => {
            if (force) {
              closeEvent.preventDefault()
            } else {
              cleanup()
              resume(Effect.succeed(false))
            }
          }
          entry.guest.once('destroyed', closed)
          entry.guest.once('will-prevent-unload', prevented)
          entry.guest.close({ waitForBeforeUnload: true })
          return Effect.sync(cleanup)
        }).pipe(
          Effect.timeoutTo({
            duration: '5 seconds',
            onTimeout: () => false,
            onSuccess: (closed) => closed
          })
        )
      })
    },
    dispose(event, panelId) {
      return Effect.suspend(() => {
        if (!options.isTrustedEvent(event)) {
          return Effect.void
        }

        const entry = entries.get(panelId)
        return entry ? disposeEntry(entry) : Effect.void
      })
    },
    disposeAll() {
      return Effect.suspend(() =>
        Effect.forEach(
          [...entries.values(), ...pendingGuests.values()],
          disposeEntry,
          { concurrency: 'unbounded', discard: true }
        )
      )
    }
  }
}
