import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ComputerMutationResult,
  ComputerUpdate,
  DesktopShellState
} from './desktop-contract.js'

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
  copyStartCommand(): Promise<void> {
    return ipcRenderer.invoke('shell:copy-start-command')
  },
  openInstallationDocs(): Promise<void> {
    return ipcRenderer.invoke('shell:open-installation-docs')
  }
})

contextBridge.exposeInMainWorld('treeportShell', shellBridge)
