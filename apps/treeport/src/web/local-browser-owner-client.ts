import {
  apiErrorBodySchema,
  browserOwnerTicketResponseSchema,
  createProtocolSocket,
  decodeUnknownOrNull,
  type ProtocolSocket
} from '@treeport/shared'
import type {
  BrowserOwnerClientMessage,
  BrowserOwnerClientToServerEvents,
  BrowserOwnerServerMessage,
  BrowserOwnerServerToClientEvents,
  BrowserRuntimeState
} from '@treeport/shared'
import {
  BROWSER_PROTOCOL_VERSION,
  parseBrowserOwnerServerMessage
} from '@treeport/shared'

export interface LocalBrowserOwnerTicket {
  ticket: string
  challenge: string
}

export interface LocalBrowserOwnerConnection {
  generation: number
  resumed: boolean
  initialState: BrowserRuntimeState
  sendReady(state: BrowserRuntimeState): void
  sendState(state: BrowserRuntimeState): void
  sendPopup(url: string): void
  sendCrash(message: string): void
  takeControl(): void
  dispose(): void
}

export async function requestLocalBrowserOwnerTicket(
  panelId: string,
  clientId: string
): Promise<LocalBrowserOwnerTicket> {
  const response = await fetch(
    `/api/panels/${encodeURIComponent(panelId)}/browser-owner-ticket`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId })
    }
  )
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = decodeUnknownOrNull(apiErrorBodySchema, body)
    throw new Error(
      error?.error.message ?? 'Could not request Browser ownership.'
    )
  }

  const ticket = decodeUnknownOrNull(browserOwnerTicketResponseSchema, body)
  if (!ticket) {
    throw new Error('The Browser owner ticket response is invalid.')
  }

  return ticket
}

export function connectLocalBrowserOwner(
  panelId: string,
  ownerTicket: LocalBrowserOwnerTicket,
  endpoint: string,
  handlers: {
    setRuntimeControl(
      controller: 'agent' | 'other' | 'none',
      retainPaint: boolean
    ): Promise<boolean>
    requestClose(force: boolean): Promise<boolean>
    closed(reason: string): void
    disconnected(): void
  }
): Promise<LocalBrowserOwnerConnection> {
  const socket: ProtocolSocket<
    BrowserOwnerServerToClientEvents,
    BrowserOwnerClientToServerEvents
  > = createProtocolSocket('/browser-owners', {
    reconnection: false,
    auth: {
      ticket: ownerTicket.ticket,
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      endpoint,
      challenge: ownerTicket.challenge
    }
  })
  let settled = false
  let disposed = false
  let activeGeneration: number | null = null

  return new Promise<LocalBrowserOwnerConnection>((resolve, reject) => {
    const rejectBeforeReady = (cause: unknown) => {
      if (settled) {
        return
      }

      settled = true
      socket.disconnect()
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
    socket.on('ownerMessage', (value: BrowserOwnerServerMessage) => {
      const message = parseBrowserOwnerServerMessage(value)
      if (!message) {
        rejectBeforeReady(new Error('The Browser owner protocol is invalid.'))
        return
      }

      if (message.type === 'claimRejected') {
        rejectBeforeReady(new Error(message.message))
        return
      }

      if (message.type === 'closed') {
        if (!settled) {
          rejectBeforeReady(new Error(message.reason))
        } else {
          handlers.closed(message.reason)
        }

        return
      }

      if (message.type === 'claimGranted') {
        if (settled || message.panelId !== panelId) {
          socket.disconnect()
          return
        }

        settled = true
        let revision = 0
        const generation = message.generation
        activeGeneration = generation
        const send = (ownerMessage: BrowserOwnerClientMessage) => {
          if (!disposed && socket.connected) {
            socket.emit('ownerMessage', ownerMessage)
          }
        }
        resolve({
          generation,
          resumed: message.resumed,
          initialState: message.state,
          sendReady(state) {
            send({
              type: 'ready',
              generation,
              revision: ++revision,
              state
            })
          },
          sendState(state) {
            send({
              type: 'state',
              generation,
              revision: ++revision,
              state
            })
          },
          sendPopup(url) {
            send({ type: 'popup', generation, url })
          },
          sendCrash(message) {
            send({ type: 'crashed', generation, message })
          },
          takeControl() {
            send({ type: 'takeControl', generation })
          },
          dispose() {
            send({ type: 'released', generation })
            disposed = true
            socket.disconnect()
          }
        })
        return
      }

      if (
        (message.type === 'runtimeControl' ||
          message.type === 'closeRequest') &&
        message.generation !== activeGeneration
      ) {
        return
      }

      if (message.type === 'runtimeControl') {
        void handlers
          .setRuntimeControl(message.controller, message.retainPaint)
          .then(
            (accepted) =>
              sendOwnerResult(socket, {
                type: 'runtimeControlResult',
                generation: message.generation,
                requestId: message.requestId,
                accepted
              }),
            () =>
              sendOwnerResult(socket, {
                type: 'runtimeControlResult',
                generation: message.generation,
                requestId: message.requestId,
                accepted: false
              })
          )
        return
      }

      if (message.type === 'closeRequest') {
        void handlers.requestClose(message.force).then(
          (canClose) =>
            sendOwnerResult(socket, {
              type: 'closeResult',
              generation: message.generation,
              requestId: message.requestId,
              canClose
            }),
          () =>
            sendOwnerResult(socket, {
              type: 'closeResult',
              generation: message.generation,
              requestId: message.requestId,
              canClose: false
            })
        )
      }
    })
    socket.on('connect_error', rejectBeforeReady)
    socket.on('disconnect', () => {
      if (!settled) {
        rejectBeforeReady(new Error('The Browser owner connection closed.'))
      } else if (!disposed) {
        handlers.disconnected()
      }
    })
  })
}

function sendOwnerResult(
  socket: ProtocolSocket<
    BrowserOwnerServerToClientEvents,
    BrowserOwnerClientToServerEvents
  >,
  message: BrowserOwnerClientMessage
): void {
  if (socket.connected) {
    socket.emit('ownerMessage', message)
  }
}
