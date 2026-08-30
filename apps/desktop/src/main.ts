import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { browserUrlSchema } from '@treeport/shared'
import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  type IpcMainEvent,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { updateElectronApp, UpdateSourceType } from 'update-electron-app'
import { z } from 'zod'
import { ComputerStore } from './computer-store'
import { MINIMUM_SUPPORTED_BACKEND_VERSION } from './desktop-contract'
import type {
  ComputerMutationResult,
  ComputerUpdate,
  ConnectionState,
  DesktopBrowserToolbarCommand,
  DesktopCommand,
  DesktopNavigationDirection,
  DesktopNavigationState,
  DesktopShellState
} from './desktop-contract'
import {
  installBrowserWebviewPolicy,
  type BrowserWebviewPolicy
} from './browser-webview-policy'
import { filePathFromUrl } from './file-url'
import {
  localSourcePathSchema,
  resolveLocalSourcePath
} from './local-source-path'
import { isLoopbackUrl, parseComputerUrl } from './renderer-url'
import { createRendererRequestHandler } from './renderer-request-handler'
import { parseWorkspaceLink, type WorkspaceTarget } from './workspace-link'

const dirname = __dirname
const TITLEBAR_HEIGHT = 32
const RENDERER_PARTITION = 'persist:treeport-desktop-renderer'
const PRIVATE_RENDERER_URL = 'treeport-app://application/'

type ReleaseVersion = readonly [number, number, number]

function parseReleaseVersion(value: string): ReleaseVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareReleaseVersions(
  left: ReleaseVersion,
  right: ReleaseVersion
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

const parsedMinimumSupportedBackendRelease = parseReleaseVersion(
  MINIMUM_SUPPORTED_BACKEND_VERSION
)
if (!parsedMinimumSupportedBackendRelease) {
  throw new Error('The minimum supported backend version is invalid')
}

const minimumSupportedBackendRelease: ReleaseVersion =
  parsedMinimumSupportedBackendRelease

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'treeport-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])
const desktopE2e = process.env.TREEPORT_DESKTOP_E2E === '1'
const desktopReleaseVersion = app.isPackaged
  ? app.getVersion()
  : desktopE2e
    ? process.env.TREEPORT_DESKTOP_E2E_RELEASE_VERSION?.trim() || null
    : null
const desktopUpdateReady =
  desktopE2e && process.env.TREEPORT_DESKTOP_E2E_UPDATE_READY === '1'
const developmentUserData = process.env.TREEPORT_DESKTOP_USER_DATA?.trim()
if (desktopE2e && process.platform === 'darwin') {
  app.dock?.hide()
}

if (desktopE2e && developmentUserData) {
  app.setPath('userData', path.resolve(developmentUserData))
} else if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Treeport'))
} else if (developmentUserData) {
  app.setPath('userData', path.resolve(developmentUserData))
}

nativeTheme.themeSource = 'dark'

const defaultComputerUrl = app.isPackaged
  ? 'http://127.0.0.1:8733'
  : 'http://127.0.0.1:5173'
const seedComputerUrl =
  process.env.TREEPORT_DESKTOP_URL?.trim() || defaultComputerUrl

let mainWindow: BrowserWindow | null = null
let store: ComputerStore | null = null
let connection: ConnectionState = { status: 'empty' }
let connectionGeneration = 0
let connectionAbort: AbortController | null = null
let fullscreen = false
let updateReady = desktopUpdateReady
let stopAutomaticUpdates: (() => void) | null = null
let pendingWorkspaceTarget: WorkspaceTarget | null = null
let workspaceTargetQueue: Promise<void> = Promise.resolve()
let terminalSelectionActive = false
let browserWebviews: BrowserWebviewPolicy | null = null

let dockBounceId: number | null = null
let frameFlashing = false

function rendererDevelopmentServerUrl(): string | null {
  try {
    const parsed = z.string().url().safeParse(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    return parsed.success ? parsed.data : null
  } catch (error) {
    if (error instanceof ReferenceError) {
      return null
    }

    throw error
  }
}

async function installRendererRequestRouting(): Promise<void> {
  const rendererSession = session.fromPartition(RENDERER_PARTITION)
  const handler = await createRendererRequestHandler({
    rendererDirectory: path.join(dirname, '../renderer/main_window'),
    developmentServerUrl: rendererDevelopmentServerUrl(),
    selectedBackendOrigin: selectedOrigin,
    forward: (request) =>
      net.fetch(request, { bypassCustomProtocolHandlers: true })
  })
  await Promise.all([
    rendererSession.protocol.handle('http', handler),
    rendererSession.protocol.handle('https', handler),
    rendererSession.protocol.handle('treeport-app', handler)
  ])
}

function navigationState(): DesktopNavigationState {
  const renderer = mainWindow?.webContents
  if (!renderer || renderer.isDestroyed() || connection.status !== 'ready') {
    return { canGoBack: false, canGoForward: false }
  }

  // Electron's canGoBack/canGoForward omit same-document pushState entries.
  // Relative offsets include the TanStack Router locations in the renderer.
  return {
    canGoBack: renderer.navigationHistory.canGoToOffset(-1),
    canGoForward: renderer.navigationHistory.canGoToOffset(1)
  }
}

function shellState(): DesktopShellState {
  const state: DesktopShellState = {
    appVersion: desktopReleaseVersion ?? app.getVersion(),
    platform: process.platform,
    fullscreen,
    updateReady,
    computers: store?.summaries() ?? [],
    connection,
    navigation: navigationState()
  }
  if (store?.selectedComputer) {
    state.selectedComputerId = store.selectedComputer.id
  }

  return state
}

function broadcastState(): void {
  const state = shellState()
  const menu = Menu.getApplicationMenu()
  const backItem = menu?.getMenuItemById('navigate-back')
  const forwardItem = menu?.getMenuItemById('navigate-forward')
  if (backItem) {
    backItem.enabled = state.navigation.canGoBack
  }

  if (forwardItem) {
    forwardItem.enabled = state.navigation.canGoForward
  }

  const renderer = mainWindow?.webContents
  if (renderer && !renderer.isDestroyed()) {
    renderer.send('shell:state', state)
  }
}

function isTrustedRendererEvent(
  event: IpcMainEvent | IpcMainInvokeEvent
): boolean {
  return Boolean(
    mainWindow &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === event.sender.mainFrame
  )
}

function selectedOrigin(): string | null {
  return store?.selectedComputer?.origin ?? null
}

function setTerminalSelectionActive(active: boolean): void {
  terminalSelectionActive = active
  const renderer = mainWindow?.webContents
  if (renderer && !renderer.isDestroyed()) {
    renderer.send('terminal-selection:active', active)
  }
}

function releaseTerminalSelection(): void {
  setTerminalSelectionActive(false)
  const renderer = mainWindow?.webContents
  if (renderer && !renderer.isDestroyed()) {
    renderer.send('terminal-selection:release')
  }
}

function stopBellAttention(): void {
  if (dockBounceId !== null) {
    app.dock?.cancelBounce(dockBounceId)
    dockBounceId = null
  }

  if (frameFlashing) {
    mainWindow?.flashFrame(false)
    frameFlashing = false
  }
}

function requestBellAttention(): void {
  const window = mainWindow
  if (!window || window.isFocused()) {
    return
  }

  if (process.platform === 'darwin') {
    if (dockBounceId === null && app.dock) {
      dockBounceId = app.dock.bounce('informational')
    }
  } else if (!frameFlashing) {
    window.flashFrame(true)
    frameFlashing = true
  }
}

function disposeBrowserWebviews(): void {
  browserWebviews?.disposeAll()
  if (terminalSelectionActive) {
    setTerminalSelectionActive(false)
  }

  broadcastState()
}

function navigateRendererHistory(direction: DesktopNavigationDirection): void {
  const renderer = mainWindow?.webContents
  if (!renderer || renderer.isDestroyed() || connection.status !== 'ready') {
    return
  }

  const offset = direction === 'back' ? -1 : 1
  if (renderer.navigationHistory.canGoToOffset(offset)) {
    renderer.navigationHistory.goToOffset(offset)
  }
}

function sendDesktopCommand(command: DesktopCommand): void {
  const window = mainWindow
  if (!window || connection.status !== 'ready' || !window.isFocused()) {
    return
  }

  window.webContents.send('desktop-command', command)
}

function installRendererSecurity(renderer: WebContents): void {
  renderer.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
    const code = input.code.toLowerCase()
    if (
      process.platform === 'darwin' &&
      input.type === 'keyDown' &&
      !input.isAutoRepeat &&
      !input.isComposing &&
      input.meta &&
      !input.control &&
      !input.alt &&
      !input.shift &&
      (key === '[' || key === ']')
    ) {
      event.preventDefault()
      navigateRendererHistory(key === '[' ? 'back' : 'forward')
      return
    }

    const commandModifier =
      process.platform === 'darwin' ? input.meta : input.control
    // SAFETY: The digit expression restricts the interpolated command to the DesktopCommand tab range.
    const command: DesktopCommand | undefined = input.alt
      ? !input.shift && code === 'keyb'
        ? 'toggle-side-panel'
        : undefined
      : input.shift
        ? key === 't'
          ? 'new-panel'
          : undefined
        : key === 'n'
          ? 'new-worktree'
          : key === 't'
            ? 'new-terminal'
            : key === 'w'
              ? 'close-panel'
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
    renderer.send('desktop-command', command)
  })

  renderer.on('will-navigate', (event, targetUrl) => {
    const origin = selectedOrigin()
    if (
      targetUrl.startsWith('treeport-app://') ||
      (origin &&
        URL.canParse(targetUrl) &&
        new URL(targetUrl).origin === origin)
    ) {
      return
    }

    event.preventDefault()
    if (URL.canParse(targetUrl)) {
      const targetProtocol = new URL(targetUrl).protocol
      if (targetProtocol === 'http:' || targetProtocol === 'https:') {
        void shell.openExternal(targetUrl)
      }
    }
  })
  renderer.setWindowOpenHandler(({ url }) => {
    if (URL.canParse(url)) {
      const targetProtocol = new URL(url).protocol
      if (targetProtocol === 'http:' || targetProtocol === 'https:') {
        void shell.openExternal(url)
      }
    }

    return { action: 'deny' }
  })
  renderer.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false)
  )
  const refreshNavigationState = () => broadcastState()
  renderer.on('did-navigate', refreshNavigationState)
  renderer.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) {
      refreshNavigationState()
    }
  })
  renderer.on('did-finish-load', () => {
    renderer.send('fullscreen-change', fullscreen)
    refreshNavigationState()
    const origin = selectedOrigin()
    if (!origin || connection.status !== 'ready') {
      return
    }

    const verification = new AbortController()
    void checkHealth(origin, verification.signal).then((health) => {
      if (
        !health &&
        connection.status === 'ready' &&
        selectedOrigin() === origin
      ) {
        void connectSelected({
          unavailableImmediately: true,
          unavailableMessage: `The connection to ${origin} was lost.`
        })
      }
    })
  })
}

const healthResponseSchema = z.object({
  ok: z.literal(true),
  version: z
    .string()
    .trim()
    .min(1)
    .nullish()
    .catch(null)
    .transform((version) => version ?? null),
  hostname: z.string().optional()
})

const computerUpdateSchema = z.object({
  id: z.string(),
  origin: z.string(),
  nameOverride: z.string().optional()
})
const nativeBrowserPanelSchema = z.strictObject({
  panelId: z.string().min(1).max(128)
})
const nativeBrowserRegisterSchema = nativeBrowserPanelSchema.extend({
  webContentsId: z.number().int().positive(),
  challenge: z.string().min(32).max(256)
})
const nativeBrowserCloseSchema = nativeBrowserPanelSchema.extend({
  force: z.boolean()
})
const nativeBrowserCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('navigate'), url: browserUrlSchema }),
  z.strictObject({ type: z.literal('back') }),
  z.strictObject({ type: z.literal('forward') }),
  z.strictObject({ type: z.literal('reload') }),
  z.strictObject({ type: z.literal('stop') })
]) satisfies z.ZodType<DesktopBrowserToolbarCommand>
const nativeBrowserInputControlSchema = nativeBrowserPanelSchema.extend({
  locked: z.boolean()
})

type HealthResponse = z.infer<typeof healthResponseSchema>

async function checkHealth(
  origin: string,
  signal: AbortSignal
): Promise<HealthResponse | null> {
  const response = await net
    .fetch(new URL('/api/health', origin).toString(), {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(1_500)])
    })
    .catch(() => null)
  if (!response?.ok) {
    return null
  }

  const body = await response.json().catch(() => null)
  const result = healthResponseSchema.safeParse(body)
  return result.success ? result.data : null
}

async function connectSelected(
  options: {
    unavailableImmediately?: boolean
    unavailableMessage?: string
    url?: string
  } = {}
): Promise<void> {
  const computer = store?.selectedComputer
  const generation = ++connectionGeneration
  connectionAbort?.abort()
  const abortController = new AbortController()
  connectionAbort = abortController
  disposeBrowserWebviews()

  if (!computer) {
    connection = { status: 'empty' }
    broadcastState()
    const renderer = mainWindow?.webContents
    if (renderer && !renderer.getURL().startsWith('treeport-app://')) {
      void renderer.loadURL(PRIVATE_RENDERER_URL).catch((error) => {
        console.error('[Treeport] Could not load desktop renderer', error)
      })
    }

    return
  }

  const currentRendererUrl = mainWindow?.webContents.getURL() ?? ''
  const requestedUrl =
    options.url &&
    URL.canParse(options.url) &&
    new URL(options.url).origin === computer.origin
      ? options.url
      : URL.canParse(currentRendererUrl) &&
          new URL(currentRendererUrl).origin === computer.origin
        ? currentRendererUrl
        : computer.origin
  const unavailableMessage =
    options.unavailableMessage ??
    `The desktop app could not reach ${computer.origin}.`
  let unavailableVisible = options.unavailableImmediately ?? false
  connection = unavailableVisible
    ? {
        status: 'unavailable',
        computerId: computer.id,
        message: unavailableMessage
      }
    : { status: 'connecting', computerId: computer.id }
  broadcastState()
  const renderer = mainWindow?.webContents
  if (renderer && renderer.getURL() !== requestedUrl) {
    void renderer.loadURL(requestedUrl).catch((error) => {
      console.error('[Treeport] Could not load desktop renderer', error)
    })
  }

  const startedAt = Date.now()
  const retryDelays = [0, 250, 500, 1_000, 2_000]
  let attempt = 0
  while (
    !abortController.signal.aborted &&
    generation === connectionGeneration
  ) {
    const retryDelay = retryDelays[Math.min(attempt, retryDelays.length - 1)]!
    if (retryDelay > 0) {
      await delay(retryDelay, undefined, {
        signal: abortController.signal
      }).catch(() => undefined)
    }

    if (abortController.signal.aborted || generation !== connectionGeneration) {
      return
    }

    const health = await checkHealth(computer.origin, abortController.signal)
    if (generation !== connectionGeneration || abortController.signal.aborted) {
      return
    }

    if (!health) {
      attempt += 1
      if (!unavailableVisible && Date.now() - startedAt >= 3_000) {
        unavailableVisible = true
        connection = {
          status: 'unavailable',
          computerId: computer.id,
          message: unavailableMessage
        }
        broadcastState()
      }

      continue
    }

    if (health.hostname && store) {
      await store.rememberHostname(computer.id, health.hostname)
      if (
        generation !== connectionGeneration ||
        abortController.signal.aborted
      ) {
        return
      }
    }

    const serverVersion = health.version
    if (desktopReleaseVersion) {
      const desktopRelease = parseReleaseVersion(desktopReleaseVersion)
      const serverRelease = serverVersion
        ? parseReleaseVersion(serverVersion)
        : null
      const reason =
        !desktopRelease || !serverRelease
          ? 'unknown-version'
          : compareReleaseVersions(
                serverRelease,
                minimumSupportedBackendRelease
              ) < 0
            ? 'backend-outdated'
            : compareReleaseVersions(serverRelease, desktopRelease) > 0
              ? 'desktop-outdated'
              : null
      if (reason) {
        connection = {
          status: 'incompatible',
          computerId: computer.id,
          serverVersion,
          reason
        }
        broadcastState()
        return
      }
    }

    connection = {
      status: 'ready',
      computerId: computer.id,
      serverVersion: serverVersion ?? 'unknown',
      url: requestedUrl
    }
    broadcastState()
    return
  }
}

function rendererWindowPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(dirname, 'preload.js'),
    partition: RENDERER_PARTITION,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: true
  }
}

function installMenu(): void {
  const navigation = navigationState()
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? ([{ role: 'appMenu' }] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          id: 'new-worktree',
          label: 'New tree…',
          accelerator: 'CommandOrControl+N',
          click: () => sendDesktopCommand('new-worktree')
        },
        {
          id: 'new-terminal',
          label: 'New Tab',
          accelerator: 'CommandOrControl+T',
          click: () => sendDesktopCommand('new-terminal')
        },
        {
          id: 'new-panel',
          label: 'New Panel…',
          accelerator: 'CommandOrControl+Shift+T',
          click: () => sendDesktopCommand('new-panel')
        },
        { type: 'separator' },
        {
          id: 'close-panel',
          label: 'Close Panel',
          accelerator: 'CommandOrControl+W',
          click: () => sendDesktopCommand('close-panel')
        },
        ...(process.platform === 'darwin'
          ? []
          : ([
              { type: 'separator' },
              { role: 'quit' }
            ] satisfies MenuItemConstructorOptions[]))
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Navigate',
      submenu: (() => {
        const back: MenuItemConstructorOptions = {
          id: 'navigate-back',
          label: 'Back',
          enabled: navigation.canGoBack,
          click: () => navigateRendererHistory('back')
        }
        const forward: MenuItemConstructorOptions = {
          id: 'navigate-forward',
          label: 'Forward',
          enabled: navigation.canGoForward,
          click: () => navigateRendererHistory('forward')
        }
        if (process.platform === 'darwin') {
          back.accelerator = 'Command+['
          forward.accelerator = 'Command+]'
        }

        return [back, forward]
      })()
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CommandOrControl+R',
          click: () => mainWindow?.webContents.reload()
        },
        {
          label: 'Force Reload',
          accelerator: 'CommandOrControl+Shift+R',
          click: () => mainWindow?.webContents.reloadIgnoringCache()
        },
        {
          label: 'Toggle Developer Tools',
          accelerator:
            process.platform === 'darwin' ? 'Alt+Command+I' : 'Control+Shift+I',
          click: () => mainWindow?.webContents.toggleDevTools()
        },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: () => mainWindow?.webContents.setZoomLevel(0)
        },
        {
          label: 'Zoom In',
          accelerator: 'CommandOrControl+=',
          click: () => {
            const renderer = mainWindow?.webContents
            if (renderer) {
              renderer.setZoomLevel(renderer.getZoomLevel() + 0.5)
            }
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: () => {
            const renderer = mainWindow?.webContents
            if (renderer) {
              renderer.setZoomLevel(renderer.getZoomLevel() - 0.5)
            }
          }
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(url?: string): BrowserWindow {
  const options: BrowserWindowConstructorOptions = {
    show: !desktopE2e,
    width: 1440,
    height: 900,
    minWidth: 320,
    minHeight: 600,
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#09090b',
      symbolColor: '#f4f4f5',
      height: TITLEBAR_HEIGHT
    },
    webPreferences: rendererWindowPreferences()
  }
  if (process.platform === 'darwin') {
    options.trafficLightPosition = { x: 12, y: 9 }
  }

  const window = new BrowserWindow(options)
  mainWindow = window
  installRendererSecurity(window.webContents)
  browserWebviews = installBrowserWebviewPolicy({
    window,
    trustedRenderer: window.webContents,
    selectedComputer: () => {
      const computer = store?.selectedComputer
      return computer
        ? { id: computer.id, loopback: isLoopbackUrl(new URL(computer.origin)) }
        : null
    },
    isTrustedEvent: isTrustedRendererEvent
  })

  window.on('enter-full-screen', () => {
    fullscreen = true
    window.webContents.send('fullscreen-change', true)
    broadcastState()
  })
  window.on('leave-full-screen', () => {
    fullscreen = false
    window.webContents.send('fullscreen-change', false)
    broadcastState()
  })
  window.on('focus', stopBellAttention)
  window.on('close', disposeBrowserWebviews)
  window.on('closed', () => {
    stopBellAttention()
    if (mainWindow === window) {
      mainWindow = null
      browserWebviews = null
    }
  })
  window.webContents.once('did-finish-load', () => broadcastState())
  void connectSelected(url ? { url } : {})
  return window
}

function mutationError(cause: unknown): ComputerMutationResult {
  return {
    ok: false,
    error:
      cause instanceof Error ? cause.message : 'Could not save the computer.'
  }
}

function registerIpc(): void {
  ipcMain.handle('shell:get-state', (event) =>
    isTrustedRendererEvent(event) ? shellState() : null
  )
  ipcMain.handle('shell:select-computer', async (event, id) => {
    const parsedId = z.string().safeParse(id)
    if (!isTrustedRendererEvent(event) || !parsedId.success || !store) {
      return false
    }

    const selected = await store.select(parsedId.data)
    if (selected) {
      void connectSelected()
    }

    return selected
  })
  ipcMain.handle('shell:add-computer', async (event, input) => {
    const parsedInput = z.string().safeParse(input)
    if (!isTrustedRendererEvent(event) || !parsedInput.success || !store) {
      return { ok: false, error: 'Could not save the computer.' }
    }

    let origin: string
    try {
      origin = parseComputerUrl(parsedInput.data).origin
    } catch (error) {
      return mutationError(error)
    }
    const duplicate = store.findByOrigin(origin)
    if (duplicate) {
      return {
        ok: false,
        error: `That URL is already saved as ${store.summaries().find((item) => item.id === duplicate.id)?.name ?? 'a computer'}.`,
        duplicateId: duplicate.id
      }
    }

    try {
      await store.add(origin)
      void connectSelected()
      return { ok: true }
    } catch (error) {
      return mutationError(error)
    }
  })
  ipcMain.handle('shell:update-computer', async (event, value) => {
    if (!isTrustedRendererEvent(event) || !store) {
      return { ok: false, error: 'Could not save the computer.' }
    }

    const parsed = computerUpdateSchema.safeParse(value)
    if (!parsed.success) {
      return { ok: false, error: 'Could not save the computer.' }
    }

    const update: ComputerUpdate = {
      id: parsed.data.id,
      origin: parsed.data.origin
    }
    if (parsed.data.nameOverride !== undefined) {
      update.nameOverride = parsed.data.nameOverride
    }

    try {
      const result = await store.update(update.id, update)
      if (!result) {
        return { ok: false, error: 'That computer no longer exists.' }
      }

      if (result.originChanged && store.selectedComputer?.id === update.id) {
        void connectSelected()
      } else {
        broadcastState()
      }

      return { ok: true }
    } catch (error) {
      return mutationError(error)
    }
  })
  ipcMain.handle('shell:remove-computer', async (event, id) => {
    const parsedId = z.string().safeParse(id)
    if (!isTrustedRendererEvent(event) || !parsedId.success || !store) {
      return false
    }

    const computerId = parsedId.data
    if (!store.getComputer(computerId)) {
      return false
    }

    const result = await store.remove(computerId)
    if (result.selectedChanged) {
      void connectSelected()
    } else {
      broadcastState()
    }

    return true
  })
  ipcMain.on('shell:retry-connection', (event) => {
    if (isTrustedRendererEvent(event)) {
      void connectSelected()
    }
  })
  ipcMain.on('shell:install-update', (event) => {
    if (!isTrustedRendererEvent(event) || !updateReady) {
      return
    }

    if (desktopE2e) {
      updateReady = false
      broadcastState()
      return
    }

    autoUpdater.quitAndInstall()
  })
  ipcMain.on('shell:navigate-history', (event, direction) => {
    const parsed = z.enum(['back', 'forward']).safeParse(direction)
    if (isTrustedRendererEvent(event) && parsed.success) {
      navigateRendererHistory(parsed.data)
    }
  })
  ipcMain.handle('shell:copy-start-command', (event) => {
    if (isTrustedRendererEvent(event)) {
      clipboard.writeText('treeport start')
    }
  })
  ipcMain.handle('shell:copy-update-command', (event) => {
    if (isTrustedRendererEvent(event)) {
      clipboard.writeText('treeport update')
    }
  })
  ipcMain.handle('shell:open-installation-docs', (event) => {
    if (isTrustedRendererEvent(event)) {
      return shell.openExternal(
        'https://treeport.app/getting-started/installation/'
      )
    }
  })

  ipcMain.handle('open-file-url', async (event, value) => {
    if (!isTrustedRendererEvent(event)) {
      return 'rejected'
    }

    const filePath = filePathFromUrl(value)
    const origin = selectedOrigin()
    if (!filePath || !origin) {
      return 'rejected'
    }

    if (!isLoopbackUrl(new URL(origin))) {
      return 'rejected'
    }

    return (await shell.openPath(filePath)) === '' ? 'opened' : 'rejected'
  })
  ipcMain.handle('terminal-file:resolve-source-path', (event, value) => {
    const parsedPath = localSourcePathSchema.safeParse(value)
    return isTrustedRendererEvent(event) && parsedPath.success
      ? resolveLocalSourcePath(selectedOrigin(), parsedPath.data)
      : null
  })
  ipcMain.on('terminal-file:read-clipboard-source-paths', (event) => {
    event.returnValue = []
    if (!isTrustedRendererEvent(event) || process.platform !== 'darwin') {
      return
    }

    // ponytail: This fallback reads one macOS file URL. Parse NSFilenamesPboardType if Electron omits multiple files from ClipboardEvent.
    const filePath = filePathFromUrl(clipboard.read('public.file-url'))
    const parsedPath = localSourcePathSchema.safeParse(filePath)
    const resolvedPath = parsedPath.success
      ? resolveLocalSourcePath(selectedOrigin(), parsedPath.data)
      : null
    event.returnValue = resolvedPath ? [resolvedPath] : []
  })
  ipcMain.handle('native-browser:register', (event, value) => {
    const parsed = nativeBrowserRegisterSchema.safeParse(value)
    return parsed.success && browserWebviews
      ? browserWebviews.register(
          event,
          parsed.data.panelId,
          parsed.data.webContentsId,
          parsed.data.challenge
        )
      : null
  })
  ipcMain.handle('native-browser:command', (event, value) => {
    const parsed = z
      .strictObject({
        panelId: z.string().min(1).max(128),
        command: nativeBrowserCommandSchema
      })
      .safeParse(value)
    return parsed.success && browserWebviews
      ? browserWebviews.command(event, parsed.data.panelId, parsed.data.command)
      : { ok: false, error: 'The Browser command was rejected.' }
  })
  ipcMain.handle('native-browser:set-input-control', (event, value) => {
    const parsed = nativeBrowserInputControlSchema.safeParse(value)
    return parsed.success && browserWebviews
      ? browserWebviews.setInputControl(
          event,
          parsed.data.panelId,
          parsed.data.locked
        )
      : false
  })
  ipcMain.handle('native-browser:request-close', async (event, value) => {
    const parsed = nativeBrowserCloseSchema.safeParse(value)
    if (!parsed.success) {
      return false
    }

    return browserWebviews
      ? browserWebviews.requestClose(
          event,
          parsed.data.panelId,
          parsed.data.force
        )
      : true
  })
  ipcMain.on('native-browser:dispose', (event, value) => {
    const parsed = nativeBrowserPanelSchema.safeParse(value)
    if (!parsed.success) {
      return
    }

    browserWebviews?.dispose(event, parsed.data.panelId)
  })
  ipcMain.on('terminal-selection:set-active', (event, active) => {
    const parsedActive = z.boolean().safeParse(active)
    if (!isTrustedRendererEvent(event) || !parsedActive.success) {
      return
    }

    setTerminalSelectionActive(parsedActive.data)
  })
  ipcMain.on('shell:terminal-selection-release', (event) => {
    if (isTrustedRendererEvent(event)) {
      releaseTerminalSelection()
    }
  })
  ipcMain.on('bell-attention:request', (event) => {
    if (isTrustedRendererEvent(event)) {
      requestBellAttention()
    }
  })
}

async function openWorkspaceTarget(target: WorkspaceTarget): Promise<void> {
  const currentStore = store
  if (!currentStore) {
    pendingWorkspaceTarget = target
    return
  }

  const existing = currentStore.findByOrigin(target.origin)
  if (existing) {
    await currentStore.select(existing.id)
  } else {
    await currentStore.add(target.origin)
  }

  const existingWindow = mainWindow
  const window = existingWindow ?? createWindow(target.url)

  if (existingWindow) {
    void connectSelected({ url: target.url })
  }

  if (!desktopE2e) {
    if (window.isMinimized()) {
      window.restore()
    }

    window.show()
    window.focus()
  }
}

function queueWorkspaceTarget(target: WorkspaceTarget): void {
  if (!store) {
    pendingWorkspaceTarget = target
    return
  }

  workspaceTargetQueue = workspaceTargetQueue
    .then(() => openWorkspaceTarget(target))
    .catch((error) => {
      console.error('[Treeport] Could not open workspace link', error)
    })
}

function receiveWorkspaceLink(
  value: Parameters<typeof parseWorkspaceLink>[0]
): boolean {
  const target = parseWorkspaceLink(value)
  if (!target) {
    return false
  }

  queueWorkspaceTarget(target)
  return true
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  receiveWorkspaceLink(url)
})
for (const argument of process.argv) {
  const target = parseWorkspaceLink(argument)
  if (target) {
    pendingWorkspaceTarget = target
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (commandLine.some((argument) => receiveWorkspaceLink(argument))) {
      return
    }

    const window = mainWindow ?? createWindow()
    if (!desktopE2e) {
      if (window.isMinimized()) {
        window.restore()
      }

      window.show()
      window.focus()
    }
  })

  registerIpc()
  void app
    .whenReady()
    .then(async () => {
      await installRendererRequestRouting()
      store = await ComputerStore.load(
        path.join(app.getPath('userData'), 'computers.json'),
        seedComputerUrl,
        { synchronizeSelectedLoopback: !app.isPackaged }
      )
      installMenu()
      const startupTarget = pendingWorkspaceTarget
      pendingWorkspaceTarget = null
      if (startupTarget) {
        await openWorkspaceTarget(startupTarget)
      } else {
        createWindow()
      }

      if (app.isPackaged && process.platform === 'darwin' && !desktopE2e) {
        autoUpdater.on('update-downloaded', () => {
          updateReady = true
          broadcastState()
        })
        const updater = updateElectronApp({
          updateSource: {
            type: UpdateSourceType.ElectronPublicUpdateService,
            repo: 'noice-tech/treeport',
            host: 'https://update.electronjs.org'
          },
          updateInterval: '10 minutes',
          notifyUser: false
        })
        stopAutomaticUpdates = updater.stopUpdates
      }

      app.on('activate', () => {
        if (!mainWindow) {
          createWindow()
        }
      })
    })
    .catch((error) => {
      console.error('[Treeport] Could not start desktop app', error)
      app.quit()
    })

  app.on('before-quit', () => {
    stopAutomaticUpdates?.()
    connectionAbort?.abort()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
