import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  DesktopCommand,
  DesktopFileActionResult
} from './desktop-contract'

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
  onCommand(
    listener: (command: DesktopCommand, workspaceIndex: number | null) => void
  ) {
    const receive = (
      _event: IpcRendererEvent,
      value: unknown,
      workspaceIndex: unknown
    ) => {
      if (value === 'select-workspace') {
        if (
          typeof workspaceIndex === 'number' &&
          Number.isInteger(workspaceIndex) &&
          workspaceIndex >= 0 &&
          workspaceIndex <= 8
        ) {
          listener(value, workspaceIndex)
        }

        return
      }

      if (
        value === 'new-worktree' ||
        value === 'new-terminal' ||
        value === 'new-panel' ||
        value === 'close-panel'
      ) {
        listener(value, null)
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
