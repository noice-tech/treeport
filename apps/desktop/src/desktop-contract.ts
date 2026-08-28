export type DesktopCommand =
  | 'new-worktree'
  | 'new-terminal'
  | 'new-panel'
  | 'close-panel'
  | 'toggle-side-panel'
  | 'focus-location'
  | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

export type DesktopFileActionResult = 'opened' | 'rejected'

export type DesktopNavigationDirection = 'back' | 'forward'

export interface DesktopNavigationState {
  canGoBack: boolean
  canGoForward: boolean
}

export interface DesktopBrowserPopup {
  panelId: string
  url: string
}

export interface DesktopBrowserBridgeDescriptor {
  endpoint: string
  panelId: string
  challenge: string
}

export type DesktopBrowserToolbarCommand =
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'stop' }

export interface DesktopBrowserCommandResult {
  ok: boolean
  error: string | null
}

export interface SavedComputer {
  id: string
  origin: string
  nameOverride?: string
  advertisedHostname?: string
  createdAt: string
  lastSelectedAt?: string
}

export interface ComputerSummary extends SavedComputer {
  name: string
  selected: boolean
  loopback: boolean
}

export type ConnectionState =
  | { status: 'empty' }
  | { status: 'connecting'; computerId: string }
  | {
      status: 'ready'
      computerId: string
      serverVersion: string
      url: string
    }
  | {
      status: 'unavailable'
      computerId: string
      message: string
    }
  | {
      status: 'incompatible'
      computerId: string
      serverVersion: string
      receivedProtocolVersion: number
      expectedProtocolVersion: number
    }

export interface DesktopShellState {
  appVersion: string
  platform: NodeJS.Platform
  fullscreen: boolean
  updateReady: boolean
  selectedComputerId?: string
  computers: ComputerSummary[]
  connection: ConnectionState
  navigation: DesktopNavigationState
}

export type ComputerMutationResult =
  | { ok: true }
  | { ok: false; error: string; duplicateId?: string }

export interface ComputerUpdate {
  id: string
  origin: string
  nameOverride?: string
}
