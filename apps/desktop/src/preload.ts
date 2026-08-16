import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { z } from 'zod'
import type {
  DesktopCommand,
  DesktopFileActionResult
} from './desktop-contract'

const desktopBridge = Object.freeze({
  platform: process.platform,
  openFileUrl(url: string): Promise<DesktopFileActionResult> {
    return ipcRenderer
      .invoke('open-file-url', url)
      .then((result) => (result === 'opened' ? result : 'rejected'))
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
