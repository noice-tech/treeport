import type { SessionTimer } from './timers'
import * as Effect from 'effect/Effect'
import {
  TERMINAL_PROTOCOL_VERSION,
  type TerminalClientToServerEvents,
  type TerminalServerEvent,
  type TerminalProtocolInput
} from '@treeport/shared'
import {
  type TerminalSessionState,
  type TerminalSessionSnapshot,
  type TerminalSocketFactory,
  normalizeTerminalDimensions
} from './state'

let fallbackClientId: string | null = null
function getClientId(): string {
  if (fallbackClientId) {
    return fallbackClientId
  }

  try {
    const stored = sessionStorage.getItem('treeport-terminal-client-id')
    if (stored) {
      sessionStorage.setItem('treeport-terminal-client-id', stored)
      return (fallbackClientId = stored)
    }
  } catch {
    // Storage can be unavailable in private browsing modes.
  }

  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  const created = `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`

  try {
    sessionStorage.setItem('treeport-terminal-client-id', created)
  } catch {
    // The in-memory ID still keeps reconnects stable for this page load.
  }
  return (fallbackClientId = created)
}

interface Dependencies {
  hasTimer(key: SessionTimer): boolean
  cancelControllerResizeIntent(clearPending?: boolean): void
  cancelTimer(key: SessionTimer): void
  fit(queueControllerResize?: boolean): void
  handleServerEvent(
    event: TerminalServerEvent,
    value: TerminalProtocolInput
  ): void
  scheduleTimer(key: SessionTimer, callback: () => void, delay: number): void
  setTerminalScrolling(scrolling: boolean): void
  update(patch: Partial<TerminalSessionSnapshot>): void
}

export function makeConnection(
  state: Pick<
    TerminalSessionState,
    | 'appliedRevision'
    | 'canonicalRevision'
    | 'controlRequestGeneration'
    | 'controllerGeneration'
    | 'disposed'
    | 'host'
    | 'opened'
    | 'proposedDimensions'
    | 'queryAuthorityActive'
    | 'ready'
    | 'reconnectAllowed'
    | 'renderEpoch'
    | 'resizePending'
    | 'selectionDragCancel'
    | 'snapshotValue'
    | 'socket'
    | 'streamId'
    | 'terminal'
    | 'terminalId'
  >,
  dependencies: Dependencies,
  createSocket: TerminalSocketFactory
) {
  return Effect.gen(function* () {
    function reconnectImmediately(): void {
      if (
        !state.host ||
        state.disposed ||
        !state.reconnectAllowed ||
        state.ready ||
        state.socket?.connected
      ) {
        return
      }

      const staleSocket = state.socket
      if (staleSocket) {
        staleSocket.disconnect()
        staleSocket.removeAllListeners()
        if (state.socket === staleSocket) {
          state.socket = null
        }
      }

      if (state.opened) {
        connect()
      }
    }

    function connect(): void {
      if (state.disposed || !state.reconnectAllowed || state.socket) {
        return
      }

      state.ready = false
      state.controlRequestGeneration = null
      dependencies.update({
        phase: 'connecting',
        controller: false,
        controlPending: false,
        error: null
      })
      startDegradedTimer()
      const socket = createSocket('/terminals', {
        autoConnect: false,
        reconnection: true,
        reconnectionDelay: 100,
        reconnectionDelayMax: 1_000,
        randomizationFactor: 0.2,
        query: { terminalProtocol: String(TERMINAL_PROTOCOL_VERSION) },
        authorize: () => {
          const dimensions = normalizeTerminalDimensions(
            state.proposedDimensions ?? {
              cols: state.terminal?.cols ?? 100,
              rows: state.terminal?.rows ?? 30
            }
          )
          return {
            terminalId: state.terminalId,
            clientId: getClientId(),
            ...dimensions
          }
        }
      })
      state.socket = socket
      socket.on('connect', () => {
        if (state.socket !== socket) {
          return
        }

        dependencies.fit()
      })
      const receive = (
        event: TerminalServerEvent,
        value: TerminalProtocolInput
      ) => {
        if (
          state.socket === socket &&
          !state.disposed &&
          state.reconnectAllowed
        ) {
          dependencies.handleServerEvent(event, value)
        }
      }
      socket.on('ready', (value) => receive('ready', value))
      socket.on('dimensions', (value) => receive('dimensions', value))
      socket.on('output', (value) => receive('output', value))
      socket.on('title', (value) => receive('title', value))
      socket.on('progress', (value) => receive('progress', value))
      socket.on('control', (value) => receive('control', value))
      socket.on('query_authority', (value) => receive('query_authority', value))
      socket.on('exit', (value) => receive('exit', value))
      socket.on('terminal_error', (value) => receive('terminal_error', value))
      socket.on('connect_error', (error) => {
        if (state.socket !== socket || !state.reconnectAllowed) {
          return
        }

        state.controlRequestGeneration = null
        dependencies.update({
          phase: 'reconnecting',
          controller: false,
          controlPending: false,
          error: `Terminal connection failed: ${error.message}`
        })
      })
      socket.on('disconnect', (reason) => {
        if (state.socket !== socket) {
          return
        }

        const connected = state.ready
        state.renderEpoch += 1
        state.ready = false
        state.streamId = null
        state.selectionDragCancel?.()
        dependencies.setTerminalScrolling(false)
        state.controllerGeneration = 0
        state.controlRequestGeneration = null
        state.queryAuthorityActive = false

        dependencies.cancelControllerResizeIntent()
        if (!state.reconnectAllowed) {
          clearDegraded()
        }

        dependencies.update({
          phase:
            state.reconnectAllowed && !state.disposed
              ? 'reconnecting'
              : 'closed',
          controller: false,
          controlPending: false,
          hasSelection: false,
          degraded: state.reconnectAllowed
            ? state.snapshotValue.degraded
            : false,
          error:
            !connected && !state.snapshotValue.error
              ? `Terminal connection closed: ${reason}`
              : state.snapshotValue.error
        })
      })
      socket.manager.on('reconnect_attempt', () => {
        if (state.socket === socket && state.reconnectAllowed) {
          state.controlRequestGeneration = null
          startDegradedTimer()
          dependencies.update({
            phase: 'reconnecting',
            controller: false,
            controlPending: false
          })
        }
      })
      socket.connect()
    }

    function canInput(): boolean {
      return (
        state.ready &&
        state.snapshotValue.controller &&
        state.queryAuthorityActive &&
        !state.resizePending &&
        state.appliedRevision === state.canonicalRevision
      )
    }

    function send<E extends keyof TerminalClientToServerEvents>(
      event: E,
      payload: Parameters<TerminalClientToServerEvents[E]>[0]
    ): void {
      if (!state.socket?.connected || !state.ready) {
        return
      }

      if (
        event === 'output_ack' ||
        event === 'resize' ||
        event === 'take_control' ||
        event === 'query_authority'
      ) {
        // SAFETY: The generic event selects its matching protocol payload.
        const emit = state.socket.emit.bind(state.socket) as (
          event: E,
          payload: Parameters<TerminalClientToServerEvents[E]>[0]
        ) => void
        emit(event, payload)
        return
      }

      // SAFETY: The generic event selects its matching protocol payload.
      const emit = state.socket.volatile.emit.bind(state.socket.volatile) as (
        event: E,
        payload: Parameters<TerminalClientToServerEvents[E]>[0]
      ) => void
      emit(event, payload)
    }

    function startDegradedTimer(): void {
      if (dependencies.hasTimer('degraded')) {
        return
      }

      dependencies.scheduleTimer(
        'degraded',
        () => {
          if (!state.ready) {
            dependencies.update({ degraded: true })
          }
        },
        500
      )
    }

    function clearDegraded(): void {
      dependencies.cancelTimer('degraded')

      dependencies.update({ degraded: false })
    }

    function failProtocol(message: string): void {
      state.reconnectAllowed = false
      stopWithError(message)
      state.socket?.disconnect()
    }

    function stopWithError(message: string): void {
      state.renderEpoch += 1
      state.ready = false
      clearDegraded()
      state.controlRequestGeneration = null
      dependencies.update({
        error: message,
        phase: 'closed',
        degraded: false,
        controller: false,
        controlPending: false
      })
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.socket?.removeAllListeners()
      })
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.socket?.disconnect()
      })
    )

    return {
      reconnectImmediately,
      connect,
      canInput,
      send,
      clearDegraded,
      failProtocol,
      stopWithError
    }
  })
}
