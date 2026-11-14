import type { TreeportTheme } from '@treeport/desktop-bridge'

export interface WorkspaceActivityResponse {
  working: number
  needsAttention: number
}

export interface PhoneAccessResponse {
  url: string | null
  error: string | null
  setupCommand: string | null
}

export interface ComputerActivity {
  id: string
  origin: string
  activity: WorkspaceActivityResponse | null
}

export type DesktopNavigationDirection = 'back' | 'forward'

export interface DesktopNavigationState {
  canGoBack: boolean
  canGoForward: boolean
}

export interface SavedComputer {
  id: string
  origin: string
  nameOverride?: string
  advertisedHostname?: string
  createdAt: string
  lastSelectedAt?: string
}

export interface DiscoveredComputer {
  name: string
  origin: string
}

export interface ComputerSummary extends SavedComputer {
  name: string
  selected: boolean
  loopback: boolean
}

export type ConnectionState =
  | { status: 'empty' }
  | { status: 'connecting'; computerId: string }
  | { status: 'ready'; computerId: string }
  | {
      status: 'unavailable'
      computerId: string
      message: string
    }

export interface LocalServerUpdateStep {
  label: string
  status: 'pending' | 'running' | 'done' | 'failed'
  seconds: number | null
}

export interface LocalServerUpdate {
  status: 'running' | 'updated' | 'failed'
  startedAt: number
  steps: LocalServerUpdateStep[]
  commits: number | null
  error: string | null
  output: string[]
}

export interface LocalServerState {
  status: 'idle' | 'starting' | 'failed' | 'stopped'
  chosen: boolean
  origin: string
  sourceRoot: string
  startedAt: number | null
  output: string[]
  error: string | null
  canStop: boolean
  update: LocalServerUpdate | null
}

export interface RemoteUpdateState {
  computerId: string
  name: string
  update: LocalServerUpdate
}

export interface DesktopShellState {
  packaged: boolean
  platform: NodeJS.Platform
  fullscreen: boolean
  selectedComputerId?: string
  computers: ComputerSummary[]
  discoveredComputers: DiscoveredComputer[]
  connection: ConnectionState
  updatesPaused: boolean
  localServer: LocalServerState | null
  remoteUpdates: RemoteUpdateState[]
  navigation: DesktopNavigationState
  theme: TreeportTheme
}

export type ComputerMutationResult =
  | { ok: true }
  | { ok: false; error: string; duplicateId?: string }

export interface ComputerUpdate {
  id: string
  origin: string
  nameOverride?: string
}
