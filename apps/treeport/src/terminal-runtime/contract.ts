/**
 * Cross-release terminal runtime contract.
 *
 * This module is deliberately data-only: the detached PTY owner outlives the
 * product daemon, so daemon, database, worktree, UI, and product-shared types
 * must adapt to these shapes rather than becoming runtime dependencies.
 */

export const TERMINAL_PROGRESS_STALE_MS = 5 * 60_000
export const TERMINAL_NAME_MAX_LENGTH = 120
/** Private OSC carrying `command;<line>` from Treeport shell integration. */
export const TERMINAL_COMMAND_OSC = 7740

interface TerminalSize {
  cols: number
  rows: number
}

export interface TerminalActivity {
  state: 'idle' | 'working' | 'blocked' | 'done' | 'error'
  kind: 'permission' | 'question' | 'auth' | null
  progress: number | null
  app: string | null
  message: string | null
  since: string | null
}

export interface TerminalAttention {
  sequence: number
  at: string
  reason: 'bell' | 'done' | 'blocked' | 'error'
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
  status: 'running' | 'exited' | 'missing' | 'unavailable'
  exitCode: number | null
  unavailableReason?: string | null | undefined
  recoveryPending?: boolean | undefined
  // Initial launched process, not commands typed into a shell. Older retained
  // hosts may omit this; null means no authoritative completion is available.
  commandExitCode?: number | null | undefined
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
  closeOnExit: boolean
  status: 'running' | 'exited' | 'unavailable'
  exitCode: number | null
  unavailableReason?: string | null | undefined
  recoveryPending?: boolean | undefined
  commandExitCode?: number | null | undefined
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
  closeOnExit?: boolean | undefined
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
  activity?: TerminalActivity | undefined
  attention?: TerminalAttention | undefined
  commandExitCode?: number | null | undefined
  exitCode?: number | null | undefined
  titleState?: TerminalTitleState | undefined
}

export interface TerminalHostOutput {
  data: string
  sequence: number
}

export interface TerminalHostSnapshot {
  /** Base64 libghostty-vt snapshot. */
  data: string
  format: 'ghostty'
  fence: number
  cols: number
  rows: number
}
