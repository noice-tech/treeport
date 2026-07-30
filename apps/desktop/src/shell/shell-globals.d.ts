import type {
  ComputerMutationResult,
  ComputerUpdate,
  DesktopShellState
} from '../desktop-contract'

declare global {
  interface Window {
    readonly treeportShell: Readonly<{
      getState: () => Promise<DesktopShellState>
      onState: (listener: (state: DesktopShellState) => void) => () => void
      onComputerSelectorDismiss: (listener: () => void) => () => void
      selectComputer: (id: string) => Promise<boolean>
      addComputer: (origin: string) => Promise<ComputerMutationResult>
      updateComputer: (
        update: ComputerUpdate
      ) => Promise<ComputerMutationResult>
      removeComputer: (id: string) => Promise<boolean>
      retryConnection: () => void
      copyStartCommand: () => Promise<void>
      openInstallationDocs: () => Promise<void>
    }>
  }
}

export {}
