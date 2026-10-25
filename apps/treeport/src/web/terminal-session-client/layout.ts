import type { SessionTimer } from './timers'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import {
  type TerminalClientToServerEvents,
  type TerminalSize
} from '@treeport/shared'
import { setTerminalFontSize } from '../terminal-browser'
import {
  type TerminalSessionState,
  normalizeTerminalDimensions,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS
} from './state'

const TERMINAL_MIN_VIEWER_FONT_SIZE = 4
const TERMINAL_RESIZE_SETTLE_MS = 150

interface WTermMeasurement {
  _measureGridSize(): TerminalSize | null
}

interface Dependencies {
  cancelTimer(key: SessionTimer): void
  failRendering(cause: unknown): void
  flushInput(): void
  scheduleTimer(key: SessionTimer, callback: () => void, delay: number): void
  send<E extends keyof TerminalClientToServerEvents>(
    event: E,
    payload: Parameters<TerminalClientToServerEvents[E]>[0]
  ): void
}

export function makeLayout(
  state: Pick<
    TerminalSessionState,
    | 'appliedRevision'
    | 'canonicalCols'
    | 'canonicalRevision'
    | 'canonicalRows'
    | 'controllerGeneration'
    | 'disposed'
    | 'fontSize'
    | 'host'
    | 'proposedDimensions'
    | 'ready'
    | 'resizePending'
    | 'snapshotValue'
    | 'socket'
    | 'terminal'
    | 'wrapper'
  >,
  dependencies: Dependencies
) {
  return Effect.gen(function* () {
    let resizeIntentGeneration = 0
    let resizeQuietElapsed = false
    let resizeIntentDirty = false
    let resizeFrame: number | null = null

    function keepLiveOutputVisible(): void {
      // A smaller host leaves wterm's scroll offset above the live screen
      // without a scroll event; follow output unless the user scrolled away.
      const element = state.terminal?.element

      if (element && !state.wrapper?.classList.contains('terminal-scrolling')) {
        element.scrollTop = element.scrollHeight
      }
    }

    function applyCanonicalDimensions(
      cols: number,
      rows: number,
      revision: number,
      queueControllerResize = false
    ): void {
      if (!state.terminal || revision <= state.appliedRevision) {
        return
      }

      keepLiveOutputVisible()
      state.terminal.resize(cols, rows)
      state.appliedRevision = revision

      if (state.wrapper) {
        state.wrapper.dataset.terminalCols = String(cols)
        state.wrapper.dataset.terminalRows = String(rows)
        state.wrapper.dataset.terminalRevision = String(revision)
      }

      if (revision === state.canonicalRevision) {
        fit(queueControllerResize)
        dependencies.flushInput()
      }
    }

    function scheduleFit(): void {
      if (resizeFrame !== null) {
        cancelAnimationFrame(resizeFrame)
      }

      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null
        fit(true)
      })
    }

    function queueControllerResizeIntent(): void {
      dependencies.cancelTimer('resizeSettle')

      resizeIntentDirty = true
      resizeQuietElapsed = false
      resizeIntentGeneration = state.controllerGeneration
      dependencies.scheduleTimer(
        'resizeSettle',
        () => {
          resizeQuietElapsed = true
          flushControllerResize()
        },
        TERMINAL_RESIZE_SETTLE_MS
      )
    }

    function flushControllerResize(): void {
      const proposed = state.proposedDimensions

      if (
        !resizeIntentDirty ||
        !resizeQuietElapsed ||
        !proposed ||
        !state.host ||
        !state.ready ||
        !state.socket?.connected ||
        !state.snapshotValue.controller ||
        resizeIntentGeneration !== state.controllerGeneration ||
        state.appliedRevision !== state.canonicalRevision ||
        state.resizePending
      ) {
        return
      }

      if (
        proposed.cols === state.canonicalCols &&
        proposed.rows === state.canonicalRows
      ) {
        resizeIntentDirty = false
        resizeQuietElapsed = false

        return
      }

      resizeIntentDirty = false
      resizeQuietElapsed = false
      state.resizePending = true

      dependencies.send('resize', {
        generation: state.controllerGeneration,
        cols: proposed.cols,
        rows: proposed.rows
      })
    }

    function cancelControllerResizeIntent(clearPending = true): void {
      dependencies.cancelTimer('resizeSettle')

      if (clearPending) {
        state.resizePending = false
      }

      resizeIntentDirty = false
      resizeQuietElapsed = false
      resizeIntentGeneration = 0
      state.proposedDimensions = null
    }

    function fit(queueControllerResize = false): void {
      const result = Effect.runSyncExit(
        Effect.sync(() => {
          const terminal = state.terminal

          if (state.disposed || !state.host || !terminal) {
            return
          }

          keepLiveOutputVisible()

          if (!state.ready) {
            setTerminalFontSize(terminal, state.fontSize)
            terminal.fit()

            if (
              terminal.cols >= TERMINAL_MIN_COLS &&
              terminal.rows >= TERMINAL_MIN_ROWS
            ) {
              state.proposedDimensions = normalizeTerminalDimensions({
                cols: terminal.cols,
                rows: terminal.rows
              })
            }

            return
          }

          if (state.appliedRevision !== state.canonicalRevision) {
            return
          }

          setTerminalFontSize(terminal, state.fontSize)

          // SAFETY: The pinned wterm exposes measurement only through fit(),
          // which also resizes. The server owns the grid, so only measure.
          const proposedDimensions = (
            Object(terminal) as WTermMeasurement
          )._measureGridSize()

          if (
            !proposedDimensions ||
            !Number.isFinite(proposedDimensions.cols) ||
            !Number.isFinite(proposedDimensions.rows) ||
            proposedDimensions.cols < TERMINAL_MIN_COLS ||
            proposedDimensions.rows < TERMINAL_MIN_ROWS
          ) {
            if (state.snapshotValue.controller) {
              cancelControllerResizeIntent(false)
            }

            return
          }

          const proposed = normalizeTerminalDimensions(proposedDimensions)
          state.proposedDimensions = proposed

          if (state.snapshotValue.controller) {
            if (!queueControllerResize) {
              return
            }

            if (
              !state.resizePending &&
              proposed.cols === state.canonicalCols &&
              proposed.rows === state.canonicalRows
            ) {
              dependencies.cancelTimer('resizeSettle')

              resizeIntentDirty = false
              resizeQuietElapsed = false

              return
            }

            queueControllerResizeIntent()

            return
          }

          const scale = Math.min(
            1,
            proposed.cols / state.canonicalCols,
            proposed.rows / state.canonicalRows
          )

          setTerminalFontSize(
            terminal,
            Math.max(
              TERMINAL_MIN_VIEWER_FONT_SIZE,
              Math.floor(state.fontSize * scale * 100) / 100
            )
          )

          if (
            terminal.cols !== state.canonicalCols ||
            terminal.rows !== state.canonicalRows
          ) {
            terminal.resize(state.canonicalCols, state.canonicalRows)
          }
        })
      )

      if (Exit.isFailure(result)) {
        // Missing dimensions are represented above; actual wterm measurement
        // defects close the session instead of masquerading as a hidden host.
        dependencies.failRendering(Cause.squash(result.cause))
      }
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (resizeFrame !== null) {
          cancelAnimationFrame(resizeFrame)
        }
      })
    )

    return {
      applyCanonicalDimensions,
      scheduleFit,
      flushControllerResize,
      cancelControllerResizeIntent,
      fit
    }
  })
}
