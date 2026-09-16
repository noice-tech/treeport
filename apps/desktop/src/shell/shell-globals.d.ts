import type {
  ComputerDetails,
  ComputerMutationResult,
  ComputerUpdate,
  DesktopNavigationDirection,
  DesktopShellState,
  LocalControlAction,
  LocalControlOperationResult
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
      inspectComputer: (id: string) => Promise<ComputerDetails | null>
      copyComputerDiagnostics: (id: string) => Promise<boolean>
      controlComputer: (
        id: string,
        action: LocalControlAction
      ) => Promise<LocalControlOperationResult>
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
      copyUpdateCommand: () => Promise<void>
      openInstallationDocs: () => Promise<void>
    }>
  }
}

export {}
