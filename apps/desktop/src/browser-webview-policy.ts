import { browserUrlSchema } from '@treeport/shared'
import {
  Menu,
  session,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { z } from 'zod'
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

const browserPanelIdSchema = z.string().min(1).max(128)
const browserUrlWithBlankSchema = z.union([
  z.literal('about:blank'),
  browserUrlSchema
])

interface BrowserEntry {
  panelId: string
  guest: WebContents
  bridge: BrowserCdpBridge | null
  commandQueue: Promise<void>
  agentLocked: boolean
}

export interface BrowserWebviewPolicy {
  register(
    event: IpcMainInvokeEvent,
    panelId: string,
    webContentsId: number,
    challenge: string
  ): Promise<DesktopBrowserBridgeDescriptor | null>
  command(
    event: IpcMainInvokeEvent,
    panelId: string,
    command: DesktopBrowserToolbarCommand
  ): Promise<DesktopBrowserCommandResult>
  setAgentControl(
    event: IpcMainInvokeEvent,
    panelId: string,
    locked: boolean
  ): Promise<boolean>
  requestClose(
    event: IpcMainInvokeEvent,
    panelId: string,
    force: boolean
  ): Promise<boolean>
  dispose(event: IpcMainEvent, panelId: string): void
  disposeAll(clearStorage: boolean): void
}

export function installBrowserWebviewPolicy(options: {
  window: BrowserWindow
  trustedRenderer: WebContents
  selectedComputer(): { id: string; loopback: boolean } | null
  isTrustedEvent(event: IpcMainEvent | IpcMainInvokeEvent): boolean
}): BrowserWebviewPolicy {
  const entries = new Map<string, BrowserEntry>()
  const pendingPartitions = new Set<string>()

  const disposeEntry = async (entry: BrowserEntry, clearStorage: boolean) => {
    if (entries.get(entry.panelId) === entry) {
      entries.delete(entry.panelId)
    }

    const browserSession = entry.guest.session
    await entry.bridge?.stop()
    entry.bridge = null
    if (!entry.guest.isDestroyed()) {
      entry.guest.close({ waitForBeforeUnload: false })
    }

    if (clearStorage) {
      await browserSession.clearStorageData().catch(() => undefined)
    }
  }

  options.trustedRenderer.on(
    'will-attach-webview',
    (event, webPreferences, params) => {
      const computer = options.selectedComputer()
      const parsedUrl = browserUrlWithBlankSchema.safeParse(params.src)
      const partition = params.partition ?? webPreferences.partition ?? ''
      const prefix = computer ? `treeport-browser-${computer.id}-` : ''
      const panelId = prefix ? partition.slice(prefix.length) : ''
      if (
        !computer?.loopback ||
        !parsedUrl.success ||
        !partition.startsWith(prefix) ||
        !browserPanelIdSchema.safeParse(panelId).success ||
        entries.has(panelId) ||
        pendingPartitions.has(partition) ||
        entries.size + pendingPartitions.size >= 6
      ) {
        event.preventDefault()
        return
      }

      pendingPartitions.add(partition)
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
    const prefix = computer ? `treeport-browser-${computer.id}-` : ''
    const partition =
      [...pendingPartitions].find(
        (candidate) => session.fromPartition(candidate) === guest.session
      ) ?? ''
    const panelId = prefix ? partition.slice(prefix.length) : ''
    pendingPartitions.delete(partition)
    if (
      !computer?.loopback ||
      guest.hostWebContents !== options.trustedRenderer ||
      !partition.startsWith(prefix) ||
      !browserPanelIdSchema.safeParse(panelId).success ||
      entries.has(panelId)
    ) {
      guest.close({ waitForBeforeUnload: false })
      return
    }

    const entry: BrowserEntry = {
      panelId,
      guest,
      bridge: null,
      commandQueue: Promise.resolve(),
      agentLocked: false
    }
    entries.set(panelId, entry)
    const refreshErrorPage = (
      errorDescription: string,
      validatedUrl: string
    ) => {
      const parsedUrl = browserUrlSchema.safeParse(validatedUrl)
      if (!parsedUrl.success) {
        return
      }

      const failedUrl = new URL(parsedUrl.data).href
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
          code { color: #5f6368; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
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
      void guest.executeJavaScript(script).catch(() => undefined)
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
      if (!browserUrlWithBlankSchema.safeParse(targetUrl).success) {
        event.preventDefault()
      }
    }
    guest.on('will-navigate', preventUnsupportedNavigation)
    guest.on('will-redirect', preventUnsupportedNavigation)
    guest.setWindowOpenHandler(({ url }) => {
      const popup = URL.canParse(url) ? new URL(url) : null
      if (
        popup &&
        (popup.protocol === 'http:' || popup.protocol === 'https:') &&
        !popup.username &&
        !popup.password &&
        !options.trustedRenderer.isDestroyed()
      ) {
        options.trustedRenderer.send('native-browser:popup', {
          panelId,
          url: popup.href
        })
      }

      return { action: 'deny' }
    })
    guest.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false)
    )
    guest.on('before-input-event', (event, input) => {
      const commandModifier =
        process.platform === 'darwin' ? input.meta : input.control
      const key = input.key.toLowerCase()
      const command: DesktopCommand | undefined = input.shift
        ? key === 't'
          ? 'new-panel'
          : undefined
        : key === 'w'
          ? 'close-panel'
          : undefined
      if (
        input.type !== 'keyDown' ||
        input.isAutoRepeat ||
        input.isComposing ||
        !commandModifier ||
        input.alt ||
        !command
      ) {
        return
      }

      event.preventDefault()
      if (!options.trustedRenderer.isDestroyed()) {
        options.trustedRenderer.send('desktop-command', command)
      }
    })
    guest.on('context-menu', (_event, params) => {
      Menu.buildFromTemplate([
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
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
      ]).popup({ window: options.window })
    })
    guest.once('destroyed', () => {
      if (entries.get(panelId) === entry) {
        entries.delete(panelId)
      }
    })
  })

  return {
    async register(event, panelId, webContentsId, challenge) {
      const entry = entries.get(panelId)
      if (
        !options.isTrustedEvent(event) ||
        !entry ||
        entry.guest.id !== webContentsId ||
        entry.guest.hostWebContents !== options.trustedRenderer ||
        entry.guest.isDestroyed() ||
        entry.bridge
      ) {
        return null
      }

      const bridge = await createBrowserCdpBridge(entry.guest, {
        panelId,
        challenge
      })
      if (entries.get(panelId) !== entry || entry.guest.isDestroyed()) {
        await bridge.stop()
        return null
      }

      entry.bridge = bridge
      return bridge.descriptor
    },
    async command(event, panelId, command) {
      const entry = entries.get(panelId)
      if (
        !options.isTrustedEvent(event) ||
        !entry ||
        entry.guest.isDestroyed()
      ) {
        return { ok: false, error: 'The Browser page is not available.' }
      }

      if (entry.agentLocked) {
        return {
          ok: false,
          error: 'A coding agent controls this Browser.'
        }
      }

      let operationError: string | null = null
      const operation = entry.commandQueue.then(() => {
        if (entry.guest.isDestroyed()) {
          throw new Error('The Browser page is not available.')
        }

        if (command.type === 'navigate') {
          void entry.guest.loadURL(command.url).catch(() => undefined)
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
      })
      entry.commandQueue = operation.catch((cause) => {
        operationError = cause instanceof Error ? cause.message : String(cause)
      })
      await entry.commandQueue
      return operationError
        ? { ok: false, error: operationError }
        : { ok: true, error: null }
    },
    async setAgentControl(event, panelId, locked) {
      const entry = entries.get(panelId)
      if (
        !options.isTrustedEvent(event) ||
        !entry ||
        entry.guest.isDestroyed()
      ) {
        return false
      }

      if (locked) {
        entry.agentLocked = true
        await entry.commandQueue
        if (!options.trustedRenderer.isDestroyed()) {
          options.trustedRenderer.focus()
        }
      } else {
        entry.agentLocked = false
      }

      return entries.get(panelId) === entry && !entry.guest.isDestroyed()
    },
    async requestClose(event, panelId, force) {
      if (!options.isTrustedEvent(event)) {
        return false
      }

      const entry = entries.get(panelId)
      if (!entry || entry.guest.isDestroyed()) {
        return true
      }

      const browserSession = entry.guest.session
      const canClose = await new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const cleanup = () => {
          entry.guest.removeListener('destroyed', closed)
          entry.guest.removeListener('will-prevent-unload', prevented)
          if (timer) {
            clearTimeout(timer)
          }
        }
        const finish = (result: boolean) => {
          cleanup()
          resolve(result)
        }
        const closed = () => finish(true)
        const prevented = (closeEvent: Electron.Event) => {
          if (force) {
            closeEvent.preventDefault()
          } else {
            finish(false)
          }
        }
        entry.guest.once('destroyed', closed)
        entry.guest.once('will-prevent-unload', prevented)
        timer = setTimeout(() => finish(false), 5_000)
        timer.unref()
        entry.guest.close({ waitForBeforeUnload: true })
      })
      if (canClose) {
        await entry.bridge?.stop()
        entry.bridge = null
        await browserSession.clearStorageData().catch(() => undefined)
      }

      return canClose
    },
    dispose(event, panelId) {
      if (!options.isTrustedEvent(event)) {
        return
      }

      const entry = entries.get(panelId)
      if (entry) {
        void disposeEntry(entry, true)
      }
    },
    disposeAll(clearStorage) {
      pendingPartitions.clear()
      for (const entry of [...entries.values()]) {
        void disposeEntry(entry, clearStorage)
      }
    }
  }
}
