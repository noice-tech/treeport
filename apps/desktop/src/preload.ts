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
  DesktopBrowserPopup,
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
        .enum(['new-worktree', 'new-terminal', 'new-panel', 'close-panel'])
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
  registerBrowser(panelId: string, webContentsId: number): Promise<boolean> {
    return ipcRenderer
      .invoke('native-browser:register', { panelId, webContentsId })
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
  openInstallationDocs(): Promise<void> {
    return ipcRenderer.invoke('shell:open-installation-docs')
  }
})

contextBridge.exposeInMainWorld('treeportDesktop', desktopBridge)
contextBridge.exposeInMainWorld('treeportShell', shellBridge)
