export const TERMINAL_PROGRESS_STALE_MS = 5 * 60_000
export const TERMINAL_NAME_MAX_LENGTH = 120

export const TERMINAL_COMMAND_OSC = 7740

type TerminalAfterExit = 'shell' | 'close' | 'closeOnSuccess'

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
  shell: string
  command: string | null
  afterExit: TerminalAfterExit
  initialTitle?: string | undefined
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
  command: string | null
  afterExit: TerminalAfterExit
  status: 'running' | 'exited' | 'unavailable'
  exitCode: number | null
  unavailableReason?: string | null | undefined
  recoveryPending?: boolean | undefined
  commandExitCode?: number | null | undefined
  parentTerminalId?: string | null | undefined
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
  shell: string
  command: string | null
  afterExit: TerminalAfterExit
  initialTitle?: string | undefined
  initialSize?: TerminalSize | undefined
  env: Record<string, string>
  setupTasks?: TerminalSetupTask[] | undefined
  setupError?: string | undefined
  parentTerminalId?: string | undefined
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
  data: string
  format: 'ghostty'
  fence: number
  cols: number
  rows: number
}
