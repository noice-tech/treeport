import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type TerminalCommand = 'new-terminal' | 'close-terminal'

contextBridge.exposeInMainWorld(
  'taskttyDesktop',
  Object.freeze({
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
