import type { TerminalRenderError } from './render'
import * as Effect from 'effect/Effect'
import {
  parseTerminalServerEvent,
  type TerminalClientToServerEvents,
  type TerminalServerEvent,
  type TerminalProtocolInput
} from '@treeport/shared'
import { restoreTerminalSnapshotLinks } from '../terminal-browser'
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
  drainTerminalWrites(): Effect.Effect<void, TerminalRenderError>
  enqueueRender(
    epoch: number,
    effect: Effect.Effect<void, TerminalRenderError>
  ): void
  failProtocol(message: string): void
  flushControllerResize(): void
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
  writeTerminal(data: string): Effect.Effect<void, TerminalRenderError>
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
    | 'pendingPaste'
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
    function handleServerEvent(
      event: TerminalServerEvent,
      value: TerminalProtocolInput
    ): void {
      if (state.disposed || state.renderFailed) {
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
          state.wrapper.style.visibility = 'hidden'
        }

        dependencies.enqueueRender(
          epoch,
          Effect.gen(function* () {
            yield* dependencies.drainTerminalWrites()
            if (state.disposed || epoch !== state.renderEpoch) {
              return
            }

            state.terminal?.reset()
            dependencies.applyCanonicalDimensions(
              dimensions.cols,
              dimensions.rows,
              revision,
              true
            )
            if (state.terminal) {
              yield* dependencies.writeTerminal(message.snapshot)
              if (state.disposed || epoch !== state.renderEpoch) {
                return
              }

              restoreTerminalSnapshotLinks(
                state.terminal,
                message.snapshotLinks
              )
            }

            if (state.wrapper && epoch === state.renderEpoch) {
              state.wrapper.style.visibility = ''
              if (state.focusAfterRender && state.host) {
                dependencies.focus()
              }
            }

            dependencies.clearDegraded()
            dependencies.update({
              phase: 'ready',
              // A control event can supersede ready while xterm parses its snapshot.
              controller:
                state.controllerGeneration === message.generation
                  ? message.controller
                  : state.snapshotValue.controller,
              controlPending: false,
              hasSelection: false,
              error: null
            })
            if (
              message.controller &&
              state.controllerGeneration === message.generation
            ) {
              dependencies.scheduleFit()
              dependencies.send('query_authority', {
                generation: message.generation,
                transitionId: null
              })
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
          Effect.gen(function* () {
            yield* dependencies.drainTerminalWrites()
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

      if (event === 'progress') {
        if (!parseTerminalServerEvent('progress', value)) {
          dependencies.failProtocol('The terminal server sent invalid progress')
        }

        // Product-event metadata remains the web progress authority.
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
              Effect.gen(function* () {
                yield* dependencies.drainTerminalWrites()
                if (
                  !state.disposed &&
                  epoch === state.renderEpoch &&
                  state.snapshotValue.controller &&
                  state.controllerGeneration === message.generation
                ) {
                  dependencies.send('query_authority', {
                    generation: message.generation,
                    transitionId: null
                  })
                }
              })
            )
          }
        }

        if (message.controller && state.pendingPaste) {
          const pendingPaste = state.pendingPaste
          state.pendingPaste = ''
          state.terminal?.paste(pendingPaste)
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

        state.queryAuthorityActive = message.active

        if (message.transitionId) {
          const transitionId = message.transitionId
          const epoch = state.renderEpoch
          dependencies.enqueueRender(
            epoch,
            Effect.gen(function* () {
              yield* dependencies.drainTerminalWrites()
              if (
                !state.disposed &&
                epoch === state.renderEpoch &&
                state.snapshotValue.controller &&
                state.controllerGeneration === message.generation
              ) {
                dependencies.send('query_authority', {
                  generation: message.generation,
                  transitionId
                })
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
      state.terminal?.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`)
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
