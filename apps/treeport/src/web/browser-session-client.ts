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
  BROWSER_MAX_INSERT_TEXT_LENGTH,
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
  let protocolFailed = false
  let reconnectAttempts = 0
  let readyAt: number | null = null
  let connectedOnce = false
  let connecting = false
  let socket: BrowserPanelSocket | null = null
  const pendingCommands: BrowserClientMessage[] = []
  let viewport: Extract<BrowserClientMessage, { type: 'resize' }> | null = null

  const reportError = (cause: unknown) => {
    if (disposed) {
      return
    }

    handlers.message({
      type: 'browserUnavailable',
      message: cause instanceof Error ? cause.message : String(cause),
      installCommand: null
    })
  }

  const scheduleReconnect = () => {
    if (disposed || protocolFailed || reconnectTimer) {
      return
    }

    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null
        void connect().catch((cause) => {
          connecting = false
          reportError(cause)
          scheduleReconnect()
        })
      },
      Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempts++, 6))
    )
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
        body: JSON.stringify({ clientId, visible: currentVisible }),
        signal: AbortSignal.timeout(10_000)
      }
    )
    const body: unknown = await response.json().catch(() => null)
    const result = decodeUnknownOrNull(browserTicketResponseSchema, body)
    if (response.ok && !result) {
      protocolFailed = true
      throw new Error(
        'Browser ticket response is invalid. Automatic retries stopped. Reload or update Treeport to reconnect.'
      )
    }

    if (!response.ok || !result) {
      if ([400, 401, 403, 404].includes(response.status)) {
        protocolFailed = true
      }

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
        protocolFailed = true
        pendingCommands.length = 0
        ready = false
        socket = null
        reportError(
          new Error(
            'Browser protocol response is invalid. Automatic retries stopped. Reload Treeport to reconnect; if this continues, update Treeport and report the problem.'
          )
        )
        connectedSocket.disconnect()
        return
      }

      handlers.message(message)
      if (message.type !== 'ready') {
        return
      }

      if (!ready) {
        readyAt = Date.now()
      }

      ready = true
      connectedOnce = true
      connectedSocket.emit('command', {
        type: 'setVisible',
        visible: currentVisible
      })
      // A new attachment starts with the server viewport, not this panel's.
      // Replay layout even when no ResizeObserver notification follows reconnect.
      if (viewport) {
        connectedSocket.emit('command', viewport)
      }

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
      if (readyAt !== null && Date.now() - readyAt >= 30_000) {
        reconnectAttempts = 0
      }

      readyAt = null
      const lostInput = pendingCommands.length > 0
      pendingCommands.length = 0
      reportError(
        new Error(
          lostInput
            ? 'Browser disconnected before queued input was sent. Reconnecting; queued input was not replayed. Retry your input after reconnecting.'
            : 'Browser disconnected. Reconnecting with backoff (up to 30 seconds).'
        )
      )
      scheduleReconnect()
    })
    connectedSocket.on('connect_error', (error) => {
      if (socket !== connectedSocket) {
        return
      }

      // Detach first: disconnect must not overwrite the useful server error.
      socket = null
      ready = false
      readyAt = null
      const lostInput = pendingCommands.length > 0
      pendingCommands.length = 0
      reportError(
        new Error(
          `${error.message}${lostInput ? ' Queued input was not sent; retry it after reconnecting.' : ''}`
        )
      )
      connectedSocket.disconnect()
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
      if (disposed) {
        return
      }

      if (!command) {
        handlers.message({
          type: 'navigationError',
          message:
            value.type === 'insertText'
              ? `Paste was not sent. The limit is ${BROWSER_MAX_INSERT_TEXT_LENGTH.toLocaleString('en-US')} UTF-16 code units; paste smaller portions. No text was inserted.`
              : 'Browser command was not sent because it is invalid.'
        })
        return
      }

      if (command.type === 'resize') {
        viewport = command
        if (socket?.connected && ready) {
          socket.emit('command', command)
        }

        return
      }

      if (socket?.connected && ready) {
        socket.emit('command', command)
        return
      }

      // Never queue paste: a delayed paste can target a different page or owner.
      // Keep the initial command queue bounded without silently evicting input.
      if (
        !protocolFailed &&
        !connectedOnce &&
        command.type !== 'insertText' &&
        pendingCommands.length < 32
      ) {
        pendingCommands.push(command)
      } else if (
        command.type !== 'frameAck' &&
        command.type !== 'requestVideoKeyframe'
      ) {
        handlers.message({
          type: 'navigationError',
          message:
            'Browser input was not sent. Wait for the browser to reconnect, then retry your input.'
        })
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
