export type DesktopCommand =
  | 'new-worktree'
  | 'new-terminal'
  | 'new-terminal-menu'
  | 'close-terminal'

export type DesktopFileActionResult = 'opened' | 'rejected'

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
  selectedComputerId?: string
  computers: ComputerSummary[]
  connection: ConnectionState
}

export type ComputerMutationResult =
  | { ok: true }
  | { ok: false; error: string; duplicateId?: string }

export interface ComputerUpdate {
  id: string
  origin: string
  nameOverride?: string
}
