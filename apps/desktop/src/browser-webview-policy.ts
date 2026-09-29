import {
  browserPanelIdSchema,
  browserUrlSchema,
  decodeUnknownOrNull
} from '@treeport/shared'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import {
  app,
  clipboard,
  Menu,
  session,
  systemPreferences,
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
  DesktopBrowserPermissions,
  DesktopBrowserToolbarCommand,
  DesktopCommand
} from './desktop-contract'

import { isBrowserLoopbackHostname } from './browser-loopback'
import { browserPresentationOrigin } from './browser-presentation'
import { permitsBrowserVideoCapture } from './browser-video'
import * as Effect from 'effect/Effect'
import * as Scope from 'effect/Scope'
import { DesktopRuntime } from './desktop-runtime'

const BROWSER_PARTITION = 'persist:treeport-browser'
const DECISIONS_FILE = 'browser-site-permissions.json'
const capabilities = {
  'clipboard-read': 'read your clipboard',
  geolocation: 'know your location',
  notifications: 'show notifications',
  camera: 'use your camera',
  microphone: 'use your microphone',
  'loopback-network': 'connect to services on your computer (localhost)'
} as const
type Capability = keyof typeof capabilities

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
  presentationActive: boolean
  fullscreenOrigin: string | null
  runtime: DesktopRuntime
  registrations: Effect.Semaphore
  navigationVersion: number
  pendingPermissions: Set<() => void>
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
  setPresentationActive(
    event: IpcMainInvokeEvent,
    panelId: string,
    active: boolean
  ): Effect.Effect<boolean>
  requestClose(
    event: IpcMainInvokeEvent,
    panelId: string,
    force: boolean
  ): Effect.Effect<boolean>
  dispose(event: IpcMainEvent, panelId: string): Effect.Effect<void>
  disposeAll(): Effect.Effect<void>
  respondPermission(event: IpcMainEvent, id: string, allow: boolean): void
  permissions(
    event: IpcMainInvokeEvent,
    panelId: string
  ): DesktopBrowserPermissions | null
  resetPermissions(
    event: IpcMainInvokeEvent,
    panelId: string,
    origin: string,
    capability: string | null
  ): boolean
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
  const guestEntries = new Map<number, BrowserEntry>()
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  const decisionsPath = path.join(app.getPath('userData'), DECISIONS_FILE)
  const decisions = new Map<string, boolean>()
  // The file is data, not authority: only exact, known origin/capability keys are loaded.
  try {
    const saved = z
      .record(z.string(), z.boolean())
      .safeParse(JSON.parse(readFileSync(decisionsPath, 'utf8')))
    if (saved.success) {
      for (const [key, value] of Object.entries(saved.data)) {
        const [origin, capability, extra] = key.split('|')
        if (
          !extra &&
          origin &&
          capability &&
          Object.hasOwn(capabilities, capability) &&
          URL.canParse(origin) &&
          new URL(origin).origin === origin &&
          ['https:', 'http:'].includes(new URL(origin).protocol)
        ) {
          decisions.set(key, value)
        }
      }
    }
  } catch {
    // Missing or corrupt preferences are treated as no grants.
  }
  const saveDecisions = () => {
    const temporary = `${decisionsPath}.tmp`
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(decisions)), {
      mode: 0o600
    })
    renameSync(temporary, decisionsPath)
  }
  const clearDecisions = (
    origin: string,
    capability: string | null
  ): boolean => {
    const previous = new Map(decisions)
    for (const key of decisions.keys()) {
      if (
        key === `${origin}|${capability}` ||
        (capability === null && key.startsWith(`${origin}|`))
      ) {
        decisions.delete(key)
      }
    }

    try {
      saveDecisions()
    } catch {
      decisions.clear()
      for (const [key, allowed] of previous) {
        decisions.set(key, allowed)
      }
      return false
    }

    for (const entry of guestEntries.values()) {
      cancelPending(entry)
    }
    return true
  }
  let promptQueue = Promise.resolve()
  let pendingPrompt: {
    id: string
    entry: BrowserEntry
    finish: (allow: boolean) => void
  } | null = null
  const askSite = (
    entry: BrowserEntry,
    origin: string,
    capability: string,
    destination: string | null
  ): Promise<boolean> => {
    if (
      !entry.panelId ||
      options.trustedRenderer.isDestroyed() ||
      options.window.isDestroyed()
    ) {
      return Promise.resolve(false)
    }

    return new Promise<boolean>((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => finish(false), 45_000)
      const finish = (allow: boolean) => {
        if (pendingPrompt?.id !== id) {
          return
        }

        clearTimeout(timer)
        pendingPrompt = null
        if (!options.trustedRenderer.isDestroyed()) {
          options.trustedRenderer.send('native-browser:permission-prompt', null)
        }

        resolve(allow)
      }
      pendingPrompt = { id, entry, finish }
      options.trustedRenderer.send('native-browser:permission-prompt', {
        id,
        panelId: entry.panelId,
        origin,
        capability,
        destination
      })
    })
  }
  const registered = (contents: WebContents | null): BrowserEntry | null => {
    if (!contents || contents.isDestroyed()) {
      return null
    }

    const entry = guestEntries.get(contents.id)
    return entry &&
      entry.guest === contents &&
      entry.panelId &&
      entries.get(entry.panelId) === entry &&
      contents.hostWebContents === options.trustedRenderer &&
      options.selectedComputer()?.loopback === true &&
      !options.window.isDestroyed()
      ? entry
      : null
  }
  const siteOrigin = (
    entry: BrowserEntry,
    url: string | undefined,
    main: boolean
  ): string | null => {
    if (!main || !url || !URL.canParse(url)) {
      return null
    }

    const parsed = new URL(url)
    if (
      !['https:', 'http:'].includes(parsed.protocol) ||
      parsed.origin === 'null'
    ) {
      return null
    }

    // Only the current main-frame document may ask. Subframes are denied rather
    // than trusting an unverified requestingUrl/securityOrigin string.
    return URL.canParse(entry.guest.getURL()) &&
      new URL(entry.guest.getURL()).origin === parsed.origin
      ? parsed.origin
      : null
  }
  const osAllows = (capability: Capability): boolean => {
    if (capability !== 'camera' && capability !== 'microphone') {
      return true
    }

    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return true
    }

    const status = systemPreferences.getMediaAccessStatus(capability)
    return status !== 'denied' && status !== 'restricted'
  }
  options.trustedRenderer.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      pendingPrompt?.finish(false)
      for (const entry of guestEntries.values()) {
        for (const cancel of entry.pendingPermissions) {
          cancel()
        }
      }
    }
  })
  const cancelPending = (entry: BrowserEntry) => {
    if (pendingPrompt?.entry === entry) {
      pendingPrompt.finish(false)
    }

    for (const cancel of entry.pendingPermissions) {
      cancel()
    }
    entry.pendingPermissions.clear()
  }

  const isPresentationEligible = (entry: BrowserEntry): boolean =>
    entry.panelId !== null &&
    entries.get(entry.panelId) === entry &&
    guestEntries.get(entry.guest.id) === entry &&
    !entry.guest.isDestroyed() &&
    entry.guest.hostWebContents === options.trustedRenderer &&
    entry.presentationActive &&
    !entry.inputLocked &&
    options.selectedComputer()?.loopback === true &&
    !options.window.isDestroyed() &&
    options.window.isVisible() &&
    options.window.isFocused()

  const releasePresentation = (entry: BrowserEntry) => {
    entry.fullscreenOrigin = null
    if (entry.guest.isDestroyed()) {
      return
    }

    entry.runtime.fork(
      Effect.tryPromise(() =>
        entry.guest.executeJavaScript(`(async () => {
          if (document.pointerLockElement) document.exitPointerLock()
          if (document.fullscreenElement) await document.exitFullscreen()
        })()`)
      ).pipe(Effect.catchAll(() => Effect.void)),
      'desktop.browser.release-presentation'
    )
  }

  browserSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      console.info('[browser permission check]', {
        permission,
        webContentsId: contents?.id ?? null,
        requestingOrigin,
        documentOrigin:
          details.requestingUrl && URL.canParse(details.requestingUrl)
            ? new URL(details.requestingUrl).origin
            : null,
        isMainFrame: details.isMainFrame
      })

      const entry = registered(contents)
      if (!entry) {
        return false
      }

      if (permission === 'media') {
        const capability =
          details.mediaType === 'video'
            ? 'camera'
            : details.mediaType === 'audio'
              ? 'microphone'
              : null
        const origin = siteOrigin(
          entry,
          details.requestingUrl ?? details.securityOrigin ?? requestingOrigin,
          details.isMainFrame
        )
        return (
          !!capability &&
          !!origin &&
          osAllows(capability) &&
          decisions.get(`${origin}|${capability}`) === true
        )
      }

      if (Object.hasOwn(capabilities, permission)) {
        const origin = siteOrigin(
          entry,
          details.requestingUrl ?? requestingOrigin,
          details.isMainFrame
        )
        return !!origin && decisions.get(`${origin}|${permission}`) === true
      }

      const origin = browserPresentationOrigin(
        permission,
        details.requestingUrl ?? requestingOrigin,
        isPresentationEligible(entry)
      )
      if (permission === 'fullscreen' && origin) {
        entry.fullscreenOrigin = origin
      }

      return origin !== null
    }
  )
  browserSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      console.info('[browser permission request]', {
        permission,
        webContentsId: contents.id,
        documentOrigin: URL.canParse(details.requestingUrl)
          ? new URL(details.requestingUrl).origin
          : null,
        isMainFrame: details.isMainFrame
      })

      if (
        registered(contents) &&
        permitsBrowserVideoCapture(contents, permission, details)
      ) {
        callback(true)
        return
      }

      const entry = registered(contents)
      if (!entry) {
        callback(false)
        return
      }

      // SAFETY: membership in capabilities validates the key before narrowing it.
      let requested: Capability[] = Object.hasOwn(capabilities, permission)
        ? [permission as Capability]
        : []
      if (permission === 'media') {
        // SAFETY: Electron supplies MediaAccessPermissionRequest for media requests.
        const types = (details as Electron.MediaAccessPermissionRequest)
          .mediaTypes
        requested =
          types?.length &&
          types.every((type) => type === 'video' || type === 'audio')
            ? [
                ...new Set(
                  types.map((type) =>
                    type === 'video' ? 'camera' : 'microphone'
                  )
                )
              ]
            : []
      }

      if (requested.length) {
        const origin = siteOrigin(
          entry,
          details.requestingUrl,
          details.isMainFrame
        )
        if (!origin || !requested.every(osAllows)) {
          callback(false)
          return
        }

        const keys = requested.map((capability) => `${origin}|${capability}`)
        if (keys.some((key) => decisions.get(key) === false)) {
          callback(false)
          return
        }

        const missing = requested.filter(
          (capability) => !decisions.has(`${origin}|${capability}`)
        )
        if (!missing.length) {
          callback(true)
          return
        }

        const version = entry.navigationVersion
        let settled = false
        const resolve = (allowed: boolean) => {
          if (settled) {
            return
          }

          settled = true
          entry.pendingPermissions.delete(cancel)
          callback(
            allowed &&
              registered(contents) === entry &&
              entry.navigationVersion === version &&
              siteOrigin(entry, details.requestingUrl, details.isMainFrame) ===
                origin &&
              requested.every(osAllows)
          )
        }
        const cancel = () => resolve(false)
        entry.pendingPermissions.add(cancel)
        const prompt = async () => {
          if (
            settled ||
            registered(contents) !== entry ||
            entry.navigationVersion !== version
          ) {
            cancel()
            return
          }

          if (keys.every((key) => decisions.has(key))) {
            resolve(keys.every((key) => decisions.get(key) === true))
            return
          }

          try {
            const approved = await askSite(
              entry,
              origin,
              missing
                .map((capability) => capabilities[capability])
                .join(' and '),
              null
            )
            if (
              settled ||
              registered(contents) !== entry ||
              entry.navigationVersion !== version ||
              siteOrigin(entry, details.requestingUrl, details.isMainFrame) !==
                origin
            ) {
              cancel()
              return
            }

            let allowed = approved
            if (allowed && process.platform === 'darwin') {
              for (const capability of missing) {
                if (
                  (capability === 'camera' || capability === 'microphone') &&
                  systemPreferences.getMediaAccessStatus(capability) ===
                    'not-determined'
                ) {
                  allowed =
                    (await systemPreferences.askForMediaAccess(capability)) &&
                    allowed
                }
              }
            }

            if (
              settled ||
              registered(contents) !== entry ||
              entry.navigationVersion !== version
            ) {
              cancel()
              return
            }

            for (const capability of missing) {
              decisions.set(`${origin}|${capability}`, allowed)
            }
            try {
              saveDecisions()
            } catch {
              for (const capability of missing) {
                decisions.delete(`${origin}|${capability}`)
              }
              cancel()
              return
            }
            resolve(allowed)
          } catch {
            cancel()
          }
        }
        promptQueue = promptQueue.then(prompt, prompt)
        return
      }

      const origin = browserPresentationOrigin(
        permission,
        details.requestingUrl,
        isPresentationEligible(entry)
      )
      if (permission === 'fullscreen' && origin) {
        entry.fullscreenOrigin = origin
      }

      callback(origin !== null)
    }
  )

  // Electron 43 checks loopback-network without requesting it after a denied
  // check. Hold public/local -> loopback requests so the user can grant access.
  // Loopback documents do not cross into a more-private address space and must
  // load normally, including requests to other localhost ports and WebSockets.
  browserSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      if (
        !URL.canParse(details.url) ||
        details.resourceType === 'mainFrame' ||
        details.resourceType === 'subFrame'
      ) {
        callback({})
        return
      }

      const target = new URL(details.url)
      if (
        !['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) ||
        !isBrowserLoopbackHostname(target.hostname)
      ) {
        callback({})
        return
      }

      const contents =
        details.webContents ??
        (details.webContentsId
          ? guestEntries.get(details.webContentsId)?.guest
          : null)
      const entry = registered(contents ?? null)

      // A referrer is page-controlled; use Electron's actual requesting frame.
      const frame = details.frame
      const origin =
        entry && frame === entry.guest.mainFrame
          ? siteOrigin(entry, frame.url, true)
          : null
      if (!entry || !origin) {
        callback({ cancel: true })
        return
      }

      if (isBrowserLoopbackHostname(new URL(origin).hostname)) {
        callback({})
        return
      }

      const key = `${origin}|loopback-network`
      const remembered = decisions.get(key)
      if (remembered !== undefined) {
        callback({ cancel: !remembered })
        return
      }

      const version = entry.navigationVersion
      let settled = false
      const resolve = (allowed: boolean) => {
        if (settled) {
          return
        }

        settled = true
        entry.pendingPermissions.delete(cancel)
        callback({
          cancel: !(
            allowed &&
            registered(entry.guest) === entry &&
            entry.navigationVersion === version &&
            frame === entry.guest.mainFrame &&
            siteOrigin(entry, frame.url, true) === origin
          )
        })
      }
      const cancel = () => resolve(false)
      entry.pendingPermissions.add(cancel)
      const prompt = async () => {
        if (
          settled ||
          registered(entry.guest) !== entry ||
          entry.navigationVersion !== version
        ) {
          cancel()
          return
        }

        const current = decisions.get(key)
        if (current !== undefined) {
          resolve(current)
          return
        }

        try {
          const approved = await askSite(
            entry,
            origin,
            capabilities['loopback-network'],
            target.origin
          )
          if (
            settled ||
            registered(entry.guest) !== entry ||
            entry.navigationVersion !== version ||
            frame !== entry.guest.mainFrame ||
            siteOrigin(entry, frame.url, true) !== origin
          ) {
            cancel()
            return
          }

          const allowed = approved
          decisions.set(key, allowed)
          try {
            saveDecisions()
          } catch {
            decisions.delete(key)
            cancel()
            return
          }
          resolve(allowed)
        } catch {
          cancel()
        }
      }
      promptQueue = promptQueue.then(prompt, prompt)
    }
  )

  // Device selection and display capture require separate source/device choices;
  // a generic site grant cannot safely authorize them.
  browserSession.setDisplayMediaRequestHandler((_request, callback) =>
    callback({})
  )
  browserSession.setDevicePermissionHandler(() => false)
  browserSession.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault()
    callback('')
  })
  browserSession.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault()
    callback('')
  })
  browserSession.on(
    'select-serial-port',
    (event, _ports, _contents, callback) => {
      event.preventDefault()
      callback('')
    }
  )

  const disposeEntry = (entry: BrowserEntry) =>
    Effect.gen(function* () {
      cancelPending(entry)
      releasePresentation(entry)
      if (entry.panelId && entries.get(entry.panelId) === entry) {
        entries.delete(entry.panelId)
      }

      pendingGuests.delete(entry.guest.id)
      guestEntries.delete(entry.guest.id)

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
      guest.session !== browserSession
    ) {
      guest.close({ waitForBeforeUnload: false })
      return
    }

    const entry: BrowserEntry = {
      panelId: null,
      guest,
      bridge: null,
      inputLocked: false,
      presentationActive: false,
      fullscreenOrigin: null,
      runtime: new DesktopRuntime(options.runtime),
      registrations: Effect.unsafeMakeSemaphore(1),
      navigationVersion: 0,
      pendingPermissions: new Set()
    }
    Effect.runSync(
      Scope.addFinalizer(
        entry.runtime.scope,
        Effect.sync(() => {
          cancelPending(entry)
          pendingGuests.delete(guest.id)
          guestEntries.delete(guest.id)
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
    guestEntries.set(guest.id, entry)
    guest.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault()
      callback('')
    })
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
    guest.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        entry.navigationVersion++
        cancelPending(entry)
        releasePresentation(entry)
      }
    })
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
    guest.on('enter-html-full-screen', () => {
      if (!isPresentationEligible(entry)) {
        releasePresentation(entry)
        return
      }

      const origin =
        entry.fullscreenOrigin ??
        browserPresentationOrigin('fullscreen', guest.getURL(), true)
      if (!origin) {
        releasePresentation(entry)
        return
      }

      entry.runtime.fork(
        Effect.tryPromise(() =>
          guest.executeJavaScript(`(() => {
            const root = document.fullscreenElement
            if (!root) return false
            const notice = document.createElement('div')
            notice.setAttribute('data-treeport-fullscreen-notice', '')
            notice.textContent = ${JSON.stringify(
              `${origin} is full screen — Press Esc to exit`
            )}
            notice.style.cssText = 'position:fixed!important;top:16px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;box-sizing:border-box!important;max-width:calc(100% - 32px)!important;padding:9px 14px!important;border:1px solid rgba(255,255,255,.18)!important;border-radius:8px!important;background:rgba(9,9,11,.92)!important;color:#fafafa!important;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;text-align:center!important;white-space:nowrap!important;pointer-events:none!important;box-shadow:0 8px 30px rgba(0,0,0,.35)!important'
            root.append(notice)
            setTimeout(() => notice.remove(), 4000)
            return true
          })()`)
        ).pipe(Effect.catchAll(() => Effect.void)),
        'desktop.browser.fullscreen-notice'
      )
    })
    guest.on('leave-html-full-screen', () => {
      entry.fullscreenOrigin = null
    })
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
              registered.runtime
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
        if (locked) {
          releasePresentation(entry)
        }

        return entries.get(panelId) === entry && !entry.guest.isDestroyed()
      })
    },
    setPresentationActive(event, panelId, active) {
      return Effect.sync(() => {
        const entry = entries.get(panelId)
        if (
          !options.isTrustedEvent(event) ||
          !entry ||
          entry.guest.isDestroyed()
        ) {
          return false
        }

        entry.presentationActive = active
        if (!active) {
          releasePresentation(entry)
        }

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
    },
    permissions(event, panelId) {
      const entry = entries.get(panelId)
      if (
        !options.isTrustedEvent(event) ||
        !entry ||
        registered(entry.guest) !== entry
      ) {
        return null
      }

      const origin = siteOrigin(entry, entry.guest.getURL(), true)
      return {
        origin,
        decisions: origin
          ? Object.entries(capabilities).flatMap(([capability, label]) => {
              const allowed = decisions.get(`${origin}|${capability}`)
              return allowed === undefined
                ? []
                : [{ capability, label, allowed }]
            })
          : []
      }
    },
    resetPermissions(event, panelId, origin, capability) {
      const entry = entries.get(panelId)
      if (
        !options.isTrustedEvent(event) ||
        !entry ||
        registered(entry.guest) !== entry
      ) {
        return false
      }

      if (
        siteOrigin(entry, entry.guest.getURL(), true) !== origin ||
        (capability !== null && !Object.hasOwn(capabilities, capability))
      ) {
        return false
      }

      return clearDecisions(origin, capability)
    },
    respondPermission(event, id, allow) {
      if (
        options.isTrustedEvent(event) &&
        pendingPrompt?.id === id &&
        registered(pendingPrompt.entry.guest) === pendingPrompt.entry
      ) {
        pendingPrompt.finish(allow)
      }
    }
  }
}
