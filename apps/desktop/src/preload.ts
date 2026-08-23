import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent
} from 'electron'
import { z } from 'zod'
import type {
  DesktopCommand,
  DesktopFileActionResult
} from './desktop-contract'

const localSourcePathResultSchema = z.string().nullable().catch(null)
const localSourcePathsResultSchema = z.array(z.string()).max(1).catch([])
const localFilePasteListeners = new Set<(paths: string[]) => void>()

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
  requestAttention() {
    ipcRenderer.send('bell-attention:request')
  }
})

contextBridge.exposeInMainWorld('treeportDesktop', desktopBridge)
