import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { browserUrlSchema, decodeUnknownOrNull } from '@treeport/shared'
import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
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
import { updateElectronApp, UpdateSourceType } from 'update-electron-app'
import { z } from 'zod'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import { DesktopRuntime } from './desktop-runtime'
import { checkHealth, watchBackendHealth } from './backend-connection'
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

const windowStateSchema = z.object({
  version: z.literal(1),
  bounds: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }),
  maximized: z.boolean()
})

type WindowState = z.infer<typeof windowStateSchema>

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
const desktopReleaseVersion = app.isPackaged ? app.getVersion() : null
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

if (!app.isPackaged) {
  // Renaming the app must not move existing computers, cookies, or window state.
  const userData = app.getPath('userData')
  app.setName('Treeport Dev')
  app.setPath('userData', userData)
}

nativeTheme.themeSource = 'dark'

const defaultComputerUrl = app.isPackaged
  ? 'http://127.0.0.1:8733'
  : 'http://127.0.0.1:5173'
const seedComputerUrl =
  process.env.TREEPORT_DESKTOP_URL?.trim() || defaultComputerUrl

let mainWindow: BrowserWindow | null = null
let windowState: WindowState | null = null
let store: ComputerStore | null = null
let connection: ConnectionState = { status: 'empty' }
let connectionGeneration = 0
const desktopRuntime = new DesktopRuntime()
let windowRuntime: DesktopRuntime | null = null
let connectionFiber: Fiber.RuntimeFiber<void> | null = null
let fullscreen = false
let updateReady = desktopUpdateReady
let updateError: string | null = null
let installUpdateOnQuit = false
let pendingWorkspaceTarget: WorkspaceTarget | null = null
const workspaceTargets = Effect.unsafeMakeSemaphore(1)
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

const installRendererRequestRouting = Effect.gen(function* () {
  const rendererSession = session.fromPartition(RENDERER_PARTITION)
  const handler = yield* createRendererRequestHandler({
    rendererDirectory: path.join(dirname, '../renderer/main_window'),
    developmentServerUrl: rendererDevelopmentServerUrl(),
    selectedBackendOrigin: selectedOrigin,
    forward: (request) => fetch(request)
  })
  for (const scheme of ['http', 'https', 'treeport-app']) {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        rendererSession.protocol.handle(scheme, (request) =>
          desktopRuntime.run(handler(request), 'desktop.renderer.request')
        )
      ),
      () => Effect.sync(() => rendererSession.protocol.unhandle(scheme))
    )
  }
})

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
    updateError,
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

const disposeBrowserWebviews = Effect.gen(function* () {
  if (browserWebviews) {
    yield* browserWebviews.disposeAll()
  }

  if (terminalSelectionActive) {
    setTerminalSelectionActive(false)
  }

  broadcastState()
})

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
        ? code === 'bracketleft'
          ? 'select-previous-worktree'
          : code === 'bracketright'
            ? 'select-next-worktree'
            : key === 't'
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
        windowRuntime?.fork(
          Effect.tryPromise(() => shell.openExternal(targetUrl))
        )
      }
    }
  })
  renderer.setWindowOpenHandler(({ url }) => {
    if (URL.canParse(url)) {
      const targetProtocol = new URL(url).protocol
      if (targetProtocol === 'http:' || targetProtocol === 'https:') {
        windowRuntime?.fork(Effect.tryPromise(() => shell.openExternal(url)))
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

    windowRuntime?.fork(
      Effect.gen(function* () {
        const health = yield* checkHealth(origin)
        if (
          !health &&
          connection.status === 'ready' &&
          selectedOrigin() === origin &&
          mainWindow?.webContents === renderer
        ) {
          connectSelected({
            unavailableImmediately: true,
            unavailableMessage: `The connection to ${origin} was lost.`
          })
        }
      })
    )
  })
}

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
const nativeBrowserInputControlSchema = nativeBrowserPanelSchema.extend({
  locked: z.boolean()
})

function connectSelected(
  options: {
    unavailableImmediately?: boolean
    unavailableMessage?: string
    url?: string
  } = {}
): void {
  const runtime = windowRuntime
  if (!runtime) {
    return
  }

  const computer = store?.selectedComputer
  const generation = ++connectionGeneration
  const previous = connectionFiber
  connectionFiber = runtime.fork(
    Effect.gen(function* () {
      if (previous) {
        yield* Fiber.interrupt(previous)
      }

      if (generation !== connectionGeneration) {
        return
      }

      yield* disposeBrowserWebviews
      if (generation !== connectionGeneration) {
        return
      }

      if (!computer) {
        connection = { status: 'empty' }
        broadcastState()
        const renderer = mainWindow?.webContents
        if (renderer && !renderer.getURL().startsWith('treeport-app://')) {
          yield* loadRenderer(renderer, PRIVATE_RENDERER_URL)
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
      // Keep navigation recovery owned by this connection, so switching
      // computers or closing the window also cancels pending retries.
      // getURL() can already equal the target after a failed navigation.
      const rendererLoad = yield* Effect.fork(
        renderer ? loadRenderer(renderer, requestedUrl) : Effect.void
      )

      yield* Stream.runForEach(watchBackendHealth(computer.origin), (health) =>
        Effect.gen(function* () {
          if (generation !== connectionGeneration) {
            return
          }

          if (!health) {
            if (!unavailableVisible) {
              unavailableVisible = true
              connection = {
                status: 'unavailable',
                computerId: computer.id,
                message: unavailableMessage
              }
              broadcastState()
            }

            return
          }

          if (health.hostname && store) {
            yield* store.rememberHostname(computer.id, health.hostname)
            if (generation !== connectionGeneration) {
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
        })
      )
      // Health can become ready before the renderer dev server does.
      yield* Fiber.join(rendererLoad)
    })
  )
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
  const options: BrowserWindowConstructorOptions = {
    show: !desktopE2e,
    width: restoredBounds?.width ?? DEFAULT_WINDOW_WIDTH,
    height: restoredBounds?.height ?? DEFAULT_WINDOW_HEIGHT,
    minWidth: MINIMUM_WINDOW_WIDTH,
    minHeight: MINIMUM_WINDOW_HEIGHT,
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

  if (!app.isPackaged) {
    options.title = app.name
    options.icon = path.join(app.getAppPath(), 'assets/treeport-dev-icon.png')
  }

  if (restoredBounds) {
    options.x = restoredBounds.x
    options.y = restoredBounds.y
  }

  if (process.platform === 'darwin') {
    options.trafficLightPosition = { x: 12, y: 9 }
  }

  const window = new BrowserWindow(options)
  if (windowState?.maximized) {
    window.maximize()
  }

  const runtime = new DesktopRuntime(desktopRuntime)
  mainWindow = window
  windowRuntime = runtime
  installRendererSecurity(window.webContents)
  browserWebviews = installBrowserWebviewPolicy({
    runtime,
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
  window.on('close', () => {
    persistWindowState(window)
  })
  window.on('closed', () => {
    stopBellAttention()
    if (mainWindow === window) {
      mainWindow = null
      browserWebviews = null
      windowRuntime = null
      connectionFiber = null
      connectionGeneration += 1
      desktopRuntime.fork(runtime.close)
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
  ipcMain.handle('shell:select-computer', (event, id) =>
    desktopRuntime.run(
      Effect.gen(function* () {
        const parsedId = z.string().safeParse(id)
        if (!isTrustedRendererEvent(event) || !parsedId.success || !store) {
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
        if (!isTrustedRendererEvent(event) || !parsedInput.success || !store) {
          return { ok: false, error: 'Could not save the computer.' }
        }

        const { origin } = yield* Effect.try(() =>
          parseComputerUrl(parsedInput.data)
        )
        const duplicate = store.findByOrigin(origin)
        if (duplicate) {
          return {
            ok: false,
            error: `That URL is already saved as ${store.summaries().find((item) => item.id === duplicate.id)?.name ?? 'a computer'}.`,
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

        const result = yield* store.update(update.id, update)
        if (!result) {
          return { ok: false, error: 'That computer no longer exists.' }
        }

        if (result.originChanged && store.selectedComputer?.id === update.id) {
          void connectSelected()
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
        if (!isTrustedRendererEvent(event) || !parsedId.success || !store) {
          return false
        }

        const computerId = parsedId.data
        if (!store.getComputer(computerId)) {
          return false
        }

        const result = yield* store.remove(computerId)
        if (result.selectedChanged) {
          void connectSelected()
        } else {
          broadcastState()
        }

        return true
      })
    )
  )
  ipcMain.on('shell:retry-connection', (event) => {
    if (isTrustedRendererEvent(event)) {
      void connectSelected()
    }
  })
  ipcMain.on('shell:install-update', (event) => {
    if (!isTrustedRendererEvent(event)) {
      return
    }

    if (updateError) {
      desktopRuntime.fork(
        Effect.gen(function* () {
          const { response } = yield* Effect.tryPromise(() =>
            dialog.showMessageBox({
              type: 'error',
              title: 'Desktop update failed',
              message: 'Treeport could not install the desktop update.',
              detail: `${updateError}\nThe backend has not been changed. Install the latest desktop application manually, or wait for the next automatic check.`,
              buttons: ['Installation instructions', 'Dismiss'],
              cancelId: 1
            })
          )
          if (response === 0) {
            yield* Effect.tryPromise(() =>
              shell.openExternal(
                'https://treeport.app/getting-started/installation/'
              )
            )
          }
        })
      )
      return
    }

    if (!updateReady) {
      return
    }

    if (desktopE2e) {
      updateReady = false
      broadcastState()
      return
    }

    installUpdateOnQuit = true
    app.quit()
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
      ? desktopRuntime.run(
          browserWebviews.register(
            event,
            parsed.data.panelId,
            parsed.data.webContentsId,
            parsed.data.challenge
          )
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
      ? desktopRuntime.run(
          browserWebviews.command(
            event,
            parsed.data.panelId,
            parsed.data.command
          )
        )
      : { ok: false, error: 'The Browser command was rejected.' }
  })
  ipcMain.handle('native-browser:set-input-control', (event, value) => {
    const parsed = nativeBrowserInputControlSchema.safeParse(value)
    return parsed.success && browserWebviews
      ? desktopRuntime.run(
          browserWebviews.setInputControl(
            event,
            parsed.data.panelId,
            parsed.data.locked
          )
        )
      : false
  })
  ipcMain.handle('native-browser:request-close', (event, value) => {
    const parsed = nativeBrowserCloseSchema.safeParse(value)
    if (!parsed.success) {
      return false
    }

    return browserWebviews
      ? desktopRuntime.run(
          browserWebviews.requestClose(
            event,
            parsed.data.panelId,
            parsed.data.force
          )
        )
      : true
  })
  ipcMain.on('native-browser:dispose', (event, value) => {
    const parsed = nativeBrowserPanelSchema.safeParse(value)
    if (!parsed.success) {
      return
    }

    if (browserWebviews) {
      desktopRuntime.fork(browserWebviews.dispose(event, parsed.data.panelId))
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

      autoUpdater.on('error', (error) => {
        updateError = error.message
        updateReady = false
        broadcastState()
      })
      autoUpdater.on('update-not-available', () => {
        updateError = null
        broadcastState()
      })
      autoUpdater.on('update-downloaded', () => {
        updateError = null
        updateReady = true
        broadcastState()
      })
      if (app.isPackaged && process.platform === 'darwin' && !desktopE2e) {
        const updater = updateElectronApp({
          updateSource: {
            type: UpdateSourceType.ElectronPublicUpdateService,
            repo: 'noice-tech/treeport',
            host: 'https://update.electronjs.org'
          },
          updateInterval: '10 minutes',
          notifyUser: false
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => updater.stopUpdates())
        )
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
    // Do not close the root from one of its own fibers: closing joins children.
    void Effect.runPromiseExit(desktopRuntime.close).then((exit) => {
      if (exit._tag === 'Failure') {
        console.error('[Treeport] Desktop shutdown failed', exit.cause)
      }

      quitReady = true
      if (installUpdateOnQuit) {
        autoUpdater.quitAndInstall()
      } else {
        app.quit()
      }
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
