import type { TerminalRenderError } from './render'
import * as Effect from 'effect/Effect'
import {
  parseTerminalServerEvent,
  type TerminalClientToServerEvents,
  type TerminalServerEvent,
  type TerminalProtocolInput
} from '@treeport/shared'
import { terminalCellSize } from '../terminal-browser'
import {
  type TerminalSessionState,
  type TerminalSessionSnapshot
} from './state'

interface Dependencies {
  applyCanonicalDimensions(
    cols: number,
    rows: number,
    revision: number,
    queueControllerResize?: boolean
  ): void
  cancelControllerResizeIntent(clearPending?: boolean): void
  clearDegraded(): void
  acknowledgeInput(generation: number): void
  cancelInput(): void
  flushInput(): void
  enqueueRender(
    epoch: number,
    effect: Effect.Effect<void, TerminalRenderError>
  ): void
  failProtocol(message: string): void
  flushControllerResize(): void
  fit(queueControllerResize?: boolean): void
  focus(options?: { requestControl?: boolean }): void
  handleOutput(streamId: string, sequence: number, data: string): void
  scheduleFit(): void
  send<E extends keyof TerminalClientToServerEvents>(
    event: E,
    payload: Parameters<TerminalClientToServerEvents[E]>[0]
  ): void
  setTerminalScrolling(scrolling: boolean): void
  stopWithError(message: string): void
  update(patch: Partial<TerminalSessionSnapshot>): void
  restoreTerminal(snapshot: string): void
}

export function makeProtocol(
  state: Pick<
    TerminalSessionState,
    | 'appliedRevision'
    | 'canonicalCols'
    | 'canonicalRevision'
    | 'canonicalRows'
    | 'controlRequestGeneration'
    | 'controllerGeneration'
    | 'disposed'
    | 'expectedSequence'
    | 'focusAfterRender'
    | 'host'
    | 'lastParsedSequence'
    | 'parsedSequences'
    | 'queryAuthorityActive'
    | 'ready'
    | 'reconnectAllowed'
    | 'renderEpoch'
    | 'renderFailed'
    | 'resizePending'
    | 'selectionDragCancel'
    | 'snapshotValue'
    | 'socket'
    | 'streamId'
    | 'terminal'
    | 'wrapper'
  >,
  dependencies: Dependencies
) {
  return Effect.sync(() => {
    function requestQueryAuthority(
      generation: number,
      transitionId: string | null
    ): void {
      dependencies.fit()
      dependencies.send('query_authority', {
        generation,
        transitionId,
        cellSize: state.terminal ? terminalCellSize(state.terminal) : null
      })
    }

    function handleServerEvent(
      event: TerminalServerEvent,
      value: TerminalProtocolInput
    ): void {
      if (state.disposed || state.renderFailed) {
        return
      }

      if (event === 'input_ack') {
        const message = parseTerminalServerEvent('input_ack', value)

        if (!message) {
          dependencies.failProtocol(
            'The terminal server sent an invalid input acknowledgement'
          )

          return
        }

        dependencies.acknowledgeInput(message.generation)

        return
      }

      if (event === 'ready') {
        const message = parseTerminalServerEvent('ready', value)

        if (!message) {
          dependencies.failProtocol(
            'The terminal server sent an invalid ready event'
          )

          return
        }

        dependencies.cancelControllerResizeIntent()
        state.controlRequestGeneration = null
        const dimensions = { cols: message.cols, rows: message.rows }
        const revision = message.revision
        state.streamId = message.streamId
        state.controllerGeneration = message.generation
        state.canonicalCols = dimensions.cols
        state.canonicalRows = dimensions.rows
        state.canonicalRevision = revision
        state.appliedRevision = 0
        state.expectedSequence = 1
        state.lastParsedSequence = 0
        state.parsedSequences.clear()
        state.selectionDragCancel?.()
        dependencies.setTerminalScrolling(false)
        state.ready = true
        state.renderEpoch += 1
        const epoch = state.renderEpoch
        state.queryAuthorityActive = false

        if (state.wrapper) {
          state.focusAfterRender ||= state.wrapper.contains(
            document.activeElement
          )
          state.wrapper.style.opacity = '0'
        }

        dependencies.enqueueRender(
          epoch,
          Effect.sync(() => {
            if (state.disposed || epoch !== state.renderEpoch) {
              return
            }

            dependencies.restoreTerminal(message.snapshot)
            dependencies.applyCanonicalDimensions(
              dimensions.cols,
              dimensions.rows,
              revision,
              true
            )

            if (state.wrapper) {
              state.wrapper.style.opacity = ''

              if (state.focusAfterRender && state.host) {
                dependencies.focus()
              }
            }

            dependencies.clearDegraded()
            dependencies.update({
              phase: 'ready',
              controller:
                state.controllerGeneration === message.generation
                  ? message.controller
                  : state.snapshotValue.controller,
              controlPending: false,
              error: null
            })

            if (
              message.controller &&
              state.controllerGeneration === message.generation
            ) {
              dependencies.scheduleFit()
              requestQueryAuthority(message.generation, null)
            }
          })
        )

        return
      }

      if (event === 'dimensions') {
        const message = parseTerminalServerEvent('dimensions', value)

        if (!message) {
          dependencies.failProtocol(
            'The terminal server sent invalid dimensions'
          )

          return
        }

        if (message.revision <= state.canonicalRevision) {
          return
        }

        state.canonicalCols = message.cols
        state.canonicalRows = message.rows
        state.canonicalRevision = message.revision
        state.resizePending = false
        const epoch = state.renderEpoch
        dependencies.enqueueRender(
          epoch,
          Effect.sync(() => {
            if (state.disposed || epoch !== state.renderEpoch) {
              return
            }

            dependencies.applyCanonicalDimensions(
              message.cols,
              message.rows,
              message.revision
            )
            dependencies.flushControllerResize()
          })
        )

        return
      }

      if (event === 'output') {
        const message = parseTerminalServerEvent('output', value)

        if (!message) {
          dependencies.failProtocol('The terminal server sent invalid output')

          return
        }

        dependencies.handleOutput(
          message.streamId,
          message.sequence,
          message.data
        )

        return
      }

      if (event === 'title') {
        const message = parseTerminalServerEvent('title', value)

        if (!message) {
          dependencies.failProtocol('The terminal server sent an invalid title')

          return
        }

        dependencies.update({ title: message.title.trim().slice(0, 256) })

        return
      }

      if (event === 'control') {
        const message = parseTerminalServerEvent('control', value)

        if (!message) {
          dependencies.failProtocol(
            'The terminal server sent invalid controller state'
          )

          return
        }

        const controllerChanged =
          message.controller !== state.snapshotValue.controller ||
          message.generation !== state.controllerGeneration

        if (controllerChanged) {
          if (state.snapshotValue.controller || !message.controller) {
            dependencies.cancelInput()
          }

          dependencies.cancelControllerResizeIntent()
        }

        state.controllerGeneration = message.generation
        state.controlRequestGeneration = null
        dependencies.update({
          controller: message.controller,
          controlPending: false
        })

        if (controllerChanged && !message.controller) {
          state.selectionDragCancel?.()
        }

        if (controllerChanged) {
          state.queryAuthorityActive = false

          if (message.controller) {
            const epoch = state.renderEpoch
            dependencies.enqueueRender(
              epoch,
              Effect.sync(() => {
                if (
                  !state.disposed &&
                  epoch === state.renderEpoch &&
                  state.snapshotValue.controller &&
                  state.controllerGeneration === message.generation
                ) {
                  requestQueryAuthority(message.generation, null)
                }
              })
            )
          }
        }

        if (controllerChanged) {
          dependencies.scheduleFit()
        }

        return
      }

      if (event === 'query_authority') {
        const message = parseTerminalServerEvent('query_authority', value)

        if (!message) {
          dependencies.failProtocol(
            'The terminal server sent invalid query authority state'
          )

          return
        }

        if (
          !state.snapshotValue.controller ||
          message.generation !== state.controllerGeneration
        ) {
          return
        }

        state.queryAuthorityActive =
          message.active && message.transitionId === null

        if (state.queryAuthorityActive) {
          dependencies.flushInput()
        }

        if (message.transitionId) {
          const transitionId = message.transitionId
          const epoch = state.renderEpoch
          dependencies.enqueueRender(
            epoch,
            Effect.sync(() => {
              if (
                !state.disposed &&
                epoch === state.renderEpoch &&
                state.snapshotValue.controller &&
                state.controllerGeneration === message.generation
              ) {
                requestQueryAuthority(message.generation, transitionId)
              }
            })
          )
        }

        return
      }

      if (event === 'exit') {
        if (!parseTerminalServerEvent('exit', value)) {
          dependencies.failProtocol(
            'The terminal server sent an invalid exit event'
          )

          return
        }

        dependencies.cancelInput()
        dependencies.update({ exitSerial: state.snapshotValue.exitSerial + 1 })

        return
      }

      const message = parseTerminalServerEvent('terminal_error', value)

      if (!message) {
        dependencies.failProtocol(
          'The terminal server sent an invalid error event'
        )

        return
      }

      state.reconnectAllowed = message.retryable
      state.terminal?.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`)

      if (message.retryable) {
        state.controlRequestGeneration = null
        dependencies.update({ controlPending: false, error: message.message })
      } else {
        dependencies.stopWithError(message.message)
        state.socket?.disconnect()
      }
    }

    return { handleServerEvent }
  })
}
