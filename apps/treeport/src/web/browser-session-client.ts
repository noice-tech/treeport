import {
  apiErrorBodySchema,
  browserTicketResponseSchema,
  createProtocolSocket,
  decodeUnknownOrNull
} from '@treeport/shared'
import type {
  BrowserClientMessage,
  BrowserClientToServerEvents,
  BrowserFrame,
  BrowserServerMessage,
  BrowserServerToClientEvents
} from '@treeport/shared'
import {
  BROWSER_PROTOCOL_VERSION,
  parseBrowserClientMessage,
  parseBrowserServerMessage
} from '@treeport/shared'

export interface BrowserPanelConnection {
  dispose(): void
  send(message: BrowserClientMessage): void
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
  return createProtocolSocket<
    BrowserServerToClientEvents,
    BrowserClientToServerEvents
  >(namespace, options)
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
  let connectedOnce = false
  let connecting = false
  let socket: BrowserPanelSocket | null = null
  const pendingCommands: BrowserClientMessage[] = []

  const reportError = (cause: unknown) => {
    handlers.message({
      type: 'browserUnavailable',
      message: cause instanceof Error ? cause.message : String(cause),
      installCommand: null
    })
  }

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer) {
      return
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect().catch((cause) => {
        connecting = false
        reportError(cause)
        scheduleReconnect()
      })
    }, 500)
  }

  const connect = async () => {
    if (disposed || connecting) {
      return
    }

    connecting = true
    const response = await fetch(
      `/api/panels/${encodeURIComponent(panelId)}/browser-ticket`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, visible: currentVisible })
      }
    )
    const body: unknown = await response.json()
    const result = decodeUnknownOrNull(browserTicketResponseSchema, body)
    if (!response.ok || !result) {
      const error = decodeUnknownOrNull(apiErrorBodySchema, body)
      throw new Error(error?.error.message ?? 'Could not attach hosted browser')
    }

    if (disposed) {
      connecting = false
      return
    }

    const connectedSocket = socketFactory('/browsers', {
      reconnection: false,
      auth: { ticket: result.ticket, protocolVersion: BROWSER_PROTOCOL_VERSION }
    })
    socket = connectedSocket
    connecting = false
    connectedSocket.on('message', (value) => {
      if (socket !== connectedSocket) {
        return
      }

      const message = parseBrowserServerMessage(value)
      if (!message) {
        connectedSocket.disconnect()
        return
      }

      handlers.message(message)
      if (message.type !== 'ready') {
        return
      }

      ready = true
      connectedOnce = true
      connectedSocket.emit('command', {
        type: 'setVisible',
        visible: currentVisible
      })
      while (pendingCommands.length) {
        connectedSocket.emit('command', pendingCommands.shift()!)
      }
    })
    connectedSocket.on('frame', (value) => {
      if (socket !== connectedSocket) {
        return
      }

      handlers.frame(value)
    })
    connectedSocket.on('disconnect', () => {
      if (socket !== connectedSocket) {
        return
      }

      socket = null
      ready = false
      pendingCommands.length = 0
      scheduleReconnect()
    })
    connectedSocket.on('connect_error', (error) => {
      if (socket !== connectedSocket) {
        return
      }

      reportError(error)
      connectedSocket.disconnect()
      socket = null
      ready = false
      scheduleReconnect()
    })
  }

  void connect().catch((cause) => {
    connecting = false
    reportError(cause)
    scheduleReconnect()
  })

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

      if (!connectedOnce) {
        pendingCommands.push(command)
        if (pendingCommands.length > 32) {
          pendingCommands.shift()
        }
      }
    },
    setVisible(nextVisible) {
      currentVisible = nextVisible
      if (ready) {
        socket?.emit('command', { type: 'setVisible', visible: nextVisible })
      }
    },
    dispose() {
      if (ready) {
        socket?.emit('command', { type: 'setVisible', visible: false })
      }

      disposed = true
      pendingCommands.length = 0
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
      }

      socket?.disconnect()
    }
  }
}
