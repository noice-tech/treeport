import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { DESKTOP_PROTOCOL_VERSION } from '@treeport/shared'
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  shell,
  webContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import {
  makeUserNotifier,
  updateElectronApp,
  UpdateSourceType
} from 'update-electron-app'
import { z } from 'zod'
import { ComputerStore } from './computer-store'
import type {
  ComputerMutationResult,
  ComputerUpdate,
  ConnectionState,
  DesktopCommand,
  DesktopNavigationDirection,
  DesktopNavigationState,
  DesktopShellState
} from './desktop-contract'
import { filePathFromUrl } from './file-url'
import { isLoopbackUrl, parseComputerUrl } from './renderer-url'
import { parseWorkspaceLink, type WorkspaceTarget } from './workspace-link'

const dirname = __dirname
const TITLEBAR_HEIGHT = 32
const desktopE2e = process.env.TREEPORT_DESKTOP_E2E === '1'
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
let activeGuest: WebContents | null = null
let store: ComputerStore | null = null
let connection: ConnectionState = { status: 'empty' }
let connectionGeneration = 0
let connectionAbort: AbortController | null = null
let fullscreen = false
let stopAutomaticUpdates: (() => void) | null = null
let pendingWorkspaceTarget: WorkspaceTarget | null = null
let workspaceTargetQueue: Promise<void> = Promise.resolve()
const shellWebContentsIds = new Set<number>()
let terminalSelectionGuest: WebContents | null = null

let dockBounceId: number | null = null
let frameFlashing = false

function shellUrl(): string {
  if (
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined' &&
    MAIN_WINDOW_VITE_DEV_SERVER_URL
  ) {
    return MAIN_WINDOW_VITE_DEV_SERVER_URL
  }

  return pathToFileURL(
    path.join(dirname, '../renderer/main_window/index.html')
  ).toString()
}

function navigationState(): DesktopNavigationState {
  const guest = activeGuest
  if (!guest || guest.isDestroyed() || connection.status !== 'ready') {
    return { canGoBack: false, canGoForward: false }
  }

  // Electron's canGoBack/canGoForward omit same-document pushState entries.
  // Relative offsets include the TanStack Router locations in the guest.
  return {
    canGoBack: guest.navigationHistory.canGoToOffset(-1),
    canGoForward: guest.navigationHistory.canGoToOffset(1)
  }
}

function shellState(): DesktopShellState {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    fullscreen,
    ...(store?.selectedComputer
      ? { selectedComputerId: store.selectedComputer.id }
      : {}),
    computers: store?.summaries() ?? [],
    connection,
    navigation: navigationState()
  }
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

  for (const id of [...shellWebContentsIds]) {
    const contents = webContents.fromId(id)
    if (!contents || contents.isDestroyed()) {
      shellWebContentsIds.delete(id)
      continue
    }

    contents.send('shell:state', state)
  }
}

function isAuthorizedShellEvent(
  event: IpcMainEvent | IpcMainInvokeEvent
): boolean {
  return (
    shellWebContentsIds.has(event.sender.id) &&
    event.senderFrame === event.sender.mainFrame
  )
}

function selectedOrigin(): string | null {
  return store?.selectedComputer?.origin ?? null
}

function isActiveGuestEvent(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const origin = selectedOrigin()
  return Boolean(
    activeGuest &&
    origin &&
    event.sender === activeGuest &&
    event.senderFrame === event.sender.mainFrame &&
    URL.canParse(event.senderFrame.url) &&
    new URL(event.senderFrame.url).origin === origin
  )
}

function setTerminalSelectionGuest(guest: WebContents | null): void {
  terminalSelectionGuest = guest
  for (const id of [...shellWebContentsIds]) {
    const contents = webContents.fromId(id)
    if (!contents || contents.isDestroyed()) {
      shellWebContentsIds.delete(id)
      continue
    }

    contents.send('terminal-selection:active', guest !== null)
  }
}

function releaseTerminalSelection(): void {
  const guest = terminalSelectionGuest
  setTerminalSelectionGuest(null)
  if (guest && !guest.isDestroyed()) {
    guest.send('terminal-selection:release')
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

function disposeGuest(): void {
  const guest = activeGuest
  activeGuest = null
  if (terminalSelectionGuest === guest) {
    setTerminalSelectionGuest(null)
  }

  if (guest && !guest.isDestroyed()) {
    guest.close({ waitForBeforeUnload: false })
  }

  broadcastState()
}

function navigateGuestHistory(direction: DesktopNavigationDirection): void {
  const guest = activeGuest
  if (!guest || guest.isDestroyed() || connection.status !== 'ready') {
    return
  }

  const offset = direction === 'back' ? -1 : 1
  if (guest.navigationHistory.canGoToOffset(offset)) {
    guest.navigationHistory.goToOffset(offset)
  }
}

function sendDesktopCommand(command: DesktopCommand): void {
  if (
    !mainWindow ||
    !activeGuest ||
    connection.status !== 'ready' ||
    !mainWindow.isFocused()
  ) {
    return
  }

  activeGuest.send('desktop-command', command)
}

function installGuestSecurity(guest: WebContents, origin: string): void {
  guest.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
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
      navigateGuestHistory(key === '[' ? 'back' : 'forward')
      return
    }

    const commandModifier =
      process.platform === 'darwin' ? input.meta : input.control
    const command: DesktopCommand | undefined = input.shift
      ? key === 't'
        ? 'new-panel'
        : undefined
      : key === 'n'
        ? 'new-worktree'
        : key === 't'
          ? 'new-terminal'
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
    guest.send('desktop-command', command)
  })

  guest.on('will-navigate', (event, targetUrl) => {
    if (URL.canParse(targetUrl) && new URL(targetUrl).origin === origin) {
      return
    }

    event.preventDefault()
    if (URL.canParse(targetUrl)) {
      const protocol = new URL(targetUrl).protocol
      if (protocol === 'http:' || protocol === 'https:') {
        void shell.openExternal(targetUrl)
      }
    }
  })
  guest.setWindowOpenHandler(({ url }) => {
    if (URL.canParse(url)) {
      const protocol = new URL(url).protocol
      if (protocol === 'http:' || protocol === 'https:') {
        void shell.openExternal(url)
      }
    }

    return { action: 'deny' }
  })
  guest.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false)
  )
  const refreshNavigationState = () => {
    if (activeGuest === guest) {
      broadcastState()
    }
  }
  guest.on('did-navigate', refreshNavigationState)
  guest.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) {
      refreshNavigationState()
    }
  })
  guest.on('did-finish-load', () => {
    guest.send('fullscreen-change', fullscreen)
    refreshNavigationState()
  })
  const showGuestFailure = () => {
    if (activeGuest !== guest || connection.status !== 'ready') {
      return
    }

    void connectSelected({
      unavailableImmediately: true,
      unavailableMessage: `The connection to ${origin} was lost.`
    })
  }
  guest.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        showGuestFailure()
      }
    }
  )
  guest.on('render-process-gone', showGuestFailure)
}

const healthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  protocolVersion: z.number(),
  hostname: z.string().optional()
})

const computerUpdateSchema = z.object({
  id: z.string(),
  origin: z.string(),
  nameOverride: z.string().optional()
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
  disposeGuest()

  if (!computer) {
    connection = { status: 'empty' }
    broadcastState()
    return
  }

  const requestedUrl =
    options.url &&
    URL.canParse(options.url) &&
    new URL(options.url).origin === computer.origin
      ? options.url
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

    if (health.protocolVersion !== DESKTOP_PROTOCOL_VERSION) {
      connection = {
        status: 'incompatible',
        computerId: computer.id,
        serverVersion: health.version,
        receivedProtocolVersion: health.protocolVersion,
        expectedProtocolVersion: DESKTOP_PROTOCOL_VERSION
      }
      broadcastState()
      return
    }

    if (health.hostname && store) {
      await store.rememberHostname(computer.id, health.hostname)
      if (
        generation !== connectionGeneration ||
        abortController.signal.aborted
      ) {
        return
      }

      broadcastState()
    }

    connection = {
      status: 'ready',
      computerId: computer.id,
      serverVersion: health.version,
      url: requestedUrl
    }
    broadcastState()
    return
  }
}

function shellWindowPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(dirname, 'shell-preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: true
  }
}

function authorizeShellContents(contents: WebContents): void {
  shellWebContentsIds.add(contents.id)
  contents.on('destroyed', () => {
    shellWebContentsIds.delete(contents.id)
  })
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function loadShellContents(contents: WebContents): Promise<void> {
  authorizeShellContents(contents)
  return contents.loadURL(shellUrl())
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
          label: 'New Worktree…',
          accelerator: 'CommandOrControl+N',
          click: () => sendDesktopCommand('new-worktree')
        },
        {
          id: 'new-terminal',
          label: 'New Terminal',
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
      submenu: [
        {
          id: 'navigate-back',
          label: 'Back',
          ...(process.platform === 'darwin'
            ? { accelerator: 'Command+[' }
            : {}),
          enabled: navigation.canGoBack,
          click: () => navigateGuestHistory('back')
        },
        {
          id: 'navigate-forward',
          label: 'Forward',
          ...(process.platform === 'darwin'
            ? { accelerator: 'Command+]' }
            : {}),
          enabled: navigation.canGoForward,
          click: () => navigateGuestHistory('forward')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CommandOrControl+R',
          click: () => activeGuest?.reload()
        },
        {
          label: 'Force Reload',
          accelerator: 'CommandOrControl+Shift+R',
          click: () => activeGuest?.reloadIgnoringCache()
        },
        {
          label: 'Toggle Developer Tools',
          accelerator:
            process.platform === 'darwin' ? 'Alt+Command+I' : 'Control+Shift+I',
          click: () => activeGuest?.toggleDevTools()
        },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: () => activeGuest?.setZoomLevel(0)
        },
        {
          label: 'Zoom In',
          accelerator: 'CommandOrControl+=',
          click: () => {
            if (activeGuest) {
              activeGuest.setZoomLevel(activeGuest.getZoomLevel() + 0.5)
            }
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: () => {
            if (activeGuest) {
              activeGuest.setZoomLevel(activeGuest.getZoomLevel() - 0.5)
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
  const window = new BrowserWindow({
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
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 9 } }
      : {}),
    webPreferences: shellWindowPreferences()
  })
  mainWindow = window
  window.webContents.on(
    'will-attach-webview',
    (event, webPreferences, params) => {
      const origin = selectedOrigin()
      if (
        connection.status !== 'ready' ||
        !origin ||
        typeof params.src !== 'string' ||
        !URL.canParse(params.src) ||
        new URL(params.src).origin !== origin
      ) {
        event.preventDefault()
        return
      }

      webPreferences.preload = path.join(dirname, 'preload.js')
      webPreferences.partition = 'persist:treeport-desktop'
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
    }
  )
  window.webContents.on('did-attach-webview', (_event, guest) => {
    const origin = selectedOrigin()
    if (!origin || connection.status !== 'ready') {
      guest.close({ waitForBeforeUnload: false })
      return
    }

    disposeGuest()
    activeGuest = guest
    guest.once('destroyed', () => {
      if (terminalSelectionGuest === guest) {
        setTerminalSelectionGuest(null)
      }

      if (activeGuest === guest) {
        activeGuest = null
        broadcastState()
      }
    })
    installGuestSecurity(guest, origin)
    broadcastState()
  })
  void loadShellContents(window.webContents).catch((error: unknown) => {
    console.error('[Treeport] Could not load desktop shell', error)
  })

  window.on('enter-full-screen', () => {
    fullscreen = true
    activeGuest?.send('fullscreen-change', true)
    broadcastState()
  })
  window.on('leave-full-screen', () => {
    fullscreen = false
    activeGuest?.send('fullscreen-change', false)
    broadcastState()
  })
  window.on('focus', stopBellAttention)
  window.on('close', disposeGuest)
  window.on('closed', () => {
    stopBellAttention()
    if (mainWindow === window) {
      mainWindow = null
    }
  })
  window.webContents.once('did-finish-load', () => broadcastState())
  void connectSelected(url ? { url } : {})
  return window
}

function mutationError(error: unknown): ComputerMutationResult {
  return {
    ok: false,
    error:
      error instanceof Error ? error.message : 'Could not save the computer.'
  }
}

function registerIpc(): void {
  ipcMain.handle('shell:get-state', (event) =>
    isAuthorizedShellEvent(event) ? shellState() : null
  )
  ipcMain.handle('shell:select-computer', async (event, id: unknown) => {
    if (!isAuthorizedShellEvent(event) || typeof id !== 'string' || !store) {
      return false
    }

    const selected = await store.select(id)
    if (selected) {
      void connectSelected()
    }

    return selected
  })
  ipcMain.handle('shell:add-computer', async (event, input: unknown) => {
    if (!isAuthorizedShellEvent(event) || typeof input !== 'string' || !store) {
      return { ok: false, error: 'Could not save the computer.' }
    }

    let origin: string
    try {
      origin = parseComputerUrl(input).origin
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
  ipcMain.handle('shell:update-computer', async (event, value: unknown) => {
    if (!isAuthorizedShellEvent(event) || !store) {
      return { ok: false, error: 'Could not save the computer.' }
    }

    const parsed = computerUpdateSchema.safeParse(value)
    if (!parsed.success) {
      return { ok: false, error: 'Could not save the computer.' }
    }

    const update: ComputerUpdate = {
      id: parsed.data.id,
      origin: parsed.data.origin,
      ...(parsed.data.nameOverride !== undefined
        ? { nameOverride: parsed.data.nameOverride }
        : {})
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
  ipcMain.handle('shell:remove-computer', async (event, id: unknown) => {
    if (!isAuthorizedShellEvent(event) || typeof id !== 'string' || !store) {
      return false
    }

    if (!store.getComputer(id)) {
      return false
    }

    const result = await store.remove(id)
    if (result.selectedChanged) {
      void connectSelected()
    } else {
      broadcastState()
    }

    return true
  })
  ipcMain.on('shell:retry-connection', (event) => {
    if (isAuthorizedShellEvent(event)) {
      void connectSelected()
    }
  })
  ipcMain.on('shell:navigate-history', (event, direction: unknown) => {
    if (
      isAuthorizedShellEvent(event) &&
      (direction === 'back' || direction === 'forward')
    ) {
      navigateGuestHistory(direction)
    }
  })
  ipcMain.handle('shell:copy-start-command', (event) => {
    if (isAuthorizedShellEvent(event)) {
      clipboard.writeText('treeport start')
    }
  })
  ipcMain.handle('shell:open-installation-docs', (event) => {
    if (isAuthorizedShellEvent(event)) {
      return shell.openExternal(
        'https://treeport.app/getting-started/installation/'
      )
    }
  })

  ipcMain.handle('open-file-url', async (event, value: unknown) => {
    if (!isActiveGuestEvent(event)) {
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
  ipcMain.on('terminal-selection:set-active', (event, active: unknown) => {
    if (!isActiveGuestEvent(event) || typeof active !== 'boolean') {
      return
    }

    if (active) {
      setTerminalSelectionGuest(event.sender)
    } else if (terminalSelectionGuest === event.sender) {
      setTerminalSelectionGuest(null)
    }
  })
  ipcMain.on('shell:terminal-selection-release', (event) => {
    if (shellWebContentsIds.has(event.sender.id)) {
      releaseTerminalSelection()
    }
  })
  ipcMain.on('bell-attention:request', (event) => {
    if (isActiveGuestEvent(event)) {
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
    .catch((error: unknown) => {
      console.error('[Treeport] Could not open workspace link', error)
    })
}

function receiveWorkspaceLink(value: unknown): boolean {
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
        const updater = updateElectronApp({
          updateSource: {
            type: UpdateSourceType.ElectronPublicUpdateService,
            repo: 'noice-tech/treeport',
            host: 'https://update.electronjs.org'
          },
          updateInterval: '10 minutes',
          notifyUser: true,
          onNotifyUser: makeUserNotifier({
            title: 'Treeport Update Ready',
            detail:
              'Restart Treeport to update the desktop client. Your selected local or remote backend is not changed.',
            restartButtonText: 'Restart Treeport',
            laterButtonText: 'Later'
          })
        })
        stopAutomaticUpdates = updater.stopUpdates
      }

      app.on('activate', () => {
        if (!mainWindow) {
          createWindow()
        }
      })
    })
    .catch((error: unknown) => {
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
