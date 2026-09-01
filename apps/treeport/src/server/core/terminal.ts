import type { TerminalSize, TerminalStatus } from '@treeport/shared'
import type { WorktreeSetupTask } from './setup'

export const TERMINAL_PROGRESS_STALE_MS = 5 * 60_000

export interface TerminalLaunchSpec {
  argv: string[]
  initialTitle?: string | undefined
  fallbackArgv?: string[] | undefined
  cwd: string
  env: Record<string, string>
  shellIntegrationDir?: string | undefined
  setupTasks?: WorktreeSetupTask[] | undefined
  setupError?: string | undefined
}

export interface TerminalSessionState {
  status: TerminalStatus
  exitCode: number | null
}

export interface TerminalTitleState {
  terminalTitle: string | null
  currentCommand: string | null
  commandLine?: string | null
}

export interface HostedTerminal {
  id: string
  worktreeId: string
  name: string
  argv: string[]
  shellCommand: string | null
  interactiveShell: boolean
  closeOnSuccess: boolean
  status: Exclude<TerminalStatus, 'missing'>
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
  setupTasks?: WorktreeSetupTask[] | undefined
  setupError?: string | undefined
}

/** API daemon view of the detached terminal host. */
export interface TerminalSessionBackend {
  initialize(): Promise<boolean>
  createTerminal(input: TerminalCreateInput): Promise<void>
  renameTerminal(
    terminalId: string,
    name: string,
    updatedAt: string
  ): Promise<void>
  listTerminals(worktreeId: string): Promise<HostedTerminal[]>
  listProcesses(worktreeId: string): Promise<TerminalProcess[]>
  terminalState(terminalId: string): Promise<TerminalSessionState>
  captureTerminal(terminalId: string, lines: number): Promise<string | null>
  killTerminal(terminalId: string): Promise<void>
  killWorktree(worktreeId: string): Promise<string[]>
  shutdownIfEmpty(): Promise<void>
}
