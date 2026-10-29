export const TERMINAL_PROGRESS_STALE_MS = 5 * 60_000

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

export type TerminalInputStep =
  | { type: 'text'; text: string; paste: boolean }
  | { type: 'key'; key: string; ctrl: boolean; alt: boolean; shift: boolean }

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
  title: string | null
  command: string | null
  running: boolean | null
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
