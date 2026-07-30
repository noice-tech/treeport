import path from 'node:path'
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
import { ComputerStore } from './computer-store.js'
import type {
  ComputerMutationResult,
  ComputerUpdate,
  ConnectionState,
  DesktopCommand,
  DesktopShellState
} from './desktop-contract.js'
import { filePathFromUrl } from './file-url.js'
import { isLoopbackUrl, parseComputerUrl } from './renderer-url.js'

const dirname = __dirname
const TITLEBAR_HEIGHT = 32
const developmentUserData = process.env.TREEPORT_DESKTOP_USER_DATA?.trim()
if (app.isPackaged) {
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
const shellWebContentsIds = new Set<number>()

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

function shellState(): DesktopShellState {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    fullscreen,
    ...(store?.selectedComputer
      ? { selectedComputerId: store.selectedComputer.id }
      : {}),
    computers: store?.summaries() ?? [],
    connection
  }
}

function broadcastState(): void {
  const state = shellState()
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
  if (guest && !guest.isDestroyed()) {
    guest.close({ waitForBeforeUnload: false })
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
    const commandModifier =
      process.platform === 'darwin' ? input.meta : input.control
    const command = {
      n: 'new-worktree',
      t: 'new-terminal',
      w: 'close-terminal'
    }[input.key.toLowerCase()] as DesktopCommand | undefined
    if (
      input.type !== 'keyDown' ||
      input.isAutoRepeat ||
      !commandModifier ||
      input.alt ||
      input.shift ||
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
  guest.on('focus', () =>
    mainWindow?.webContents.send('shell:selector-dismiss')
  )
  guest.on('did-finish-load', () => {
    guest.send('fullscreen-change', fullscreen)
  })
  const showGuestFailure = () => {
    if (activeGuest !== guest || connection.status !== 'ready') {
      return
    }

    activeGuest = null
    connection = {
      status: 'unavailable',
      computerId: connection.computerId,
      message: `The connection to ${origin} was lost.`
    }
    broadcastState()
  }
  guest.on(
    'did-fail-load',
    (_event, _errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame) {
        showGuestFailure()
      }
    }
  )
  guest.on('render-process-gone', showGuestFailure)
}

interface HealthResponse {
  ok: true
  version: string
  protocolVersion: number
  hostname?: string
}

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
  if (
    typeof body !== 'object' ||
    body === null ||
    !('ok' in body) ||
    body.ok !== true ||
    !('version' in body) ||
    typeof body.version !== 'string' ||
    !('protocolVersion' in body) ||
    typeof body.protocolVersion !== 'number' ||
    ('hostname' in body && typeof body.hostname !== 'string')
  ) {
    return null
  }

  return body as HealthResponse
}

async function connectSelected(): Promise<void> {
  const computer = store?.selectedComputer
  const generation = ++connectionGeneration
  connectionAbort?.abort()
  connectionAbort = new AbortController()
  disposeGuest()

  if (!computer) {
    connection = { status: 'empty' }
    broadcastState()
    return
  }

  connection = { status: 'connecting', computerId: computer.id }
  broadcastState()
  const delays = [0, 250, 500, 1_000, 2_000]
  let health: HealthResponse | null = null
  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    if (connectionAbort.signal.aborted || generation !== connectionGeneration) {
      return
    }

    health = await checkHealth(computer.origin, connectionAbort.signal)
    if (health) {
      break
    }
  }

  if (generation !== connectionGeneration || connectionAbort.signal.aborted) {
    return
  }

  if (!health) {
    connection = {
      status: 'unavailable',
      computerId: computer.id,
      message: `The desktop app could not reach ${computer.origin}.`
    }
    broadcastState()
    return
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

  if (health.hostname) {
    await store?.rememberHostname(computer.id, health.hostname)
    broadcastState()
  }

  connection = {
    status: 'ready',
    computerId: computer.id,
    serverVersion: health.version
  }
  broadcastState()
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
        { type: 'separator' },
        {
          id: 'close-terminal',
          label: 'Close Terminal',
          accelerator: 'CommandOrControl+W',
          click: () => sendDesktopCommand('close-terminal')
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

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    show: process.env.TREEPORT_DESKTOP_E2E !== '1',
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
      if (activeGuest === guest) {
        activeGuest = null
      }
    })
    installGuestSecurity(guest, origin)
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
  window.on('blur', () => window.webContents.send('shell:selector-dismiss'))
  window.on('close', disposeGuest)
  window.on('closed', () => {
    stopBellAttention()
    if (mainWindow === window) {
      mainWindow = null
    }
  })
  window.webContents.once('did-finish-load', () => broadcastState())
  void connectSelected()
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
      broadcastState()
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
      broadcastState()
      void connectSelected()
      return { ok: true }
    } catch (error) {
      return mutationError(error)
    }
  })
  ipcMain.handle('shell:update-computer', async (event, update: unknown) => {
    if (
      !isAuthorizedShellEvent(event) ||
      !store ||
      typeof update !== 'object' ||
      update === null ||
      !('id' in update) ||
      typeof update.id !== 'string' ||
      !('origin' in update) ||
      typeof update.origin !== 'string' ||
      ('nameOverride' in update && typeof update.nameOverride !== 'string')
    ) {
      return { ok: false, error: 'Could not save the computer.' }
    }

    try {
      const result = await store.update(update.id, update as ComputerUpdate)
      if (!result) {
        return { ok: false, error: 'That computer no longer exists.' }
      }

      broadcastState()
      if (result.originChanged && store.selectedComputer?.id === update.id) {
        void connectSelected()
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
    broadcastState()
    if (result.selectedChanged) {
      void connectSelected()
    }

    return true
  })
  ipcMain.on('shell:retry-connection', (event) => {
    if (isAuthorizedShellEvent(event)) {
      void connectSelected()
    }
  })
  ipcMain.handle('shell:copy-start-command', (event) => {
    if (isAuthorizedShellEvent(event)) {
      clipboard.writeText('treeport up')
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

    if (isLoopbackUrl(new URL(origin))) {
      return (await shell.openPath(filePath)) === '' ? 'opened' : 'rejected'
    }

    clipboard.writeText(filePath)
    return 'copied'
  })
  ipcMain.on('bell-attention:request', (event) => {
    if (isActiveGuestEvent(event)) {
      requestBellAttention()
    }
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = mainWindow ?? createWindow()
    if (window.isMinimized()) {
      window.restore()
    }

    window.focus()
  })

  registerIpc()
  void app.whenReady().then(async () => {
    store = await ComputerStore.load(
      path.join(app.getPath('userData'), 'computers.json'),
      seedComputerUrl
    )
    installMenu()
    createWindow()
    app.on('activate', () => {
      if (!mainWindow) {
        createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
