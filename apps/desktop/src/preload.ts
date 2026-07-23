import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type TerminalCommand = 'new-terminal' | 'close-terminal'

contextBridge.exposeInMainWorld(
  'taskttyDesktop',
  Object.freeze({
    platform: process.platform,
    onFullscreenChange(listener: (fullscreen: boolean) => void) {
      const receive = (_event: IpcRendererEvent, value: unknown) => {
        if (typeof value === 'boolean') {
          listener(value)
        }
      }
      ipcRenderer.on('fullscreen-change', receive)
      return () => ipcRenderer.removeListener('fullscreen-change', receive)
    },
    onTerminalCommand(listener: (command: TerminalCommand) => void) {
      const receive = (_event: IpcRendererEvent, value: unknown) => {
        if (value === 'new-terminal' || value === 'close-terminal') {
          listener(value)
        }
      }
      ipcRenderer.on('terminal-command', receive)
      return () => ipcRenderer.removeListener('terminal-command', receive)
    }
  })
)

window.addEventListener('DOMContentLoaded', () => {
  document
    .querySelector('[data-tasktty-retry]')
    ?.addEventListener('click', () => ipcRenderer.send('retry-connection'))
})
