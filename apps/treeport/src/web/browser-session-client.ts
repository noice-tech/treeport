import { io, type Socket } from 'socket.io-client'
import type {
  BrowserClientToServerEvents,
  BrowserFrame,
  BrowserServerMessage,
  BrowserServerToClientEvents
} from '@treeport/shared'
import { BROWSER_PROTOCOL_VERSION, SOCKET_IO_PATH } from '@treeport/shared'

export interface BrowserPanelConnectMessage {
  source: 'treeport-browser-panel-v1'
  method: 'browser.connect'
}

export function isBrowserPanelConnectMessage(
  value: unknown
): value is BrowserPanelConnectMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'source') === 'treeport-browser-panel-v1' &&
    Reflect.get(value, 'method') === 'browser.connect'
  )
}

export function connectBrowserPanel(
  panelId: string,
  port: MessagePort,
  initialVisible: boolean
): { dispose(): void; setVisible(visible: boolean): void } {
  const clientId = crypto.randomUUID()
  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let currentVisible = initialVisible
  let ready = false
  let socket: Socket<
    BrowserServerToClientEvents,
    BrowserClientToServerEvents
  > | null = null
  const pendingCommands: unknown[] = []

  const connect = async () => {
    const response = await fetch(
      `/api/panels/${encodeURIComponent(panelId)}/browser-ticket`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId })
      }
    )
    const result = (await response.json()) as {
      ticket?: string
      error?: { message?: string }
    }
    if (!response.ok || !result.ticket) {
      throw new Error(
        result.error?.message ?? 'Could not attach hosted browser'
      )
    }

    const ticket = result.ticket
    if (disposed) {
      return
    }

    socket = io('/browsers', {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { ticket, protocolVersion: BROWSER_PROTOCOL_VERSION }
    })
    socket.on('message', (message: BrowserServerMessage) => {
      port.postMessage(message)
      if (message.type !== 'ready') {
        return
      }

      ready = true
      socket?.emit('command', {
        type: 'setVisible',
        visible: currentVisible
      })
      while (pendingCommands.length) {
        socket?.emit('command', pendingCommands.shift())
      }
    })
    socket.on('frame', (frame: BrowserFrame) => {
      const bytes = new Uint8Array(frame.data)
      const copy = bytes.slice()
      port.postMessage({ type: 'frame', ...frame, data: copy.buffer }, [
        copy.buffer
      ])
    })
    socket.on('disconnect', () => {
      ready = false
      if (disposed) {
        return
      }

      reconnectTimer = setTimeout(() => void connect().catch(reportError), 500)
    })
    socket.on('connect_error', (error) => {
      port.postMessage({
        type: 'browserUnavailable',
        message: error.message,
        installCommand: null
      } satisfies BrowserServerMessage)
    })
  }

  const reportError = (error: unknown) => {
    port.postMessage({
      type: 'browserUnavailable',
      message: error instanceof Error ? error.message : String(error),
      installCommand: null
    } satisfies BrowserServerMessage)
  }

  port.onmessage = (event) => {
    if (socket?.connected && ready) {
      socket.emit('command', event.data)
    } else {
      pendingCommands.push(event.data)
      if (pendingCommands.length > 32) {
        pendingCommands.shift()
      }
    }
  }
  port.start()
  void connect().catch(reportError)

  return {
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
      port.close()
    }
  }
}
