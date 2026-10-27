import type { PhoneAccessResponse } from '../desktop-contract'
import type {
  ComputerActivity,
  ComputerMutationResult,
  ComputerUpdate,
  DesktopNavigationDirection,
  DesktopShellState
} from '../desktop-contract'

declare global {
  interface Window {
    readonly treeportShell: Readonly<{
      setOverlayOpen: (open: boolean) => void
      computerActivity: () => Promise<ComputerActivity[]>
      getState: () => Promise<DesktopShellState>
      onState: (listener: (state: DesktopShellState) => void) => () => void
      onTerminalSelectionActive: (
        listener: (active: boolean) => void
      ) => () => void
      onAttentionSound: (listener: () => void) => () => void
      releaseTerminalSelection: () => void
      copyPhoneLink: (url: string) => Promise<boolean>
      phoneAccess: (id: string) => Promise<PhoneAccessResponse>
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
