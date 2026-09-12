import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import type * as Stream from 'effect/Stream'
import {
  type HostedTerminal,
  type TerminalCreateInput,
  type TerminalHostOutput,
  type TerminalHostRuntimeEvent,
  type TerminalHostSnapshot,
  type TerminalProcess,
  type TerminalProgress,
  type TerminalSessionState,
  type TerminalTitleState,
  type TerminalTraceContext
} from '../../terminal-runtime/contract'

export {
  type HostedTerminal,
  type TerminalCreateInput,
  type TerminalHostOutput,
  type TerminalHostRuntimeEvent,
  type TerminalLaunchSpec,
  type TerminalProcess,
  type TerminalSessionState,
  type TerminalTitleState,
  type TerminalTraceContext
} from '../../terminal-runtime/contract'

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
