import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent
} from 'electron'
import { z } from 'zod'
import { phoneAccessResponseSchema } from './shell-metadata'
import type { PhoneAccessResponse } from './desktop-contract'
import type {
  DesktopBridge,
  DesktopBrowserBridgeDescriptor,
  DesktopBrowserCommandResult,
  DesktopBrowserPopup,
  DesktopBrowserPermissionPrompt,
  DesktopBrowserPermissions,
  DesktopBrowserToolbarCommand,
  DesktopBrowserUnavailable,
  DesktopCommand,
  DesktopFileActionResult
} from '@treeport/desktop-bridge'
import type {
  ComputerActivity,
  ComputerMutationResult,
  ComputerUpdate,
  DesktopNavigationDirection,
  DesktopShellState
} from './desktop-contract'

const localSourcePathResultSchema = z.string().nullable().catch(null)
const localSourcePathsResultSchema = z.array(z.string()).max(1).catch([])
const localFilePasteListeners = new Set<(paths: string[]) => void>()
const desktopBrowserPopupSchema: z.ZodType<DesktopBrowserPopup> =
  z.strictObject({
    appId: z.string(),
    url: z.string()
  })
const desktopBrowserPermissionsSchema: z.ZodType<DesktopBrowserPermissions> =
  z.strictObject({
    origin: z.string().nullable(),
    decisions: z.array(
      z.strictObject({
        capability: z.string(),
        label: z.string(),
        allowed: z.boolean()
      })
    )
  })
const desktopBrowserPermissionPromptSchema: z.ZodType<DesktopBrowserPermissionPrompt> =
  z.strictObject({
    id: z.string().uuid(),
    appId: z.string(),
    origin: z.string(),
    capability: z.string(),
    destination: z.string().nullable()
  })
const desktopBrowserUnavailableSchema: z.ZodType<DesktopBrowserUnavailable> =
  z.strictObject({ appId: z.string(), message: z.string() })
const desktopBrowserBridgeDescriptorSchema: z.ZodType<DesktopBrowserBridgeDescriptor> =
  z.strictObject({
    endpoint: z.string().url(),
    appId: z.string(),
    challenge: z.string()
  })
const desktopBrowserCommandResultSchema: z.ZodType<DesktopBrowserCommandResult> =
  z.strictObject({ ok: z.boolean(), error: z.string().nullable() })

window.addEventListener(
  'paste',
  (event) => {
    if (!event.isTrusted || localFilePasteListeners.size === 0) {
      return
    }

    const files = Array.from(event.clipboardData?.files ?? [])
    if (
      files.length > 1 ||
      (files.length === 1 && webUtils.getPathForFile(files[0]!)) ||
      !event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            target.classList.contains('terminal-session-host')
        )
    ) {
      return
    }

    const paths = localSourcePathsResultSchema.parse(
      ipcRenderer.sendSync('terminal-file:read-clipboard-source-paths')
    )
    if (!paths.length) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    for (const listener of localFilePasteListeners) {
      listener(paths)
    }
  },
  true
)

const desktopBridge = Object.freeze({
  platform: process.platform,
  // Native context is synchronous, so a local browser never briefly starts
  // the daemon-hosted implementation while waiting for desktop metadata.
  runtime:
    process.isMainFrame &&
    ['http:', 'https:'].includes(window.location.protocol)
      ? z
          .object({ computerId: z.string(), localBrowser: z.boolean() })
          .nullable()
          .parse(ipcRenderer.sendSync('desktop:runtime'))
      : null,
  openBrowserDevtools(appId: string): Promise<boolean> {
    return ipcRenderer
      .invoke('hosted-browser:open-devtools', {
        appId,
        backendNodeId: null,
        targetId: null
      })
      .then((value) => z.boolean().parse(value))
  },
  inspectBrowserElement(
    appId: string,
    backendNodeId: number,
    targetId: string | null
  ): Promise<boolean> {
    return ipcRenderer
      .invoke('hosted-browser:open-devtools', {
        appId,
        backendNodeId,
        targetId
      })
      .then((value) => z.boolean().parse(value))
  },
  openFileUrl(url: string): Promise<DesktopFileActionResult> {
    return ipcRenderer
      .invoke('open-file-url', url)
      .then((result) => (result === 'opened' ? result : 'rejected'))
  },
  getPathForFile(file: File): Promise<string | null> {
    const filePath = webUtils.getPathForFile(file)
    if (!filePath) {
      return Promise.resolve(null)
    }

    return ipcRenderer
      .invoke('terminal-file:resolve-source-path', filePath)
      .then((result) => localSourcePathResultSchema.parse(result))
  },
  onLocalFilePaste(listener: (paths: string[]) => void) {
    localFilePasteListeners.add(listener)
    return () => localFilePasteListeners.delete(listener)
  },
  onFullscreenChange(listener: (fullscreen: boolean) => void) {
    const receive: Parameters<typeof ipcRenderer.on>[1] = (
      _event: IpcRendererEvent,
      value
    ) => {
      const parsed = z.boolean().safeParse(value)
      if (parsed.success) {
        listener(parsed.data)
      }
    }
    ipcRenderer.on('fullscreen-change', receive)
    return () => ipcRenderer.removeListener('fullscreen-change', receive)
  },
  onCommand(listener: (command: DesktopCommand) => void) {
    const receive: Parameters<typeof ipcRenderer.on>[1] = (
      _event: IpcRendererEvent,
      value
    ) => {
      const parsed = z
        .enum([
          'new-worktree',
          'new-terminal',
          'split-terminal-left',
          'split-terminal-right',
          'split-terminal-up',
          'split-terminal-down',
          'new-app',
          'close-app',
          'toggle-side-panel',
          'focus-location',
          'find-in-page',
          'reload',
          'zoom-in',
          'zoom-out',
          'zoom-reset',
          'select-previous-worktree',
          'select-next-worktree',
          'select-tab-1',
          'select-tab-2',
          'select-tab-3',
          'select-tab-4',
          'select-tab-5',
          'select-tab-6',
          'select-tab-7',
          'select-tab-8',
          'select-tab-9'
        ])
        .safeParse(value)
      if (parsed.success) {
        listener(parsed.data)
      }
    }
    ipcRenderer.on('desktop-command', receive)
    return () => ipcRenderer.removeListener('desktop-command', receive)
  },
  zoomPage(action: 'zoom-in' | 'zoom-out' | 'zoom-reset') {
    ipcRenderer.send('desktop:zoom-page', action)
  },
  setTerminalSelectionActive(active: boolean) {
    ipcRenderer.send('terminal-selection:set-active', active)
  },
  onTerminalSelectionRelease(listener: () => void) {
    const receive = () => listener()
    ipcRenderer.on('terminal-selection:release', receive)
    return () =>
      ipcRenderer.removeListener('terminal-selection:release', receive)
  },
  registerBrowser(
    appId: string,
    webContentsId: number,
    challenge: string
  ): Promise<DesktopBrowserBridgeDescriptor | null> {
    return ipcRenderer
      .invoke('native-browser:register', {
        appId,
        webContentsId,
        challenge
      })
      .then((value) =>
        desktopBrowserBridgeDescriptorSchema.nullable().parse(value)
      )
  },
  browserCommand(
    appId: string,
    command: DesktopBrowserToolbarCommand
  ): Promise<DesktopBrowserCommandResult> {
    return ipcRenderer
      .invoke('native-browser:command', { appId, command })
      .then((value) => desktopBrowserCommandResultSchema.parse(value))
  },
  setBrowserInputControl(appId: string, locked: boolean): Promise<boolean> {
    return ipcRenderer
      .invoke('native-browser:set-input-control', { appId, locked })
      .then((value) => z.boolean().parse(value))
  },
  setBrowserPresentationActive(
    appId: string,
    active: boolean
  ): Promise<boolean> {
    return ipcRenderer
      .invoke('native-browser:set-presentation-active', { appId, active })
      .then((value) => z.boolean().parse(value))
  },
  requestBrowserClose(appId: string, force: boolean): Promise<boolean> {
    return ipcRenderer
      .invoke('native-browser:request-close', { appId, force })
      .then((value) => z.boolean().parse(value))
  },
  disposeBrowser(appId: string) {
    ipcRenderer.send('native-browser:dispose', { appId })
  },
  onBrowserFocus(listener: (appId: string) => void) {
    const receive: Parameters<typeof ipcRenderer.on>[1] = (_event, value) => {
      const parsed = z.string().safeParse(value)
      if (parsed.success) {
        listener(parsed.data)
      }
    }
    ipcRenderer.on('native-browser:focus', receive)
    return () => ipcRenderer.removeListener('native-browser:focus', receive)
  },
  onBrowserPopup(listener: (popup: DesktopBrowserPopup) => void) {
    const receive: Parameters<typeof ipcRenderer.on>[1] = (_event, value) => {
      const parsed = desktopBrowserPopupSchema.safeParse(value)
      if (parsed.success) {
        listener(parsed.data)
      }
    }
    ipcRenderer.on('native-browser:popup', receive)
    return () => ipcRenderer.removeListener('native-browser:popup', receive)
  },
  browserPermissions(appId: string): Promise<DesktopBrowserPermissions | null> {
    return ipcRenderer
      .invoke('native-browser:permissions', { appId })
      .then((value) => desktopBrowserPermissionsSchema.nullable().parse(value))
  },
  resetBrowserPermissions(
    appId: string,
    origin: string,
    capability: string | null
  ): Promise<boolean> {
    return ipcRenderer
      .invoke('native-browser:reset-permissions', {
        appId,
        origin,
        capability
      })
      .then((value) => z.boolean().parse(value))
  },
  onBrowserPermissionPrompt(
    listener: (prompt: DesktopBrowserPermissionPrompt | null) => void
  ) {
    const receive: Parameters<typeof ipcRenderer.on>[1] = (_event, value) => {
      if (value === null) {
        listener(null)
        return
      }

      const parsed = desktopBrowserPermissionPromptSchema.safeParse(value)
      if (parsed.success) {
        listener(parsed.data)
      }
    }
    ipcRenderer.on('native-browser:permission-prompt', receive)
    return () =>
      ipcRenderer.removeListener('native-browser:permission-prompt', receive)
  },
  respondBrowserPermission(id: string, allow: boolean) {
    ipcRenderer.send('native-browser:permission-response', { id, allow })
  },
  onBrowserUnavailable(listener: (failure: DesktopBrowserUnavailable) => void) {
    const receive: Parameters<typeof ipcRenderer.on>[1] = (_event, value) => {
      const parsed = desktopBrowserUnavailableSchema.safeParse(value)
      if (parsed.success) {
        listener(parsed.data)
      }
    }
    ipcRenderer.on('native-browser:unavailable', receive)
    return () =>
      ipcRenderer.removeListener('native-browser:unavailable', receive)
  },
  requestAttention() {
    ipcRenderer.send('bell-attention:request')
  }
} satisfies Required<DesktopBridge>)

const shellBridge = Object.freeze({
  setOverlayOpen(open: boolean) {
    ipcRenderer.send('shell:set-overlay-open', open)
  },
  computerActivity(): Promise<ComputerActivity[]> {
    return ipcRenderer.invoke('shell:computer-activity')
  },
  getState(): Promise<DesktopShellState> {
    return ipcRenderer.invoke('shell:get-state')
  },
  onState(listener: (state: DesktopShellState) => void) {
    const receive = (_event: IpcRendererEvent, state: DesktopShellState) =>
      listener(state)
    ipcRenderer.on('shell:state', receive)
    return () => ipcRenderer.removeListener('shell:state', receive)
  },
  onTerminalSelectionActive(listener: (active: boolean) => void) {
    const receive = (_event: IpcRendererEvent, active: boolean) =>
      listener(active)
    ipcRenderer.on('terminal-selection:active', receive)
    return () =>
      ipcRenderer.removeListener('terminal-selection:active', receive)
  },
  releaseTerminalSelection(): void {
    ipcRenderer.send('shell:terminal-selection-release')
  },
  copyPhoneLink(url: string): Promise<boolean> {
    return ipcRenderer
      .invoke('shell:copy-phone-link', url)
      .then((value) => z.boolean().parse(value))
  },
  phoneAccess(id: string): Promise<PhoneAccessResponse> {
    return ipcRenderer.invoke('shell:phone-access', id).then(
      (value) =>
        phoneAccessResponseSchema.safeParse(value).data ?? {
          url: null,
          error: 'Could not check remote access.',
          setupCommand: null
        }
    )
  },
  selectComputer(id: string): Promise<boolean> {
    return ipcRenderer.invoke('shell:select-computer', id)
  },
  addComputer(origin: string): Promise<ComputerMutationResult> {
    return ipcRenderer.invoke('shell:add-computer', origin)
  },
  updateComputer(update: ComputerUpdate): Promise<ComputerMutationResult> {
    return ipcRenderer.invoke('shell:update-computer', update)
  },
  removeComputer(id: string): Promise<boolean> {
    return ipcRenderer.invoke('shell:remove-computer', id)
  },
  retryConnection(): void {
    ipcRenderer.send('shell:retry-connection')
  },
  installUpdate(): void {
    ipcRenderer.send('shell:install-update')
  },
  navigateHistory(direction: DesktopNavigationDirection): void {
    ipcRenderer.send('shell:navigate-history', direction)
  },
  copyStartCommand(): Promise<void> {
    return ipcRenderer.invoke('shell:copy-start-command')
  },
  openInstallationDocs(): Promise<void> {
    return ipcRenderer.invoke('shell:open-installation-docs')
  }
})

// The private shell owns installation controls. Workspace pages get only
// optional native enhancements; neither subframes nor browser guests get them.
if (process.isMainFrame) {
  if (window.location.protocol === 'treeport-app:') {
    contextBridge.exposeInMainWorld('treeportShell', shellBridge)
  } else if (['http:', 'https:'].includes(window.location.protocol)) {
    contextBridge.exposeInMainWorld('treeportDesktop', desktopBridge)
  }
}
