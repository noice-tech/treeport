import * as Data from 'effect/Data'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import { type TerminalClientToServerEvents } from '@treeport/shared'
import { type TerminalSessionState } from './state'

export class TerminalRenderError extends Data.TaggedError(
  'TerminalRenderError'
)<{
  readonly message: string
}> {}

type RenderOperation = {
  readonly epoch: number
  readonly effect: Effect.Effect<void, TerminalRenderError>
}

interface Dependencies {
  failProtocol(message: string): void
  send<E extends keyof TerminalClientToServerEvents>(
    event: E,
    payload: Parameters<TerminalClientToServerEvents[E]>[0]
  ): void
  stopWithError(message: string): void
}

export function makeRender(
  state: Pick<
    TerminalSessionState,
    | 'disposed'
    | 'expectedSequence'
    | 'lastParsedSequence'
    | 'parsedSequences'
    | 'ready'
    | 'reconnectAllowed'
    | 'renderEpoch'
    | 'renderFailed'
    | 'socket'
    | 'streamId'
    | 'terminal'
  >,
  dependencies: Dependencies
) {
  return Effect.gen(function* () {
    let pendingTerminalWrites = 0
    const renderQueue = yield* Queue.bounded<RenderOperation>(1_024)
    const render = Effect.forever(
      Effect.gen(function* () {
        const operation = yield* Queue.take(renderQueue)
        if (
          !state.disposed &&
          !state.renderFailed &&
          operation.epoch === state.renderEpoch
        ) {
          yield* operation.effect
        }
      })
    ).pipe(
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          if (!Cause.isInterruptedOnly(cause)) {
            failRendering(Cause.squash(cause))
          }
        })
      ),
      Effect.ensuring(Queue.shutdown(renderQueue))
    )

    const renderFiber = yield* Effect.forkScoped(render)

    function writeTerminal(
      data: string
    ): Effect.Effect<void, TerminalRenderError> {
      return Effect.async<void>((resume) => {
        const terminal = state.terminal
        if (!terminal) {
          resume(Effect.void)
          return
        }

        // Submission cannot be cancelled in xterm. Even after interruption its
        // callback must decrement the count so a later epoch can drain safely.
        pendingTerminalWrites += 1
        terminal.write(data, () => {
          pendingTerminalWrites = Math.max(0, pendingTerminalWrites - 1)
          resume(Effect.void)
        })
      }).pipe(
        Effect.timeoutFail({
          duration: '30 seconds',
          onTimeout: () =>
            new TerminalRenderError({
              message: 'xterm did not finish parsing within 30 seconds'
            })
        })
      )
    }

    function drainTerminalWrites(): Effect.Effect<void, TerminalRenderError> {
      // Empty writes preserve FIFO parse boundaries without serializing every
      // output chunk into a separate xterm rendering cycle.
      return Effect.suspend(() =>
        pendingTerminalWrites === 0 ? Effect.void : writeTerminal('')
      )
    }

    function enqueueRender(
      epoch: number,
      effect: Effect.Effect<void, TerminalRenderError>
    ): void {
      if (state.disposed || state.renderFailed) {
        return
      }

      // Never drop output or let an unresponsive parser grow memory indefinitely.
      if (!Queue.unsafeOffer(renderQueue, { epoch, effect })) {
        failRendering(
          new TerminalRenderError({
            message: 'Terminal render queue capacity exceeded'
          })
        )
      }
    }

    function failRendering(cause: unknown): void {
      if (state.renderFailed || state.disposed) {
        return
      }

      state.renderFailed = true
      const detail = (
        cause instanceof Error ? cause.message : String(cause)
      ).trim()
      state.reconnectAllowed = false
      dependencies.stopWithError(
        detail
          ? `Terminal rendering failed: ${detail.slice(0, 500)}`
          : 'Terminal rendering failed'
      )
      Effect.runSync(Queue.shutdown(renderQueue))
      Effect.runSync(Fiber.interruptFork(renderFiber))
      state.socket?.disconnect()
    }

    function handleOutput(
      streamId: string,
      sequence: number,
      data: string
    ): void {
      if (
        !state.ready ||
        streamId !== state.streamId ||
        sequence !== state.expectedSequence
      ) {
        dependencies.failProtocol('Terminal output arrived out of order')
        return
      }

      state.expectedSequence += 1
      const epoch = state.renderEpoch
      enqueueRender(
        epoch,
        Effect.sync(() => {
          const terminal = state.terminal
          if (!terminal) {
            return
          }

          pendingTerminalWrites += 1
          terminal.write(data, () => {
            pendingTerminalWrites = Math.max(0, pendingTerminalWrites - 1)
            if (
              state.ready &&
              epoch === state.renderEpoch &&
              streamId === state.streamId
            ) {
              state.parsedSequences.add(sequence)
              while (
                state.parsedSequences.delete(state.lastParsedSequence + 1)
              ) {
                state.lastParsedSequence += 1
              }
              dependencies.send('output_ack', {
                streamId,
                sequence: state.lastParsedSequence
              })
            }
          })
        })
      )
    }

    return {
      writeTerminal,
      drainTerminalWrites,
      enqueueRender,
      failRendering,
      handleOutput
    }
  })
}
