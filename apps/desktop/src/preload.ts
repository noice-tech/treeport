import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent
} from 'electron'
import { z } from 'zod'
import type {
  DesktopBrowserBounds,
  DesktopBrowserCommand,
  DesktopBrowserPopup,
  DesktopBrowserState,
  DesktopCommand,
  DesktopFileActionResult
} from './desktop-contract'

const localSourcePathResultSchema = z.string().nullable().catch(null)
const localSourcePathsResultSchema = z.array(z.string()).max(1).catch([])
const localFilePasteListeners = new Set<(paths: string[]) => void>()
const desktopBrowserStateSchema: z.ZodType<DesktopBrowserState> =
  z.strictObject({
    panelId: z.string(),
    url: z.string(),
    title: z.string(),
    loading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean()
  })
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
  openBrowser(
    panelId: string,
    url: string
  ): Promise<DesktopBrowserState | null> {
    return ipcRenderer
      .invoke('native-browser:open', { panelId, url })
      .then((value) => desktopBrowserStateSchema.nullable().parse(value))
  },
  setBrowserBounds(panelId: string, bounds: DesktopBrowserBounds) {
    ipcRenderer.send('native-browser:set-bounds', { panelId, bounds })
  },
  setBrowserVisible(panelId: string, visible: boolean) {
    ipcRenderer.send('native-browser:set-visible', { panelId, visible })
  },
  sendBrowserCommand(panelId: string, command: DesktopBrowserCommand) {
    ipcRenderer.send('native-browser:command', { panelId, command })
  },
  resetBrowser(panelId: string): Promise<DesktopBrowserState | null> {
    return ipcRenderer
      .invoke('native-browser:reset', { panelId })
      .then((value) => desktopBrowserStateSchema.nullable().parse(value))
  },
  requestBrowserClose(panelId: string, force: boolean): Promise<boolean> {
    return ipcRenderer
      .invoke('native-browser:request-close', { panelId, force })
      .then((value) => z.boolean().parse(value))
  },
  disposeBrowser(panelId: string) {
    ipcRenderer.send('native-browser:dispose', { panelId })
  },
  onBrowserState(listener: (state: DesktopBrowserState) => void) {
    const receive: Parameters<typeof ipcRenderer.on>[1] = (_event, value) => {
      const parsed = desktopBrowserStateSchema.safeParse(value)
      if (parsed.success) {
        listener(parsed.data)
      }
    }
    ipcRenderer.on('native-browser:state', receive)
    return () => ipcRenderer.removeListener('native-browser:state', receive)
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

contextBridge.exposeInMainWorld('treeportDesktop', desktopBridge)
