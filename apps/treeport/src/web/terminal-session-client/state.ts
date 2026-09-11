import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import type { TerminalImages } from '../../terminal-images'
import {
  type ProtocolSocket,
  type ProtocolSocketOptions,
  type TerminalClientToServerEvents,
  type TerminalSize,
  type TerminalServerToClientEvents
} from '@treeport/shared'

type ConnectionPhase = 'connecting' | 'ready' | 'reconnecting' | 'closed'
export type TerminalSocketFactory = (
  namespace: string,
  options: ProtocolSocketOptions
) => ProtocolSocket<TerminalServerToClientEvents, TerminalClientToServerEvents>
export type ArrowDirection = 'up' | 'down' | 'left' | 'right'
export type TerminalFileTransfer = {
  state: 'uploading' | 'error'
  message: string
}

export const TERMINAL_MIN_COLS = 2
const TERMINAL_MAX_COLS = 1_000
export const TERMINAL_MIN_ROWS = 2
const TERMINAL_MAX_ROWS = 500
export function normalizeTerminalDimensions(
  dimensions: TerminalSize,
  fallback: TerminalSize = { cols: 100, rows: 30 }
): TerminalSize {
  return {
    cols: Number.isFinite(dimensions.cols)
      ? Math.min(
          TERMINAL_MAX_COLS,
          Math.max(TERMINAL_MIN_COLS, Math.trunc(dimensions.cols))
        )
      : fallback.cols,
    rows: Number.isFinite(dimensions.rows)
      ? Math.min(
          TERMINAL_MAX_ROWS,
          Math.max(TERMINAL_MIN_ROWS, Math.trunc(dimensions.rows))
        )
      : fallback.rows
  }
}

export interface TerminalSessionSnapshot {
  phase: ConnectionPhase
  degraded: boolean
  controller: boolean
  controlPending: boolean
  title: string | null
  bellActive: boolean
  bellSerial: number
  exitSerial: number
  fileTransfer: TerminalFileTransfer | null
  hasSelection: boolean
  hoveredLink: string | null
  pasteRequestSerial: number
  error: string | null
}

const DEFAULT_SNAPSHOT: TerminalSessionSnapshot = {
  phase: 'closed',
  degraded: false,
  controller: false,
  controlPending: false,
  title: null,
  bellActive: false,
  bellSerial: 0,
  exitSerial: 0,
  fileTransfer: null,
  hasSelection: false,
  hoveredLink: null,
  pasteRequestSerial: 0,
  error: null
}

// Coordination state is session-owned, never mount-owned. Each service receives
// only the fields it uses; queues, fibers and timers stay private to their owner.
export class TerminalSessionState {
  readonly listeners = new Set<() => void>()
  snapshotValue: TerminalSessionSnapshot = DEFAULT_SNAPSHOT
  terminal: Terminal | null = null
  fitAddon: FitAddon | null = null
  images: TerminalImages | null = null
  wrapper: HTMLDivElement | null = null
  host: HTMLElement | null = null
  socket: ProtocolSocket<
    TerminalServerToClientEvents,
    TerminalClientToServerEvents
  > | null = null
  disposed = false
  opened = false
  ready = false
  reconnectAllowed = true
  streamId: string | null = null
  controllerGeneration = 0
  controlRequestGeneration: number | null = null
  canonicalCols = 100
  canonicalRows = 30
  canonicalRevision = 0
  appliedRevision = 0
  proposedDimensions: { cols: number; rows: number } | null = null
  resizePending = false
  queryAuthorityActive = false
  renderEpoch = 0
  renderFailed = false
  focusAfterRender = false
  expectedSequence = 1
  lastParsedSequence = 0
  readonly parsedSequences = new Set<number>()
  selectionDragCancel: (() => void) | null = null
  pendingPaste = ''
  inputModifiers: {
    ctrl: boolean
    alt: boolean
    onConsumed: () => void
  } | null = null
  lastBellAt = 0

  constructor(readonly terminalId: string) {}
}
