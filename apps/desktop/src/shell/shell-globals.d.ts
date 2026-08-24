import type {
  ComputerMutationResult,
  ComputerUpdate,
  DesktopNavigationDirection,
  DesktopShellState
} from '../desktop-contract'

declare global {
  interface Window {
    readonly treeportShell: Readonly<{
      getState: () => Promise<DesktopShellState>
      onState: (listener: (state: DesktopShellState) => void) => () => void
      onTerminalSelectionActive: (
        listener: (active: boolean) => void
      ) => () => void
      releaseTerminalSelection: () => void
      setOverlayActive: (active: boolean) => void
      selectComputer: (id: string) => Promise<boolean>
      addComputer: (origin: string) => Promise<ComputerMutationResult>
      updateComputer: (
        update: ComputerUpdate
      ) => Promise<ComputerMutationResult>
      removeComputer: (id: string) => Promise<boolean>
      retryConnection: () => void
      installUpdate: () => void
      navigateHistory: (direction: DesktopNavigationDirection) => void
      copyStartCommand: () => Promise<void>
      openInstallationDocs: () => Promise<void>
    }>
  }
}

export {}
