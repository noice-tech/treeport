/**
 * Cross-release terminal runtime contract.
 *
 * This module is deliberately data-only: the detached PTY owner outlives the
 * product daemon, so daemon, database, worktree, UI, and product-shared types
 * must adapt to these shapes rather than becoming runtime dependencies.
 */

export const TERMINAL_PROGRESS_STALE_MS = 5 * 60_000
export const TERMINAL_NAME_MAX_LENGTH = 120

interface TerminalSize {
  cols: number
  rows: number
}

export interface TerminalProgress {
  state: 'normal' | 'error' | 'indeterminate' | 'paused'
  value: number | null
}

export interface TerminalSnapshotLink {
  buffer: 'normal' | 'alternate'
  uri: string
  line: number
  startColumn: number
  endColumn: number
}

interface TerminalImageCommand {
  columns?: number
  rows?: number
  x?: number
  y?: number
  sourceWidth?: number
  sourceHeight?: number
  xOffset?: number
  yOffset?: number
  zIndex?: number
  cursorMovement?: number
  placementId?: number
}

export interface TerminalImagePlacement {
  imageId: number
  command: TerminalImageCommand
  cellSize: { width: number; height: number }
  buffer: 'normal' | 'alternate'
  tiles: [number, number, number, number][]
}

export interface TerminalImageSnapshot {
  nextImageId: number
  images: ReadonlyArray<{
    id: number
    data: string
    width: number
    height: number
    format: number
    compression: string
  }>
  placements: readonly TerminalImagePlacement[]
  pending: string
}

interface TerminalSetupTask {
  label: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
}

export interface TerminalLaunchSpec {
  argv: string[]
  initialTitle?: string | undefined
  fallbackArgv?: string[] | undefined
  cwd: string
  env: Record<string, string>
  shellIntegrationDir?: string | undefined
  setupTasks?: TerminalSetupTask[] | undefined
  setupError?: string | undefined
}

export interface TerminalSessionState {
  status: 'running' | 'exited' | 'missing'
  exitCode: number | null
}

export interface TerminalTitleState {
  terminalTitle: string | null
  currentCommand: string | null
  commandLine?: string | null | undefined
}

export interface HostedTerminal {
  id: string
  worktreeId: string
  name: string
  argv: string[]
  shellCommand: string | null
  interactiveShell: boolean
  closeOnSuccess: boolean
  status: 'running' | 'exited'
  exitCode: number | null
  createdAt: string
  updatedAt: string
}

export interface TerminalProcess {
  pid: number
  terminalId: string
}

export interface TerminalCreateInput {
  terminalId: string
  worktreeId: string
  name: string
  createdAt: string
  cwd: string
  argv: string[]
  initialTitle?: string | undefined
  shellCommand: string | null
  interactiveShell: boolean
  fallbackArgv?: string[] | undefined
  closeOnSuccess?: boolean | undefined
  initialSize?: TerminalSize | undefined
  env: Record<string, string>
  setupTasks?: TerminalSetupTask[] | undefined
  setupError?: string | undefined
}

export interface TerminalTraceContext {
  traceId: string
  spanId: string
  sampled: boolean
}

export interface TerminalHostRuntimeEvent {
  title?: string | undefined
  progress?: TerminalProgress | null | undefined
  bell?: { sequence: number; at: string } | undefined
  exitCode?: number | null | undefined
  titleState?: TerminalTitleState | undefined
}

export interface TerminalHostOutput {
  data: string
  sequence: number
}

export interface TerminalHostSnapshot {
  data: string
  links: TerminalSnapshotLink[]
  images: TerminalImageSnapshot | null
  fence: number
  cols: number
  rows: number
}

export function parseTerminalProgress(
  data: string
): TerminalProgress | null | undefined {
  const [command, rawState, rawValue, ...extra] = data.split(';')
  if (command !== '4' || extra.length > 0 || !/^[0-4]$/.test(rawState ?? '')) {
    return undefined
  }

  const state = Number(rawState)
  if (state === 0) {
    return null
  }

  if (
    rawValue !== undefined &&
    rawValue !== '' &&
    !/^\d{1,3}$/.test(rawValue)
  ) {
    return undefined
  }

  const value =
    rawValue === undefined || rawValue === '' ? null : Number(rawValue)
  if (value !== null && value > 100) {
    return undefined
  }

  const states = [
    undefined,
    'normal',
    'error',
    'indeterminate',
    'paused'
  ] as const
  return { state: states[state]!, value }
}
