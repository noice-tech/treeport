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
      setDockIcon: (png: string) => void
      computerActivity: () => Promise<ComputerActivity[]>
      getState: () => Promise<DesktopShellState>
      onState: (listener: (state: DesktopShellState) => void) => () => void
      onTerminalSelectionActive: (
        listener: (active: boolean) => void
      ) => () => void
      onAttentionSound: (listener: () => void) => () => void
      releaseTerminalSelection: () => void
      copyPhoneLink: (url: string) => Promise<boolean>
      phoneAccess: (id: string, enable: boolean) => Promise<PhoneAccessResponse>
      selectComputer: (id: string) => Promise<boolean>
      addComputer: (origin: string) => Promise<ComputerMutationResult>
      updateComputer: (
        update: ComputerUpdate
      ) => Promise<ComputerMutationResult>
      removeComputer: (id: string) => Promise<boolean>
      retryConnection: () => void
      navigateHistory: (direction: DesktopNavigationDirection) => void
      copyStartCommand: () => Promise<void>
      openInstallationDocs: () => Promise<void>
      startLocalServer: () => Promise<void>
      showLocalServerLogs: () => Promise<void>
      openLocalServerSource: () => Promise<void>
      showUpdateLog: (computerId: string | null) => Promise<void>
      dismissUpdate: (computerId: string | null) => Promise<void>
    }>
  }
}

export {}
