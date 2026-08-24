import { io, type Socket } from 'socket.io-client'
import { z } from 'zod'
import type {
  BrowserClientMessage,
  BrowserClientToServerEvents,
  BrowserFrame,
  BrowserServerMessage,
  BrowserServerToClientEvents
} from '@treeport/shared'
import {
  BROWSER_PROTOCOL_VERSION,
  browserFrameSchema,
  browserServerMessageSchema,
  parseBrowserClientMessage,
  SOCKET_IO_PATH
} from '@treeport/shared'

const browserTicketResponseSchema = z.object({
  ticket: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional()
})

export interface BrowserPanelBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserPanelConnection {
  dispose(): void
  send(message: BrowserClientMessage): void
  setBounds(bounds: BrowserPanelBounds): void
  setVisible(visible: boolean): void
}

export interface BrowserPanelSocket {
  connected: boolean
  emit(event: 'command', message: BrowserClientMessage): void
  on(event: 'message', listener: (message: BrowserServerMessage) => void): void
  on(event: 'frame', listener: (frame: BrowserFrame) => void): void
  on(event: 'disconnect', listener: () => void): void
  on(event: 'connect_error', listener: (error: Error) => void): void
  disconnect(): void
}

interface BrowserPanelSocketOptions {
  path: string
  transports: ['websocket']
  forceNew: true
  reconnection: false
  auth: {
    ticket: string
    protocolVersion: typeof BROWSER_PROTOCOL_VERSION
  }
}

export type BrowserPanelSocketFactory = (
  namespace: string,
  options: BrowserPanelSocketOptions
) => BrowserPanelSocket

const defaultSocketFactory: BrowserPanelSocketFactory = (
  namespace,
  options
) => {
  // SAFETY: The adapter uses only the typed events in BrowserPanelSocket.
  return io(namespace, options) as Socket<
    BrowserServerToClientEvents,
    BrowserClientToServerEvents
  >
}

export function connectBrowserPanel(
  panelId: string,
  initialVisible: boolean,
  handlers: {
    message(message: BrowserServerMessage): void
    frame(frame: BrowserFrame): void
  },
  socketFactory: BrowserPanelSocketFactory = defaultSocketFactory
): BrowserPanelConnection {
  const clientId = crypto.randomUUID()
  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let currentVisible = initialVisible
  let ready = false
  let socket: BrowserPanelSocket | null = null
  const pendingCommands: BrowserClientMessage[] = []

  const reportError = (cause: unknown) => {
    handlers.message({
      type: 'browserUnavailable',
      message: cause instanceof Error ? cause.message : String(cause),
      installCommand: null
    })
  }

  const connect = async () => {
    const response = await fetch(
      `/api/panels/${encodeURIComponent(panelId)}/browser-ticket`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId })
      }
    )
    const result = browserTicketResponseSchema.parse(await response.json())
    if (!response.ok || !result.ticket) {
      throw new Error(
        result.error?.message ?? 'Could not attach hosted browser'
      )
    }

    if (disposed) {
      return
    }

    socket = socketFactory('/browsers', {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { ticket: result.ticket, protocolVersion: BROWSER_PROTOCOL_VERSION }
    })
    socket.on('message', (value) => {
      const parsed = browserServerMessageSchema.safeParse(value)
      if (!parsed.success) {
        socket?.disconnect()
        return
      }

      const message = parsed.data
      handlers.message(message)
      if (message.type !== 'ready') {
        return
      }

      ready = true
      socket?.emit('command', {
        type: 'setVisible',
        visible: currentVisible
      })
      while (pendingCommands.length) {
        socket?.emit('command', pendingCommands.shift()!)
      }
    })
    socket.on('frame', (value) => {
      const frame = browserFrameSchema.safeParse(value)
      if (frame.success) {
        handlers.frame(frame.data)
      } else {
        socket?.disconnect()
      }
    })
    socket.on('disconnect', () => {
      ready = false
      if (disposed) {
        return
      }

      reconnectTimer = setTimeout(() => void connect().catch(reportError), 500)
    })
    socket.on('connect_error', reportError)
  }

  void connect().catch(reportError)

  return {
    send(value) {
      const command = parseBrowserClientMessage(value)
      if (!command || disposed) {
        return
      }

      if (socket?.connected && ready) {
        socket.emit('command', command)
        return
      }

      pendingCommands.push(command)
      if (pendingCommands.length > 32) {
        pendingCommands.shift()
      }
    },
    setBounds() {},
    setVisible(nextVisible) {
      currentVisible = nextVisible
      if (ready) {
        socket?.emit('command', { type: 'setVisible', visible: nextVisible })
      }
    },
    dispose() {
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
      }

      socket?.disconnect()
    }
  }
}
