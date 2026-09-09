import type { SessionTimer } from './timers'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { type TerminalClientToServerEvents } from '@treeport/shared'
import { TERMINAL_FONT_SIZE } from '../terminal-browser'
import {
  type TerminalSessionState,
  normalizeTerminalDimensions,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS
} from './state'

const TERMINAL_MIN_VIEWER_FONT_SIZE = 4
const TERMINAL_RESIZE_SETTLE_MS = 150

interface Dependencies {
  cancelTimer(key: SessionTimer): void
  failRendering(cause: unknown): void
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
    | 'fitAddon'
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

    function applyCanonicalDimensions(
      cols: number,
      rows: number,
      revision: number,
      queueControllerResize = false
    ): void {
      if (!state.terminal || revision <= state.appliedRevision) {
        return
      }

      state.terminal.resize(cols, rows)
      state.appliedRevision = revision
      if (state.wrapper) {
        state.wrapper.dataset.terminalCols = String(cols)
        state.wrapper.dataset.terminalRows = String(rows)
        state.wrapper.dataset.terminalRevision = String(revision)
      }

      if (revision === state.canonicalRevision) {
        fit(queueControllerResize)
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
          if (
            state.disposed ||
            !state.host ||
            !state.fitAddon ||
            !state.terminal
          ) {
            return
          }

          if (!state.ready) {
            state.terminal.options.fontSize = TERMINAL_FONT_SIZE
            state.fitAddon.fit()
            if (
              state.terminal.cols >= TERMINAL_MIN_COLS &&
              state.terminal.rows >= TERMINAL_MIN_ROWS
            ) {
              state.proposedDimensions = normalizeTerminalDimensions({
                cols: state.terminal.cols,
                rows: state.terminal.rows
              })
            }

            return
          }

          if (state.appliedRevision !== state.canonicalRevision) {
            return
          }

          state.terminal.options.fontSize = TERMINAL_FONT_SIZE
          const proposedDimensions = state.fitAddon.proposeDimensions()
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
          state.terminal.options.fontSize = Math.max(
            TERMINAL_MIN_VIEWER_FONT_SIZE,
            Math.floor(TERMINAL_FONT_SIZE * scale * 100) / 100
          )
          if (
            state.terminal.cols !== state.canonicalCols ||
            state.terminal.rows !== state.canonicalRows
          ) {
            state.terminal.resize(state.canonicalCols, state.canonicalRows)
          }
        })
      )
      if (Exit.isFailure(result)) {
        // Missing dimensions are represented above; actual xterm/FitAddon
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
