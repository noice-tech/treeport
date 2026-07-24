import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type DesktopCommand = 'new-worktree' | 'new-terminal' | 'close-terminal'

contextBridge.exposeInMainWorld(
  'taskttyDesktop',
  Object.freeze({
    platform: process.platform,
    openFileUrl(url: string): Promise<boolean> {
      return ipcRenderer
        .invoke('open-file-url', url)
        .then((opened) => opened === true)
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
          value === 'close-terminal'
        ) {
          listener(value)
        }
      }
      ipcRenderer.on('desktop-command', receive)
      return () => ipcRenderer.removeListener('desktop-command', receive)
    }
  })
)

window.addEventListener('DOMContentLoaded', () => {
  document
    .querySelector('[data-tasktty-retry]')
    ?.addEventListener('click', () => ipcRenderer.send('retry-connection'))
})
