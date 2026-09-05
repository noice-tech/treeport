import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent
} from 'electron'
import { z } from 'zod'
import type {
  ComputerMutationResult,
  ComputerUpdate,
  DesktopBrowserBridgeDescriptor,
  DesktopBrowserCommandResult,
  DesktopBrowserPopup,
  DesktopBrowserToolbarCommand,
  DesktopBrowserUnavailable,
  DesktopCommand,
  DesktopFileActionResult,
  DesktopNavigationDirection,
  DesktopShellState
} from './desktop-contract'

const localSourcePathResultSchema = z.string().nullable().catch(null)
const localSourcePathsResultSchema = z.array(z.string()).max(1).catch([])
const localFilePasteListeners = new Set<(paths: string[]) => void>()
const desktopBrowserPopupSchema: z.ZodType<DesktopBrowserPopup> =
  z.strictObject({
    panelId: z.string(),
    url: z.string()
  })
const desktopBrowserUnavailableSchema: z.ZodType<DesktopBrowserUnavailable> =
  z.strictObject({ panelId: z.string(), message: z.string() })
const desktopBrowserBridgeDescriptorSchema: z.ZodType<DesktopBrowserBridgeDescriptor> =
  z.strictObject({
    endpoint: z.string().url(),
    panelId: z.string(),
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
          'new-panel',
          'close-panel',
          'toggle-side-panel',
          'focus-location',
          'find-in-page',
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
    panelId: string,
    webContentsId: number,
    challenge: string
  ): Promise<DesktopBrowserBridgeDescriptor | null> {
    return ipcRenderer
      .invoke('native-browser:register', {
        panelId,
        webContentsId,
        challenge
      })
      .then((value) =>
        desktopBrowserBridgeDescriptorSchema.nullable().parse(value)
      )
  },
  browserCommand(
    panelId: string,
    command: DesktopBrowserToolbarCommand
  ): Promise<DesktopBrowserCommandResult> {
    return ipcRenderer
      .invoke('native-browser:command', { panelId, command })
      .then((value) => desktopBrowserCommandResultSchema.parse(value))
  },
  setBrowserInputControl(panelId: string, locked: boolean): Promise<boolean> {
    return ipcRenderer
      .invoke('native-browser:set-input-control', { panelId, locked })
      .then((value) => z.boolean().parse(value))
  },
  requestBrowserClose(panelId: string, force: boolean): Promise<boolean> {
    return ipcRenderer
      .invoke('native-browser:request-close', { panelId, force })
      .then((value) => z.boolean().parse(value))
  },
  disposeBrowser(panelId: string) {
    ipcRenderer.send('native-browser:dispose', { panelId })
  },
  onBrowserFocus(listener: (panelId: string) => void) {
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
})

const shellBridge = Object.freeze({
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
  copyUpdateCommand(): Promise<void> {
    return ipcRenderer.invoke('shell:copy-update-command')
  },
  openInstallationDocs(): Promise<void> {
    return ipcRenderer.invoke('shell:open-installation-docs')
  }
})

contextBridge.exposeInMainWorld('treeportDesktop', desktopBridge)
contextBridge.exposeInMainWorld('treeportShell', shellBridge)
