import { io, type Socket } from 'socket.io-client'
import { z } from 'zod'
import type {
  BrowserOwnerClientMessage,
  BrowserOwnerClientToServerEvents,
  BrowserOwnerServerMessage,
  BrowserOwnerServerToClientEvents,
  BrowserRuntimeState
} from '@treeport/shared'
import {
  BROWSER_PROTOCOL_VERSION,
  browserOwnerServerMessageSchema,
  SOCKET_IO_PATH
} from '@treeport/shared'

const ownerTicketResponseSchema = z.strictObject({
  ticket: z.string().min(32).max(256),
  challenge: z.string().min(32).max(256)
})

export interface LocalBrowserOwnerTicket {
  ticket: string
  challenge: string
}

export interface LocalBrowserOwnerConnection {
  generation: number
  initialState: BrowserRuntimeState
  sendReady(state: BrowserRuntimeState): void
  sendState(state: BrowserRuntimeState): void
  sendPopup(url: string): void
  sendCrash(message: string): void
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
  if (!response.ok) {
    const body = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(await response.json().catch(() => null))
    throw new Error(
      body.success
        ? body.data.error.message
        : 'Could not request Browser ownership.'
    )
  }

  return ownerTicketResponseSchema.parse(await response.json())
}

export function connectLocalBrowserOwner(
  panelId: string,
  ownerTicket: LocalBrowserOwnerTicket,
  endpoint: string,
  handlers: {
    setAgentControl(locked: boolean): Promise<boolean>
    requestClose(force: boolean): Promise<boolean>
    closed(reason: string): void
    disconnected(): void
  }
): Promise<LocalBrowserOwnerConnection> {
  const socket: Socket<
    BrowserOwnerServerToClientEvents,
    BrowserOwnerClientToServerEvents
  > = io('/browser-owners', {
    path: SOCKET_IO_PATH,
    transports: ['websocket'],
    forceNew: true,
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
      const parsed = browserOwnerServerMessageSchema.safeParse(value)
      if (!parsed.success) {
        rejectBeforeReady(new Error('The Browser owner protocol is invalid.'))
        return
      }

      const message = parsed.data
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
          dispose() {
            disposed = true
            socket.disconnect()
          }
        })
        return
      }

      if (
        (message.type === 'agentControl' || message.type === 'closeRequest') &&
        message.generation !== activeGeneration
      ) {
        return
      }

      if (message.type === 'agentControl') {
        void handlers.setAgentControl(message.locked).then(
          (accepted) =>
            sendOwnerResult(socket, {
              type: 'agentControlResult',
              generation: message.generation,
              requestId: message.requestId,
              accepted
            }),
          () =>
            sendOwnerResult(socket, {
              type: 'agentControlResult',
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
  socket: Socket<
    BrowserOwnerServerToClientEvents,
    BrowserOwnerClientToServerEvents
  >,
  message: BrowserOwnerClientMessage
): void {
  if (socket.connected) {
    socket.emit('ownerMessage', message)
  }
}
