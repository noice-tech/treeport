import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  DesktopCommand,
  DesktopFileActionResult
} from './desktop-contract.js'

const desktopBridge = Object.freeze({
  platform: process.platform,
  openFileUrl(url: string): Promise<DesktopFileActionResult> {
    return ipcRenderer
      .invoke('open-file-url', url)
      .then((result: unknown) => (result === 'opened' ? result : 'rejected'))
  },
  onFullscreenChange(listener: (fullscreen: boolean) => void) {
    const receive = (_event: IpcRendererEvent, value: unknown) => {
      if (typeof value === 'boolean') {
        listener(value)
      }
    }
    ipcRenderer.on('fullscreen-change', receive)
    return () => ipcRenderer.removeListener('fullscreen-change', receive)
  },
  onCommand(listener: (command: DesktopCommand) => void) {
    const receive = (_event: IpcRendererEvent, value: unknown) => {
      if (
        value === 'new-worktree' ||
        value === 'new-terminal' ||
        value === 'new-terminal-menu' ||
        value === 'close-terminal'
      ) {
        listener(value)
      }
    }
    ipcRenderer.on('desktop-command', receive)
    return () => ipcRenderer.removeListener('desktop-command', receive)
  },
  requestAttention() {
    ipcRenderer.send('bell-attention:request')
  }
})

contextBridge.exposeInMainWorld('treeportDesktop', desktopBridge)
