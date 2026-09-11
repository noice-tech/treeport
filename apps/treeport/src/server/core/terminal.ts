import type {
  TerminalImageSnapshot,
  TerminalProgress,
  TerminalSize,
  TerminalSnapshotLink,
  TerminalStatus
} from '@treeport/shared'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import type * as Stream from 'effect/Stream'
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

interface TerminalHostSnapshot {
  data: string
  links: TerminalSnapshotLink[]
  images: TerminalImageSnapshot | null
  fence: number
  cols: number
  rows: number
}

export interface TerminalHostAttachment extends TerminalHostSnapshot {
  output: Stream.Stream<TerminalHostOutput, unknown>
}

/** Browser-facing view of the detached terminal host. */
export interface TerminalAttachmentBackend {
  attach(
    terminalId: string,
    trace?: TerminalTraceContext
  ): Effect.Effect<TerminalHostAttachment | null, unknown, Scope.Scope>
  runtimeEvents(
    terminalId: string
  ): Stream.Stream<TerminalHostRuntimeEvent, unknown>
  terminalTitleState(
    terminalId: string
  ): Effect.Effect<TerminalTitleState | null, unknown>
  runtimeState(terminalId: string): Effect.Effect<
    {
      title: string | null
      status: HostedTerminal['status']
      progress: TerminalProgress | null
      bell: { sequence: number; at: string } | null
    } | null,
    unknown
  >
  write(
    terminalId: string,
    data: string | Buffer,
    authority: { attachmentId: string; generation: number }
  ): Effect.Effect<void, unknown>
  prepareQueryAuthority(
    terminalId: string
  ): Effect.Effect<{ transitionId: string; fence: number }, unknown>
  activateQueryAuthority(
    terminalId: string,
    transitionId: string,
    attachmentId: string,
    generation: number,
    cellSize: { width: number; height: number } | null
  ): Effect.Effect<void, unknown>
  useHostQueryAuthority(terminalId: string): Effect.Effect<void, unknown>
  resize(
    terminalId: string,
    cols: number,
    rows: number
  ): Effect.Effect<void, unknown>
}

/** API daemon view of the detached terminal host. */
export interface TerminalSessionBackend {
  initialize(): Effect.Effect<boolean, unknown>
  createTerminal(
    input: TerminalCreateInput,
    trace?: TerminalTraceContext
  ): Effect.Effect<void, unknown>
  renameTerminal(
    terminalId: string,
    name: string,
    updatedAt: string
  ): Effect.Effect<void, unknown>
  listTerminals(worktreeId: string): Effect.Effect<HostedTerminal[], unknown>
  listProcesses(worktreeId: string): Effect.Effect<TerminalProcess[], unknown>
  terminalState(
    terminalId: string
  ): Effect.Effect<TerminalSessionState, unknown>
  captureTerminal(
    terminalId: string,
    lines: number
  ): Effect.Effect<string | null, unknown>
  killTerminal(
    terminalId: string,
    trace?: TerminalTraceContext
  ): Effect.Effect<void, unknown>
  killWorktree(worktreeId: string): Effect.Effect<string[], unknown>
  shutdownIfEmpty(): Effect.Effect<void, unknown>
}
