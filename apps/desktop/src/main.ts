import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { browserUrlSchema } from '@treeport/browser-host'
import { decodeUnknownOrNull } from './schema.ts'
import {
  app,
  BrowserWindow,
  WebContentsView,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { z } from 'zod'
import { WebSocket, WebSocketServer } from 'ws'
import * as Effect from 'effect/Effect'
import * as Scope from 'effect/Scope'
import { DesktopRuntime } from './desktop-runtime'
import { checkActivity, phoneAccess } from './backend-connection'
import { HostSession, HostSessions } from './host-session'
import { ComputerStore } from './computer-store'
import type {
  DesktopBrowserToolbarCommand,
  DesktopCommand,
  TreeportTheme
} from '@treeport/desktop-bridge'
import type {
  ComputerMutationResult,
  ComputerUpdate,
  DesktopNavigationDirection,
  DesktopNavigationState,
  DesktopShellState
} from './desktop-contract'
import { filePathFromUrl } from './file-url'
import {
  localSourcePathSchema,
  resolveLocalSourcePath
} from './local-source-path'
import { isLoopbackUrl, parseComputerUrl } from './renderer-url'
import { createRendererRequestHandler } from './renderer-request-handler'
import { loadRenderer } from './renderer-load'
import { parseWorkspaceLink, type WorkspaceTarget } from './workspace-link'

const dirname = __dirname
const TITLEBAR_HEIGHT = 32
const DEFAULT_WINDOW_WIDTH = 1440
const DEFAULT_WINDOW_HEIGHT = 900
const MINIMUM_WINDOW_WIDTH = 320
const MINIMUM_WINDOW_HEIGHT = 600
const WINDOW_STATE_FILE = 'window-state.json'
const RENDERER_PARTITION = 'persist:treeport-desktop-renderer'
const PRIVATE_RENDERER_URL = 'treeport-app://application/'

const themeSchema = z.object({
  mode: z.enum(['auto', 'dark', 'light']),
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .nullable()
}) satisfies z.ZodType<TreeportTheme>

const defaultTheme: TreeportTheme = { mode: 'dark', accent: null }

const windowChrome = {
  dark: { background: '#151920', symbol: '#dfe4eb' },
  light: { background: '#edf0f4', symbol: '#20242c' }
}

const windowStateSchema = z.object({
  version: z.literal(1),
  theme: themeSchema.catch(defaultTheme),
  bounds: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }),
  maximized: z.boolean()
})

type WindowState = z.infer<typeof windowStateSchema>

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

if (!app.isPackaged) {
  // EXTERNAL: Renaming the app must not move existing computers, cookies, or window state.
  const userData = app.getPath('userData')
  app.setName('Treeport Dev')
  app.setPath('userData', userData)
}

const defaultComputerUrl = app.isPackaged
  ? 'http://127.0.0.1:8733'
  : 'http://127.0.0.1:5173'

const seedComputerUrl =
  process.env.TREEPORT_DESKTOP_URL?.trim() || defaultComputerUrl

let mainWindow: BrowserWindow | null = null
let hostSessions: HostSessions | null = null
let shellView: WebContentsView | null = null
let shellOverlayOpen = false
let windowState: WindowState | null = null
let theme = defaultTheme
let store: ComputerStore | null = null
const desktopRuntime = new DesktopRuntime()
let windowRuntime: DesktopRuntime | null = null
let fullscreen = false
let pendingWorkspaceTarget: WorkspaceTarget | null = null
const workspaceTargets = Effect.unsafeMakeSemaphore(1)

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

const installRendererRequestRouting = Effect.gen(function* () {
  const rendererSession = session.fromPartition(RENDERER_PARTITION)

  const handler = yield* createRendererRequestHandler({
    rendererDirectory: path.join(dirname, '../renderer/main_window'),
    developmentServerUrl: rendererDevelopmentServerUrl(),
    forward: (request) => fetch(request)
  })

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      rendererSession.protocol.handle('treeport-app', (request) =>
        desktopRuntime.run(handler(request), 'desktop.renderer.request')
      )
    ),
    () => Effect.sync(() => rendererSession.protocol.unhandle('treeport-app'))
  )
})

function navigationState(): DesktopNavigationState {
  const renderer = hostSessions?.active?.view.webContents

  if (
    !renderer ||
    renderer.isDestroyed() ||
    hostSessions?.active?.connection.status !== 'ready'
  ) {
    return { canGoBack: false, canGoForward: false }
  }

  // EXTERNAL: Electron's canGoBack/canGoForward omit same-document pushState entries.
  // Relative offsets include the TanStack Router locations in the renderer.
  return {
    canGoBack: renderer.navigationHistory.canGoToOffset(-1),
    canGoForward: renderer.navigationHistory.canGoToOffset(1)
  }
}

function shellState(): DesktopShellState {
  const state: DesktopShellState = {
    appVersion: app.getVersion(),
    platform: process.platform,
    fullscreen,
    computers: store?.summaries() ?? [],
    connection: hostSessions?.active?.connection ?? { status: 'empty' },
    navigation: navigationState(),
    theme
  }

  if (store?.selectedComputer) {
    state.selectedComputerId = store.selectedComputer.id
  }

  return state
}

function layoutWorkspace(): void {
  if (!mainWindow || !shellView) {
    return
  }

  const host = hostSessions?.active
  const workspace = host?.view
  const { width, height } = mainWindow.getContentBounds()
  const top = process.platform === 'darwin' && fullscreen ? 0 : TITLEBAR_HEIGHT
  workspace?.setBounds({
    x: 0,
    y: top,
    width,
    height: Math.max(0, height - top)
  })
  shellView.setBounds({ x: 0, y: 0, width, height })
  workspace?.setVisible(host?.connection.status === 'ready')
  const topView = shellOverlayOpen || !workspace ? shellView : workspace

  if (mainWindow.contentView.children.at(-1) !== topView) {
    mainWindow.contentView.addChildView(topView)
  }

  mainWindow.setTitle(workspace?.webContents.getTitle() || app.name)
}

function broadcastState(): void {
  layoutWorkspace()
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

  const renderer = shellView?.webContents

  if (renderer && !renderer.isDestroyed()) {
    renderer.send('shell:state', state)
  }
}

function isTrustedRendererEvent(
  event: IpcMainEvent | IpcMainInvokeEvent
): boolean {
  const host = hostSessions?.sender(event)

  return Boolean(host && host === hostSessions?.active && !shellOverlayOpen)
}

function isTrustedShellEvent(
  event: IpcMainEvent | IpcMainInvokeEvent
): boolean {
  return Boolean(
    shellView &&
    event.sender === shellView.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url.startsWith(PRIVATE_RENDERER_URL)
  )
}

function selectedOrigin(): string | null {
  return hostSessions?.active?.computer.origin ?? null
}

function setTerminalSelectionActive(active: boolean): void {
  const renderer = shellView?.webContents

  if (renderer && !renderer.isDestroyed()) {
    renderer.send('terminal-selection:active', active)
  }
}

function releaseTerminalSelection(): void {
  setTerminalSelectionActive(false)
  const renderer = hostSessions?.active?.view.webContents

  if (renderer && !renderer.isDestroyed()) {
    renderer.send('terminal-selection:release')
  }
}

function stopWindowAttention(): void {
  if (frameFlashing) {
    mainWindow?.flashFrame(false)
    frameFlashing = false
  }
}

function requestWindowAttention(): void {
  const window = mainWindow

  if (!window || window.isFocused()) {
    return
  }

  shellView?.webContents.send('shell:attention-sound')

  if (process.platform !== 'darwin' && !frameFlashing) {
    window.flashFrame(true)
    frameFlashing = true
  }
}

function navigateRendererHistory(direction: DesktopNavigationDirection): void {
  if (shellOverlayOpen) {
    return
  }

  const renderer = hostSessions?.active?.view.webContents

  if (
    !renderer ||
    renderer.isDestroyed() ||
    hostSessions?.active?.connection.status !== 'ready'
  ) {
    return
  }

  const offset = direction === 'back' ? -1 : 1

  if (renderer.navigationHistory.canGoToOffset(offset)) {
    renderer.navigationHistory.goToOffset(offset)
  }
}

function zoomPage(action: 'zoom-in' | 'zoom-out' | 'zoom-reset'): void {
  const renderer = hostSessions?.active?.view.webContents

  if (!renderer || renderer.isDestroyed()) {
    return
  }

  renderer.setZoomLevel(
    action === 'zoom-reset'
      ? 0
      : renderer.getZoomLevel() + (action === 'zoom-in' ? 0.5 : -0.5)
  )
}

function sendDesktopCommand(command: DesktopCommand): void {
  const window = mainWindow

  if (!window || !window.isFocused() || shellOverlayOpen) {
    return
  }

  if (hostSessions?.active?.connection.status !== 'ready') {
    if (
      command === 'zoom-in' ||
      command === 'zoom-out' ||
      command === 'zoom-reset'
    ) {
      zoomPage(command)
    }

    return
  }

  hostSessions?.active?.view.webContents.send('desktop-command', command)
}

function installRendererSecurity(
  renderer: WebContents,
  host: HostSession | null = null
): void {
  renderer.on('focus', () => {
    if (host && (hostSessions?.active !== host || shellOverlayOpen)) {
      const foreground = shellOverlayOpen
        ? shellView
        : (hostSessions?.active?.view ?? shellView)

      foreground?.webContents.focus()
    }
  })
  renderer.on('before-input-event', (event, input) => {
    if (host && (hostSessions?.active !== host || shellOverlayOpen)) {
      event.preventDefault()

      return
    }

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

    const zoomCommand =
      key === '+' || key === '='
        ? 'zoom-in'
        : !input.shift && key === '-'
          ? 'zoom-out'
          : !input.shift && key === '0'
            ? 'zoom-reset'
            : null

    if (
      input.type === 'keyDown' &&
      !input.isComposing &&
      commandModifier &&
      !(process.platform === 'darwin' ? input.control : input.meta) &&
      !input.alt &&
      zoomCommand
    ) {
      event.preventDefault()
      sendDesktopCommand(zoomCommand)

      return
    }

    // SAFETY: The digit expression restricts the interpolated command to the DesktopCommand tab range.
    const command: DesktopCommand | undefined = input.alt
      ? !input.shift && code === 'keyb' && process.platform !== 'darwin'
        ? 'toggle-apps-panel'
        : undefined
      : input.shift
        ? code === 'bracketleft'
          ? 'select-previous-worktree'
          : code === 'bracketright'
            ? 'select-next-worktree'
            : undefined
        : key === 'n'
          ? 'new-worktree'
          : key === 't'
            ? 'new-terminal'
            : key === 'p'
              ? 'new-app'
              : key === 'b' && process.platform === 'darwin'
                ? 'toggle-apps-panel'
                : key === 'w'
                  ? 'close-app'
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
    sendDesktopCommand(command)
  })

  const preventUntrustedNavigation = (
    event: Electron.Event,
    targetUrl: string
  ) => {
    if (
      (renderer === shellView?.webContents &&
        targetUrl.startsWith(PRIVATE_RENDERER_URL)) ||
      host?.ownsUrl(targetUrl)
    ) {
      return
    }

    event.preventDefault()

    if (
      (!host || (hostSessions?.active === host && !shellOverlayOpen)) &&
      URL.canParse(targetUrl)
    ) {
      const targetProtocol = new URL(targetUrl).protocol

      if (targetProtocol === 'http:' || targetProtocol === 'https:') {
        windowRuntime?.fork(
          Effect.tryPromise(() => shell.openExternal(targetUrl))
        )
      }
    }
  }

  renderer.on('will-navigate', preventUntrustedNavigation)
  renderer.on('will-redirect', (event) => {
    if (event.isMainFrame) {
      preventUntrustedNavigation(event, event.url)
    }
  })
  renderer.setWindowOpenHandler(({ url }) => {
    if (
      (!host || (hostSessions?.active === host && !shellOverlayOpen)) &&
      URL.canParse(url)
    ) {
      const targetProtocol = new URL(url).protocol

      if (targetProtocol === 'http:' || targetProtocol === 'https:') {
        windowRuntime?.fork(Effect.tryPromise(() => shell.openExternal(url)))
      }
    }

    return { action: 'deny' }
  })

  const canWriteClipboard = (
    contents: WebContents | null,
    permission: string,
    url: string,
    mainFrame: boolean
  ) =>
    permission === 'clipboard-sanitized-write' &&
    mainFrame &&
    contents === hostSessions?.active?.view.webContents &&
    URL.canParse(url) &&
    new URL(url).origin === selectedOrigin()

  renderer.session.setPermissionCheckHandler(
    (contents, permission, origin, details) =>
      canWriteClipboard(contents, permission, origin, details.isMainFrame)
  )
  renderer.session.setPermissionRequestHandler(
    (contents, permission, callback, details) =>
      callback(
        canWriteClipboard(
          contents,
          permission,
          details.requestingUrl,
          details.isMainFrame
        )
      )
  )
  renderer.session.setDisplayMediaRequestHandler((_request, callback) =>
    callback({})
  )
  renderer.session.setDevicePermissionHandler(() => false)
  renderer.on('did-finish-load', () =>
    renderer.send('fullscreen-change', fullscreen)
  )
}

const computerUpdateSchema = z.object({
  id: z.string(),
  origin: z.string(),
  nameOverride: z.string().optional()
})

const nativeBrowserAppSchema = z.strictObject({
  appId: z.string().min(1).max(128)
})

const nativeBrowserRegisterSchema = nativeBrowserAppSchema.extend({
  webContentsId: z.number().int().positive(),
  challenge: z.string().min(32).max(256)
})

const nativeBrowserCloseSchema = nativeBrowserAppSchema.extend({
  force: z.boolean()
})

const nativeBrowserUrlSchema = z.string().transform((value, context) => {
  const parsed = decodeUnknownOrNull(browserUrlSchema, value)

  if (parsed) {
    return parsed
  }

  context.addIssue({ code: 'custom', message: 'Invalid Browser URL' })

  return z.NEVER
})

const nativeBrowserCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('navigate'), url: nativeBrowserUrlSchema }),
  z.strictObject({ type: z.literal('back') }),
  z.strictObject({ type: z.literal('forward') }),
  z.strictObject({ type: z.literal('reload') }),
  z.strictObject({ type: z.literal('stop') })
]) satisfies z.ZodType<DesktopBrowserToolbarCommand>

const nativeBrowserInputControlSchema = nativeBrowserAppSchema.extend({
  locked: z.boolean()
})

const nativeBrowserPresentationSchema = nativeBrowserAppSchema.extend({
  active: z.boolean()
})

function connectSelected(options: { url?: string } = {}): void {
  const hosts = hostSessions
  const runtime = windowRuntime

  if (!hosts || !runtime) {
    return
  }

  for (const [id, host] of hosts.visited) {
    if (store?.getComputer(id)?.origin !== host.computer.origin) {
      hosts.visited.delete(id)

      if (hosts.active === host) {
        hosts.active = null
      }

      desktopRuntime.fork(host.dispose())
    }
  }

  const computer = store?.selectedComputer
  let host = computer ? (hosts.visited.get(computer.id) ?? null) : null

  if (computer && !host) {
    const created = new HostSession(
      { id: computer.id, origin: computer.origin },
      {
        window: hosts.window,
        runtime,
        preferences: rendererWindowPreferences(),
        isForeground: () => hosts.active === created && !shellOverlayOpen,
        changed: () => {
          if (hostSessions === hosts && hosts.active === created) {
            broadcastState()
          }
        },
        ready: () => {
          if (
            hostSessions === hosts &&
            hosts.active === created &&
            !shellOverlayOpen
          ) {
            created.view.webContents.focus()
          }
        },
        rememberHostname: (hostname) =>
          Effect.suspend(() =>
            store?.getComputer(computer.id)?.origin === computer.origin
              ? store.rememberHostname(computer.id, hostname)
              : Effect.void
          )
      }
    )

    host = created
    hosts.visited.set(computer.id, host)
    installRendererSecurity(host.view.webContents, host)
  }

  if (hosts.active !== host) {
    releaseTerminalSelection()
    hosts.active?.deactivate()
    hosts.active = host
  }

  broadcastState()

  if (host) {
    host.view.webContents.send('fullscreen-change', fullscreen)
    host.connect(options.url)

    if (!shellOverlayOpen && host.connection.status === 'ready') {
      host.view.webContents.focus()
    } else {
      shellView?.webContents.focus()
    }
  } else {
    shellView?.webContents.focus()
  }
}

function rendererWindowPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(dirname, 'preload.js'),
    partition: RENDERER_PARTITION,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: true,
    focusOnNavigation: false
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
          id: 'split-terminal-left',
          label: 'Split Terminal Left',
          accelerator: 'CommandOrControl+Alt+Left',
          click: () => sendDesktopCommand('split-terminal-left')
        },
        {
          id: 'split-terminal-right',
          label: 'Split Terminal Right',
          accelerator: 'CommandOrControl+Alt+Right',
          click: () => sendDesktopCommand('split-terminal-right')
        },
        {
          id: 'split-terminal-up',
          label: 'Split Terminal Up',
          accelerator: 'CommandOrControl+Alt+Up',
          click: () => sendDesktopCommand('split-terminal-up')
        },
        {
          id: 'split-terminal-down',
          label: 'Split Terminal Down',
          accelerator: 'CommandOrControl+Alt+Down',
          click: () => sendDesktopCommand('split-terminal-down')
        },
        {
          id: 'new-app',
          label: 'New app…',
          accelerator: 'CommandOrControl+P',
          click: () => sendDesktopCommand('new-app')
        },
        { type: 'separator' },
        {
          id: 'close-app',
          label: 'Close app',
          accelerator: 'CommandOrControl+W',
          click: () => sendDesktopCommand('close-app')
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

        return [
          {
            id: 'navigate-previous-worktree',
            label: 'Previous Tree',
            accelerator: 'CommandOrControl+Shift+[',
            click: () => sendDesktopCommand('select-previous-worktree')
          },
          {
            id: 'navigate-next-worktree',
            label: 'Next Tree',
            accelerator: 'CommandOrControl+Shift+]',
            click: () => sendDesktopCommand('select-next-worktree')
          },
          { type: 'separator' },
          back,
          forward
        ]
      })()
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CommandOrControl+R',
          click: () => sendDesktopCommand('reload')
        },
        {
          label: 'Force Reload',
          accelerator: 'CommandOrControl+Shift+R',
          click: () =>
            hostSessions?.active?.view.webContents.reloadIgnoringCache()
        },
        {
          label: 'Toggle Developer Tools',
          accelerator:
            process.platform === 'darwin' ? 'Alt+Command+I' : 'Control+Shift+I',
          click: () => hostSessions?.active?.view.webContents.toggleDevTools()
        },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: () => sendDesktopCommand('zoom-reset')
        },
        {
          label: 'Zoom In',
          accelerator: 'CommandOrControl+=',
          click: () => sendDesktopCommand('zoom-in')
        },
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: () => sendDesktopCommand('zoom-out')
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const loadWindowState = Effect.gen(function* () {
  const filePath = path.join(app.getPath('userData'), WINDOW_STATE_FILE)

  const contents = yield* Effect.tryPromise(() =>
    fs.readFile(filePath, 'utf8')
  ).pipe(
    Effect.catchAll((error) => {
      const parsed = z.object({ code: z.string() }).safeParse(error.cause)

      return parsed.success && parsed.data.code === 'ENOENT'
        ? Effect.succeed(null)
        : Effect.fail(error)
    })
  )

  if (contents === null) {
    return null
  }

  return yield* Effect.try(() => {
    const parsed = windowStateSchema.safeParse(JSON.parse(contents))

    return parsed.success ? parsed.data : null
  }).pipe(Effect.catchAll(() => Effect.succeed(null)))
})

function restoredWindowBounds(): WindowState['bounds'] | null {
  if (!windowState) {
    return null
  }

  const displays = screen.getAllDisplays()
  const saved = windowState.bounds
  let target = screen.getPrimaryDisplay()
  let largestIntersection = 0

  for (const display of displays) {
    const workArea = display.workArea

    const intersectionWidth = Math.max(
      0,
      Math.min(saved.x + saved.width, workArea.x + workArea.width) -
        Math.max(saved.x, workArea.x)
    )

    const intersectionHeight = Math.max(
      0,
      Math.min(saved.y + saved.height, workArea.y + workArea.height) -
        Math.max(saved.y, workArea.y)
    )

    const intersection = intersectionWidth * intersectionHeight

    if (intersection > largestIntersection) {
      largestIntersection = intersection
      target = display
    }
  }

  const workArea = target.workArea

  const width = Math.max(
    Math.min(MINIMUM_WINDOW_WIDTH, workArea.width),
    Math.min(saved.width, workArea.width)
  )

  const height = Math.max(
    Math.min(MINIMUM_WINDOW_HEIGHT, workArea.height),
    Math.min(saved.height, workArea.height)
  )

  if (largestIntersection === 0) {
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height
    }
  }

  return {
    x: Math.min(
      Math.max(saved.x, workArea.x),
      workArea.x + workArea.width - width
    ),
    y: Math.min(
      Math.max(saved.y, workArea.y),
      workArea.y + workArea.height - height
    ),
    width,
    height
  }
}

function persistWindowState(window: BrowserWindow): void {
  windowState = {
    version: 1,
    theme,
    bounds: window.getNormalBounds(),
    maximized: window.isMaximized()
  }
  const filePath = path.join(app.getPath('userData'), WINDOW_STATE_FILE)
  const temporaryPath = `${filePath}.${process.pid}.tmp`

  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(temporaryPath, `${JSON.stringify(windowState, null, 2)}\n`, {
      mode: 0o600
    })
    renameSync(temporaryPath, filePath)
  } catch (error) {
    console.error('[Treeport] Could not save desktop window state', error)
  }
}

function createWindow(url?: string): BrowserWindow {
  const restoredBounds = restoredWindowBounds()

  const chrome =
    windowChrome[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']

  const options: BrowserWindowConstructorOptions = {
    show: !desktopE2e,
    width: restoredBounds?.width ?? DEFAULT_WINDOW_WIDTH,
    height: restoredBounds?.height ?? DEFAULT_WINDOW_HEIGHT,
    minWidth: MINIMUM_WINDOW_WIDTH,
    minHeight: MINIMUM_WINDOW_HEIGHT,
    backgroundColor: chrome.background,
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: chrome.background,
      symbolColor: chrome.symbol,
      height: TITLEBAR_HEIGHT
    },
    webPreferences: { ...rendererWindowPreferences(), webviewTag: false }
  }

  if (!app.isPackaged) {
    options.title = app.name
    options.icon = path.join(app.getAppPath(), 'assets/treeport-dev-icon.png')
  }

  if (restoredBounds) {
    options.x = restoredBounds.x
    options.y = restoredBounds.y
  }

  // EXTERNAL: Leave trafficLightPosition unset so titleBarOverlay centers the native
  // buttons using their actual size, which varies between macOS versions.

  const window = new BrowserWindow(options)

  if (windowState?.maximized) {
    window.maximize()
  }

  const runtime = new DesktopRuntime(desktopRuntime)
  mainWindow = window
  windowRuntime = runtime
  shellOverlayOpen = false
  const hosts = new HostSessions(window)
  hostSessions = hosts

  const shell = new WebContentsView({
    webPreferences: {
      ...rendererWindowPreferences(),
      webviewTag: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  shellView = shell
  shell.setBackgroundColor('#00000000')
  window.contentView.addChildView(shell)
  installRendererSecurity(shell.webContents)
  window.on('resize', layoutWorkspace)
  layoutWorkspace()

  window.on('enter-full-screen', () => {
    fullscreen = true

    for (const host of hosts.visited.values()) {
      host.view.webContents.send('fullscreen-change', true)
    }

    shell.webContents.send('fullscreen-change', true)
    broadcastState()
  })
  window.on('leave-full-screen', () => {
    fullscreen = false

    for (const host of hosts.visited.values()) {
      host.view.webContents.send('fullscreen-change', false)
    }

    shell.webContents.send('fullscreen-change', false)
    broadcastState()
  })
  window.on('focus', stopWindowAttention)
  window.on('close', () => {
    persistWindowState(window)
  })
  window.on('closed', () => {
    stopWindowAttention()

    if (mainWindow === window) {
      mainWindow = null
      hostSessions = null
      shellView = null

      if (!shell.webContents.isDestroyed()) {
        shell.webContents.close()
      }

      for (const host of hosts.visited.values()) {
        desktopRuntime.fork(host.dispose())
      }

      hosts.visited.clear()
      hosts.active = null
      windowRuntime = null
      desktopRuntime.fork(runtime.close)
    }
  })
  shell.webContents.on('did-finish-load', () => {
    shellOverlayOpen = false
    broadcastState()
  })
  runtime.fork(
    loadRenderer(shell.webContents, PRIVATE_RENDERER_URL).pipe(Effect.asVoid)
  )
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

function applyWindowChrome(): void {
  const chrome =
    windowChrome[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']

  mainWindow?.setBackgroundColor(chrome.background)

  // EXTERNAL: macOS draws native traffic lights without an overlay color.
  if (process.platform !== 'darwin') {
    mainWindow?.setTitleBarOverlay({
      color: chrome.background,
      symbolColor: chrome.symbol
    })
  }

  for (const host of hostSessions?.visited.values() ?? []) {
    host.view.setBackgroundColor(chrome.background)
  }

  broadcastState()
}

function registerIpc(): void {
  ipcMain.on('desktop:runtime', (event) => {
    const computer = hostSessions?.sender(event)?.computer
    event.returnValue = computer
      ? {
          computerId: computer.id,
          localBrowser: isLoopbackUrl(new URL(computer.origin))
        }
      : null
  })
  ipcMain.on('shell:set-overlay-open', (event, value) => {
    const parsed = z.boolean().safeParse(value)

    if (isTrustedShellEvent(event) && parsed.success) {
      shellOverlayOpen = parsed.data

      if (shellOverlayOpen) {
        hostSessions?.active?.browser.suspendPresentation()
      }

      layoutWorkspace()

      if (
        !shellOverlayOpen &&
        hostSessions?.active?.connection.status === 'ready'
      ) {
        hostSessions?.active?.view.webContents.focus()
      }
    }
  })
  ipcMain.handle('hosted-browser:open-devtools', async (event, value) => {
    const target = z
      .object({
        appId: z.string().regex(/^app_[a-f0-9]{32}$/u),
        backendNodeId: z.number().int().positive().nullable(),
        targetId: z
          .string()
          .regex(/^[a-fA-F0-9]{32}$/u)
          .nullable()
      })
      .strict()
      .safeParse(value)

    const host = hostSessions?.sender(event)
    const origin = host?.computer.origin

    if (!isTrustedRendererEvent(event) || !target.success || !origin || !host) {
      return false
    }

    const endpoint = new URL(origin)
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    endpoint.pathname = `/api/browser-devtools/${target.data.appId}`
    endpoint.search = ''
    endpoint.hash = ''

    // EXTERNAL: Electron's bundled DevTools CSP permits ws://127.0.0.1:* but not
    // arbitrary tailnet WSS origins. Keep the remote connection in main.
    const relay = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false
    })

    const listening = await new Promise<boolean>((resolve) => {
      relay.once('listening', () => resolve(true))
      relay.once('error', () => resolve(false))
    })

    const address = relay.address()

    if (
      !listening ||
      !address ||
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- Discriminate the Node listener address before using its port.
      typeof address === 'string' ||
      host.runtime.isClosed ||
      !isTrustedRendererEvent(event)
    ) {
      relay.close()

      return false
    }

    const frontend = new URL('devtools://devtools/bundled/inspector.html')
    frontend.searchParams.set('ws', `127.0.0.1:${address.port}/devtools`)

    const window = new BrowserWindow({
      width: 1100,
      height: 750,
      title: 'Browser DevTools',
      webPreferences: { sandbox: true, nodeIntegration: false }
    })

    relay.on('connection', (viewer, request) => {
      if (
        request.url !== '/devtools' ||
        request.headers.origin !== 'devtools://devtools' ||
        window.isDestroyed()
      ) {
        viewer.close(1008, 'Invalid DevTools connection')

        return
      }

      const upstream = new WebSocket(endpoint.href, {
        origin: 'devtools://devtools',
        maxPayload: 16 * 1024 * 1024,
        perMessageDeflate: false
      })

      const pending: Array<{ data: Buffer; binary: boolean }> = []
      let pendingBytes = 0
      let inspectNode = target.data.backendNodeId
      let documentRequest: number | null = null
      let inspectSession: string | null = null
      viewer.on('message', (data, binary) => {
        // SAFETY: ws delivers Node Buffer payloads in the Electron main process.
        const message = Buffer.from(data as Buffer)

        if (inspectNode !== null && !binary) {
          try {
            const command = z
              .object({
                id: z.number(),
                method: z.string(),
                sessionId: z.string().optional()
              })
              .safeParse(JSON.parse(message.toString()))

            if (
              command.success &&
              (target.data.targetId === null
                ? command.data.method === 'DOM.getDocument' &&
                  !command.data.sessionId
                : command.data.method === 'DOM.enable' &&
                  inspectSession !== null &&
                  command.data.sessionId === inspectSession)
            ) {
              documentRequest = command.data.id
            }
          } catch {}
        }

        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > 16 * 1024 * 1024) {
            viewer.close(1009, 'DevTools input overflow')
          } else {
            upstream.send(message, { binary })
          }
        } else if (upstream.readyState === WebSocket.CONNECTING) {
          pendingBytes += message.length

          if (pendingBytes > 1024 * 1024) {
            viewer.close(1009, 'DevTools input overflow')
          } else {
            pending.push({ data: message, binary })
          }
        }
      })
      upstream.on('open', () => {
        for (const message of pending) {
          upstream.send(message.data, { binary: message.binary })
        }

        pending.length = 0
      })
      upstream.on('message', (data, binary) => {
        if (viewer.readyState === WebSocket.OPEN) {
          if (viewer.bufferedAmount > 16 * 1024 * 1024) {
            viewer.close(1009, 'DevTools output overflow')
          } else {
            viewer.send(data, { binary })

            if (inspectNode !== null && !binary) {
              try {
                const payload: unknown = JSON.parse(data.toString())

                const attached = z
                  .object({
                    method: z.literal('Target.attachedToTarget'),
                    params: z.object({
                      sessionId: z.string(),
                      targetInfo: z.object({ targetId: z.string() })
                    })
                  })
                  .safeParse(payload)

                if (
                  attached.success &&
                  attached.data.params.targetInfo.targetId ===
                    target.data.targetId
                ) {
                  inspectSession = attached.data.params.sessionId
                }

                const response = z
                  .object({
                    id: z.number(),
                    result: z.object({}),
                    sessionId: z.string().optional()
                  })
                  .safeParse(payload)

                if (
                  response.success &&
                  response.data.id === documentRequest &&
                  (response.data.sessionId ?? null) === inspectSession
                ) {
                  viewer.send(
                    JSON.stringify({
                      method: 'Overlay.inspectNodeRequested',
                      params: { backendNodeId: inspectNode },
                      sessionId: inspectSession ?? undefined
                    })
                  )
                  inspectNode = null
                }
              } catch {}
            }
          }
        }
      })
      viewer.on('close', () => {
        if (upstream.readyState === WebSocket.CONNECTING) {
          upstream.terminate()
        } else if (upstream.readyState === WebSocket.OPEN) {
          upstream.close()
        }
      })
      upstream.on('close', () => viewer.close())
      upstream.on('error', () => viewer.close())
      viewer.on('error', () => upstream.terminate())
    })
    const relayRuntime = new DesktopRuntime(host.runtime)
    Effect.runSync(
      Scope.addFinalizer(
        relayRuntime.scope,
        Effect.sync(() => {
          for (const viewer of relay.clients) {
            viewer.terminate()
          }

          relay.close()

          if (!window.isDestroyed()) {
            window.destroy()
          }
        })
      )
    )
    window.once('closed', () => desktopRuntime.fork(relayRuntime.close))
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (navigation, url) => {
      if (url !== frontend.href) {
        navigation.preventDefault()
      }
    })
    void window.loadURL(frontend.href)

    return true
  })
  ipcMain.handle('shell:get-state', (event) =>
    isTrustedShellEvent(event) ? shellState() : null
  )
  ipcMain.handle('shell:computer-activity', (event) =>
    desktopRuntime.run(
      Effect.gen(function* () {
        if (!isTrustedShellEvent(event) || !store) {
          return []
        }

        return yield* Effect.all(
          store.summaries().map((computer) =>
            checkActivity(computer.origin).pipe(
              Effect.map((activity) => ({
                id: computer.id,
                origin: computer.origin,
                activity
              }))
            )
          ),
          { concurrency: 4 }
        )
      })
    )
  )
  ipcMain.handle('shell:copy-phone-link', (event, value) => {
    if (!isTrustedShellEvent(event) || !z.string().safeParse(value).success) {
      return false
    }

    const parsed = z.url().safeParse(value)

    if (!parsed.success) {
      return false
    }

    const url = new URL(parsed.data)

    if (
      url.protocol !== 'https:' ||
      isLoopbackUrl(url) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return false
    }

    clipboard.writeText(url.href)

    return true
  })
  ipcMain.handle('shell:phone-access', (event, id) =>
    desktopRuntime.run(
      Effect.gen(function* () {
        const computer = store?.selectedComputer

        if (!isTrustedShellEvent(event) || !computer || computer.id !== id) {
          return {
            url: null,
            error: 'Select a computer to open on your phone.',
            setupCommand: null
          }
        }

        return yield* phoneAccess(computer.origin)
      })
    )
  )
  ipcMain.handle('shell:select-computer', (event, id) =>
    desktopRuntime.run(
      Effect.gen(function* () {
        const parsedId = z.string().safeParse(id)

        if (!isTrustedShellEvent(event) || !parsedId.success || !store) {
          return false
        }

        const selected = yield* store.select(parsedId.data)

        if (selected) {
          void connectSelected()
        }

        return selected
      })
    )
  )
  ipcMain.handle('shell:add-computer', (event, input) =>
    desktopRuntime.run(
      Effect.gen(function* () {
        const parsedInput = z.string().safeParse(input)

        if (!isTrustedShellEvent(event) || !parsedInput.success || !store) {
          return { ok: false, error: 'Could not save the computer.' }
        }

        const { origin } = yield* Effect.try(() =>
          parseComputerUrl(parsedInput.data)
        )

        const duplicate = store.findByOrigin(origin)

        if (duplicate) {
          return {
            ok: false,
            error: `That URL is already saved as ${
              store.summaries().find((item) => item.id === duplicate.id)
                ?.name ?? 'a computer'
            }.`,
            duplicateId: duplicate.id
          }
        }

        yield* store.add(origin)
        connectSelected()

        return { ok: true }
      }).pipe(
        Effect.catchAll((error) => Effect.succeed(mutationError(error.cause)))
      )
    )
  )
  ipcMain.handle('shell:update-computer', (event, value) =>
    desktopRuntime.run(
      Effect.gen(function* () {
        if (!isTrustedShellEvent(event) || !store) {
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

        const result = yield* store.update(update.id, update)

        if (!result) {
          return { ok: false, error: 'That computer no longer exists.' }
        }

        if (result.originChanged) {
          connectSelected()
        } else {
          broadcastState()
        }

        return { ok: true }
      }).pipe(
        Effect.catchAll((error) => Effect.succeed(mutationError(error.cause)))
      )
    )
  )
  ipcMain.handle('shell:remove-computer', (event, id) =>
    desktopRuntime.run(
      Effect.gen(function* () {
        const parsedId = z.string().safeParse(id)

        if (!isTrustedShellEvent(event) || !parsedId.success || !store) {
          return false
        }

        const computerId = parsedId.data

        if (!store.getComputer(computerId)) {
          return false
        }

        yield* store.remove(computerId)
        connectSelected()

        return true
      })
    )
  )
  ipcMain.on('shell:retry-connection', (event) => {
    if (isTrustedShellEvent(event)) {
      void connectSelected()
    }
  })
  ipcMain.on('shell:navigate-history', (event, direction) => {
    const parsed = z.enum(['back', 'forward']).safeParse(direction)

    if (isTrustedShellEvent(event) && parsed.success) {
      navigateRendererHistory(parsed.data)
    }
  })
  ipcMain.handle('shell:copy-start-command', (event) => {
    if (isTrustedShellEvent(event)) {
      clipboard.writeText('pnpm start')
    }
  })
  ipcMain.handle('shell:open-installation-docs', (event) => {
    if (isTrustedShellEvent(event)) {
      return desktopRuntime.run(
        Effect.tryPromise(() =>
          shell.openExternal(
            'https://treeport.app/getting-started/installation/'
          )
        )
      )
    }
  })

  ipcMain.handle('open-file-url', (event, value) =>
    desktopRuntime.run(
      Effect.gen(function* () {
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

        return (yield* Effect.tryPromise(() => shell.openPath(filePath))) === ''
          ? 'opened'
          : 'rejected'
      })
    )
  )
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

    const filePath = filePathFromUrl(clipboard.read('public.file-url'))
    const parsedPath = localSourcePathSchema.safeParse(filePath)

    const resolvedPath = parsedPath.success
      ? resolveLocalSourcePath(selectedOrigin(), parsedPath.data)
      : null

    event.returnValue = resolvedPath ? [resolvedPath] : []
  })
  ipcMain.handle('native-browser:register', (event, value) => {
    const host = hostSessions?.sender(event)
    const browserWebviews = host?.browser
    const parsed = nativeBrowserRegisterSchema.safeParse(value)

    return parsed.success && host && browserWebviews
      ? host.runtime.run(
          browserWebviews.register(
            event,
            parsed.data.appId,
            parsed.data.webContentsId,
            parsed.data.challenge
          )
        )
      : null
  })
  ipcMain.handle('native-browser:command', (event, value) => {
    const host = hostSessions?.sender(event)
    const browserWebviews = host?.browser

    const parsed = z
      .strictObject({
        appId: z.string().min(1).max(128),
        command: nativeBrowserCommandSchema
      })
      .safeParse(value)

    return parsed.success && host && browserWebviews
      ? host.runtime.run(
          browserWebviews.command(event, parsed.data.appId, parsed.data.command)
        )
      : { ok: false, error: 'The Browser command was rejected.' }
  })
  ipcMain.handle('native-browser:set-input-control', (event, value) => {
    const host = hostSessions?.sender(event)
    const browserWebviews = host?.browser
    const parsed = nativeBrowserInputControlSchema.safeParse(value)

    return parsed.success && host && browserWebviews
      ? host.runtime.run(
          browserWebviews.setInputControl(
            event,
            parsed.data.appId,
            parsed.data.locked
          )
        )
      : false
  })
  ipcMain.handle('native-browser:set-presentation-active', (event, value) => {
    const host = hostSessions?.sender(event)
    const browserWebviews = host?.browser
    const parsed = nativeBrowserPresentationSchema.safeParse(value)

    return parsed.success && host && browserWebviews
      ? host.runtime.run(
          browserWebviews.setPresentationActive(
            event,
            parsed.data.appId,
            parsed.data.active
          )
        )
      : false
  })
  ipcMain.handle('native-browser:request-close', (event, value) => {
    const host = hostSessions?.sender(event)
    const browserWebviews = host?.browser
    const parsed = nativeBrowserCloseSchema.safeParse(value)

    if (!parsed.success) {
      return false
    }

    return host && browserWebviews
      ? host.runtime.run(
          browserWebviews.requestClose(
            event,
            parsed.data.appId,
            parsed.data.force
          )
        )
      : true
  })
  ipcMain.handle('native-browser:permissions', (event, value) => {
    const browserWebviews = hostSessions?.sender(event)?.browser
    const parsed = nativeBrowserAppSchema.safeParse(value)

    return parsed.success && browserWebviews
      ? browserWebviews.permissions(event, parsed.data.appId)
      : null
  })
  ipcMain.handle('native-browser:reset-permissions', (event, value) => {
    const browserWebviews = hostSessions?.sender(event)?.browser

    const parsed = nativeBrowserAppSchema
      .extend({
        origin: z.string().max(2048),
        capability: z.string().max(80).nullable()
      })
      .safeParse(value)

    return parsed.success && browserWebviews
      ? browserWebviews.resetPermissions(
          event,
          parsed.data.appId,
          parsed.data.origin,
          parsed.data.capability
        )
      : false
  })
  ipcMain.on('native-browser:permission-response', (event, value) => {
    const browserWebviews = isTrustedRendererEvent(event)
      ? hostSessions?.sender(event)?.browser
      : null

    const parsed = z
      .strictObject({
        id: z.string().uuid(),
        allow: z.boolean()
      })
      .safeParse(value)

    if (parsed.success) {
      browserWebviews?.respondPermission(
        event,
        parsed.data.id,
        parsed.data.allow
      )
    }
  })
  ipcMain.on('native-browser:dispose', (event, value) => {
    const host = hostSessions?.sender(event)
    const browserWebviews = host?.browser
    const parsed = nativeBrowserAppSchema.safeParse(value)

    if (!parsed.success) {
      return
    }

    if (host && browserWebviews) {
      host.runtime.fork(browserWebviews.dispose(event, parsed.data.appId))
    }
  })
  ipcMain.on('desktop:zoom-page', (event, value) => {
    const parsed = z
      .enum(['zoom-in', 'zoom-out', 'zoom-reset'])
      .safeParse(value)

    if (isTrustedRendererEvent(event) && parsed.success) {
      zoomPage(parsed.data)
    }
  })
  ipcMain.on('terminal-selection:set-active', (event, active) => {
    const parsedActive = z.boolean().safeParse(active)

    if (!isTrustedRendererEvent(event) || !parsedActive.success) {
      return
    }

    setTerminalSelectionActive(parsedActive.data)
  })
  ipcMain.on('shell:terminal-selection-release', (event) => {
    if (isTrustedShellEvent(event)) {
      releaseTerminalSelection()
    }
  })
  ipcMain.on('attention:request', (event) => {
    if (isTrustedRendererEvent(event)) {
      requestWindowAttention()
    }
  })
  ipcMain.on('desktop:set-theme', (event, value) => {
    const parsed = themeSchema.safeParse(value)

    if (!isTrustedRendererEvent(event) || !parsed.success) {
      return
    }

    theme = parsed.data
    nativeTheme.themeSource = theme.mode === 'auto' ? 'system' : theme.mode
    applyWindowChrome()
    broadcastState()
  })
}

function openWorkspaceTarget(target: WorkspaceTarget) {
  return Effect.gen(function* () {
    const currentStore = store

    if (!currentStore) {
      pendingWorkspaceTarget = target

      return
    }

    const existing = currentStore.findByOrigin(target.origin)

    if (existing) {
      yield* currentStore.select(existing.id)
    } else {
      yield* currentStore.add(target.origin)
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
  })
}

function queueWorkspaceTarget(target: WorkspaceTarget): void {
  if (!store) {
    pendingWorkspaceTarget = target

    return
  }

  desktopRuntime.fork(
    workspaceTargets.withPermits(1)(openWorkspaceTarget(target)),
    'desktop.workspace.open'
  )
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
  desktopRuntime.fork(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => app.whenReady())

      if (!app.isPackaged && process.platform === 'darwin') {
        app.dock?.setIcon(
          path.join(app.getAppPath(), 'assets/treeport-dev-icon.png')
        )
      }

      yield* installRendererRequestRouting
      windowState = yield* loadWindowState
      theme = windowState?.theme ?? defaultTheme
      nativeTheme.themeSource = theme.mode === 'auto' ? 'system' : theme.mode
      nativeTheme.on('updated', applyWindowChrome)
      store = yield* ComputerStore.load(
        path.join(app.getPath('userData'), 'computers.json'),
        seedComputerUrl,
        { synchronizeSelectedLoopback: !app.isPackaged }
      )
      installMenu()
      const startupTarget = pendingWorkspaceTarget
      pendingWorkspaceTarget = null

      if (startupTarget) {
        yield* openWorkspaceTarget(startupTarget)
      } else {
        createWindow()
      }

      app.on('activate', () => {
        if (!mainWindow) {
          createWindow()
        }
      })
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logError(cause).pipe(Effect.andThen(() => app.quit()))
      )
    ),
    'desktop.startup'
  )

  let quitReady = false
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitReady) {
      return
    }

    event.preventDefault()

    if (quitting) {
      return
    }

    quitting = true
    // EXTERNAL: Do not close the root from one of its own fibers: closing joins children.
    void Effect.runPromiseExit(desktopRuntime.close).then((exit) => {
      if (exit._tag === 'Failure') {
        console.error('[Treeport] Desktop shutdown failed', exit.cause)
      }

      quitReady = true

      app.quit()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
