import path from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  shell,
  type IpcMainEvent,
  type MenuItemConstructorOptions
} from 'electron'
import { filePathFromUrl } from './file-url.js'

const dirname = __dirname
const defaultRendererUrl = app.isPackaged
  ? 'http://127.0.0.1:4780'
  : 'http://127.0.0.1:5173'
const configuredRendererUrl =
  process.env.TASKTTY_DESKTOP_URL?.trim() || defaultRendererUrl

if (!URL.canParse(configuredRendererUrl)) {
  throw new Error('TASKTTY_DESKTOP_URL must be a valid loopback HTTP URL')
}

const rendererUrl = new URL(configuredRendererUrl)
if (
  rendererUrl.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(rendererUrl.hostname)
) {
  throw new Error('TASKTTY_DESKTOP_URL must use HTTP on a loopback host')
}

rendererUrl.pathname = '/'
rendererUrl.search = ''
rendererUrl.hash = ''
const rendererOrigin = rendererUrl.origin
let mainWindow: BrowserWindow | null = null
let loadGeneration = 0

type BellNotificationRequest = {
  terminalId: string
  sequence: number
  title: string
  projectName: string
  worktreeName: string
}
type BellNotificationAction = {
  type: 'view' | 'dismiss'
  terminalId: string
  sequence: number
}
type BellNotificationEntry =
  | {
      sequence: number
      mode: 'native'
      notification: Notification
    }
  | {
      sequence: number
      mode: 'fallback'
    }

const bellNotifications = new Map<string, BellNotificationEntry>()
let dockBounceId: number | null = null
let frameFlashing = false

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

function clearBellNotifications(): void {
  for (const entry of bellNotifications.values()) {
    if (entry.mode === 'native') {
      entry.notification.close()
    }
  }
  bellNotifications.clear()
  stopBellAttention()
}

function isTrustedRendererEvent(event: IpcMainEvent): boolean {
  return Boolean(
    mainWindow &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame &&
    isRendererUrl(event.senderFrame.url)
  )
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expectedKeys: string[]
): boolean {
  const keys = Object.keys(value).sort()
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  )
}

function isBoundedString(
  value: unknown,
  maximumLength: number
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  )
}

function parseBellNotificationRequest(
  value: unknown
): BellNotificationRequest | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const request = value as Record<string, unknown>
  if (
    !hasOnlyKeys(request, [
      'projectName',
      'sequence',
      'terminalId',
      'title',
      'worktreeName'
    ]) ||
    !isBoundedString(request.terminalId, 128) ||
    !Number.isSafeInteger(request.sequence) ||
    (request.sequence as number) <= 0 ||
    !isBoundedString(request.title, 256) ||
    !isBoundedString(request.projectName, 256) ||
    !isBoundedString(request.worktreeName, 256)
  ) {
    return null
  }

  return request as BellNotificationRequest
}

function parseBellNotificationClear(
  value: unknown
): Pick<BellNotificationRequest, 'terminalId' | 'sequence'> | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const request = value as Record<string, unknown>
  if (
    !hasOnlyKeys(request, ['sequence', 'terminalId']) ||
    !isBoundedString(request.terminalId, 128) ||
    !Number.isSafeInteger(request.sequence) ||
    (request.sequence as number) <= 0
  ) {
    return null
  }

  return request as Pick<BellNotificationRequest, 'terminalId' | 'sequence'>
}

function sendBellNotificationPresentation(
  channel: 'bell-notification:fallback' | 'bell-notification:native',
  notification: Pick<BellNotificationRequest, 'terminalId' | 'sequence'>
): void {
  const window = mainWindow
  if (!window || !isRendererUrl(window.webContents.getURL())) {
    return
  }

  window.webContents.send(channel, {
    terminalId: notification.terminalId,
    sequence: notification.sequence
  })
  if (channel === 'bell-notification:fallback') {
    requestBellAttention()
  }
}

function sendBellNotificationAction(action: BellNotificationAction): void {
  const window = mainWindow
  if (!window || !isRendererUrl(window.webContents.getURL())) {
    return
  }

  if (action.type === 'view') {
    if (window.isMinimized()) {
      window.restore()
    }

    if (!window.isVisible()) {
      window.show()
    }

    app.focus({ steal: true })
    window.focus()
  }

  window.webContents.send('bell-notification:action', action)
}

function isRendererUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).origin === rendererOrigin
}

function connectionPage(message: string): string {
  const escapedUrl = rendererOrigin
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
  const escapedMessage = message
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TaskTTY unavailable</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #09090b; color: #f4f4f5; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; }
    .titlebar { position: fixed; inset: 0 0 auto; height: 32px; -webkit-app-region: drag; }
    main { width: min(32rem, calc(100vw - 3rem)); }
    p { color: #a1a1aa; line-height: 1.6; }
    code { color: #a5f3fc; }
    button { border: 1px solid #3f3f46; border-radius: .5rem; padding: .65rem 1rem; background: #27272a; color: #fafafa; font: inherit; cursor: pointer; }
    button:hover { background: #3f3f46; }
  </style>
</head>
<body>
  <div class="titlebar" aria-hidden="true"></div>
  <main>
    <h1>TaskTTY is unavailable</h1>
    <p>${escapedMessage}</p>
    <p>Start the TaskTTY daemon, then reconnect to <code>${escapedUrl}</code>.</p>
    <button type="button" data-tasktty-retry>Retry connection</button>
  </main>
</body>
</html>`
}

const connectionPageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
  connectionPage(
    'The desktop companion could not reach a compatible TaskTTY server.'
  )
)}`

async function rendererIsReady(): Promise<boolean> {
  const response = await fetch(new URL('/api/health', rendererUrl), {
    signal: AbortSignal.timeout(1_500)
  }).catch(() => null)
  if (!response?.ok) {
    return false
  }

  const body = await response.json().catch(() => null)
  return (
    typeof body === 'object' &&
    body !== null &&
    'ok' in body &&
    body.ok === true &&
    'version' in body &&
    body.version === 1
  )
}

async function loadTaskTTY(window: BrowserWindow): Promise<void> {
  const generation = ++loadGeneration
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (window.isDestroyed() || generation !== loadGeneration) {
      return
    }

    if (await rendererIsReady()) {
      const loaded = await window.loadURL(rendererUrl.toString()).then(
        () => true,
        () => false
      )
      if (loaded) {
        return
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  if (window.isDestroyed() || generation !== loadGeneration) {
    return
  }

  await window.loadURL(connectionPageUrl).catch(() => undefined)
}

function sendDesktopCommand(
  command: 'new-worktree' | 'new-terminal' | 'close-terminal'
): void {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  if (!focusedWindow || !isRendererUrl(focusedWindow.webContents.getURL())) {
    return
  }

  focusedWindow.webContents.send('desktop-command', command)
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
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
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
      height: 32
    },
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 9 } }
      : {}),
    webPreferences: {
      preload: path.join(dirname, 'preload.js'),
      partition: 'tasktty-desktop',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  mainWindow = window

  window.on('enter-full-screen', () => {
    window.webContents.send('fullscreen-change', true)
  })
  window.on('leave-full-screen', () => {
    window.webContents.send('fullscreen-change', false)
  })
  window.webContents.on('before-input-event', (event, input) => {
    const commandModifier =
      process.platform === 'darwin' ? input.meta : input.control
    const command = {
      n: 'new-worktree',
      t: 'new-terminal',
      w: 'close-terminal'
    }[input.key.toLowerCase()] as
      | 'new-worktree'
      | 'new-terminal'
      | 'close-terminal'
      | undefined
    if (
      input.type !== 'keyDown' ||
      input.isAutoRepeat ||
      !commandModifier ||
      input.alt ||
      input.shift ||
      !command ||
      !isRendererUrl(window.webContents.getURL())
    ) {
      return
    }

    event.preventDefault()
    window.webContents.send('desktop-command', command)
  })
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (isRendererUrl(targetUrl)) {
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (URL.canParse(url)) {
      const protocol = new URL(url).protocol
      if (protocol === 'http:' || protocol === 'https:') {
        void shell.openExternal(url)
      }
    }

    return { action: 'deny' }
  })
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  )
  window.webContents.on(
    'did-start-navigation',
    (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        clearBellNotifications()
      }
    }
  )
  window.webContents.on('render-process-gone', clearBellNotifications)
  window.on('focus', stopBellAttention)
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
      clearBellNotifications()
    }
  })
  void loadTaskTTY(window)
  return window
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

  ipcMain.on('retry-connection', (event) => {
    if (
      mainWindow &&
      event.sender === mainWindow.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      event.senderFrame.url === connectionPageUrl
    ) {
      void loadTaskTTY(mainWindow)
    }
  })
  ipcMain.handle('open-file-url', async (event, value: unknown) => {
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !isRendererUrl(event.senderFrame.url)
    ) {
      return false
    }

    const filePath = filePathFromUrl(value)
    return filePath ? (await shell.openPath(filePath)) === '' : false
  })

  ipcMain.on('bell-notification:show', (event, value: unknown) => {
    if (!isTrustedRendererEvent(event)) {
      return
    }

    const request = parseBellNotificationRequest(value)
    if (!request) {
      return
    }

    const previous = bellNotifications.get(request.terminalId)
    if (previous && previous.sequence > request.sequence) {
      return
    }

    if (previous?.mode === 'native') {
      previous.notification.close()
    }

    if (!app.isPackaged || !Notification.isSupported()) {
      const entry = { sequence: request.sequence, mode: 'fallback' as const }
      bellNotifications.set(request.terminalId, entry)
      sendBellNotificationPresentation('bell-notification:fallback', request)
      return
    }

    const notification = new Notification({
      title: request.title,
      body: `Terminal bell · ${request.projectName} · ${request.worktreeName}`,
      silent: previous !== undefined,
      ...(process.platform === 'linux'
        ? {}
        : {
            actions: [
              { type: 'button', text: 'View' },
              { type: 'button', text: 'Dismiss' }
            ]
          })
    })
    const entry = {
      sequence: request.sequence,
      mode: 'native' as const,
      notification
    }
    bellNotifications.set(request.terminalId, entry)

    if (
      ![...bellNotifications.values()].some(
        (candidate) => candidate.mode === 'fallback'
      )
    ) {
      stopBellAttention()
    }

    sendBellNotificationPresentation('bell-notification:native', request)
    const activate = (type: BellNotificationAction['type']) => {
      if (bellNotifications.get(request.terminalId) !== entry) {
        return
      }

      bellNotifications.delete(request.terminalId)
      notification.close()
      sendBellNotificationAction({
        type,
        terminalId: request.terminalId,
        sequence: request.sequence
      })
    }
    notification.on('click', () => activate('view'))
    notification.on('action', (_event, index) => {
      if (index === 0) {
        activate('view')
      } else if (index === 1) {
        activate('dismiss')
      }
    })
    notification.on('failed', () => {
      if (bellNotifications.get(request.terminalId) !== entry) {
        return
      }

      bellNotifications.set(request.terminalId, {
        sequence: request.sequence,
        mode: 'fallback'
      })
      notification.close()
      sendBellNotificationPresentation('bell-notification:fallback', request)
    })
    notification.on('close', () => {
      if (bellNotifications.get(request.terminalId) === entry) {
        bellNotifications.delete(request.terminalId)
      }
    })
    notification.show()
  })

  ipcMain.on('bell-notification:clear', (event, value: unknown) => {
    if (!isTrustedRendererEvent(event)) {
      return
    }

    const request = parseBellNotificationClear(value)
    if (!request) {
      return
    }

    const current = bellNotifications.get(request.terminalId)
    if (!current || current.sequence > request.sequence) {
      return
    }

    bellNotifications.delete(request.terminalId)
    if (current.mode === 'native') {
      current.notification.close()
    }

    if (
      ![...bellNotifications.values()].some(
        (notification) => notification.mode === 'fallback'
      )
    ) {
      stopBellAttention()
    }
  })

  void app.whenReady().then(() => {
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
