import {
  apiErrorBodySchema,
  browserTicketResponseSchema,
  createProtocolSocket,
  decodeUnknownOrNull
} from '@treeport/shared'
import type {
  BrowserClientMessage,
  BrowserVideoSettings,
  BrowserClientToServerEvents,
  BrowserServerMessage,
  BrowserServerToClientEvents
} from '@treeport/shared'
import {
  BROWSER_MAX_INSERT_TEXT_LENGTH,
  parseBrowserClientMessage,
  parseBrowserServerMessage
} from '@treeport/shared'

export interface BrowserAppConnection {
  dispose(): void
  send(message: BrowserClientMessage): void
  setVisible(visible: boolean): void
}

export interface BrowserVideoConnection extends BrowserAppConnection {
  configureVideo(settings: BrowserVideoSettings): Promise<void>
}

export interface BrowserAppSocket {
  connected: boolean
  emit(event: 'command', message: BrowserClientMessage): void
  on(event: 'message', listener: (message: BrowserServerMessage) => void): void
  on(event: 'disconnect', listener: () => void): void
  on(event: 'connect_error', listener: (error: Error) => void): void
  disconnect(): void
}

interface BrowserAppSocketOptions {
  reconnection: false
  auth: {
    ticket: string
  }
}

export type BrowserAppSocketFactory = (
  namespace: string,
  options: BrowserAppSocketOptions
) => BrowserAppSocket

const defaultSocketFactory: BrowserAppSocketFactory = (namespace, options) => {
  return createProtocolSocket<
    BrowserServerToClientEvents,
    BrowserClientToServerEvents
  >(namespace, options)
}

let browserViewerId: string | null = null

export function connectBrowserApp(
  appId: string,
  initialVisible: boolean,
  handlers: {
    message(message: BrowserServerMessage): void
  },
  socketFactory: BrowserAppSocketFactory = defaultSocketFactory
): BrowserVideoConnection {
  if (browserViewerId === null) {
    browserViewerId = crypto.randomUUID()

    try {
      browserViewerId =
        sessionStorage.getItem('treeport-browser-client-id') || browserViewerId
      sessionStorage.setItem('treeport-browser-client-id', browserViewerId)
    } catch {}
  }

  const viewerId = browserViewerId
  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let currentVisible = initialVisible
  let ready = false
  let reconnectAllowed = true
  let reconnectAttempts = 0
  let readyAt: number | null = null
  let connectedOnce = false
  let connecting = false
  let socket: BrowserAppSocket | null = null
  const pendingCommands: BrowserClientMessage[] = []
  let viewport: Extract<BrowserClientMessage, { type: 'resize' }> | null = null

  let pendingVideoSettings: {
    requestId: string
    resolve(): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  const finishVideoSettings = (error: Error | null) => {
    const pending = pendingVideoSettings
    pendingVideoSettings = null

    if (pending) {
      clearTimeout(pending.timer)

      if (error) {
        pending.reject(error)
      } else {
        pending.resolve()
      }
    }
  }

  const reportError = (cause: unknown) => {
    finishVideoSettings(
      cause instanceof Error ? cause : new Error(String(cause))
    )

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
    if (disposed || !reconnectAllowed || reconnectTimer) {
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
      `/api/apps/${encodeURIComponent(appId)}/browser-ticket`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: viewerId, visible: currentVisible }),
        signal: AbortSignal.timeout(10_000)
      }
    )

    const body: unknown = await response.json().catch(() => null)

    if (disposed) {
      connecting = false

      return
    }

    const result = decodeUnknownOrNull(browserTicketResponseSchema, body)

    if (response.ok && !result) {
      reconnectAllowed = false
      throw new Error('The host sent an invalid Browser ticket response.')
    }

    if (!response.ok || !result) {
      if ([400, 401, 403, 404].includes(response.status)) {
        reconnectAllowed = false
      }

      const error = decodeUnknownOrNull(apiErrorBodySchema, body)
      throw new Error(error?.error.message ?? 'Could not attach hosted browser')
    }

    const connectedSocket = socketFactory('/browsers', {
      reconnection: false,
      auth: { ticket: result.ticket }
    })

    socket = connectedSocket
    connecting = false
    connectedSocket.on('message', (value) => {
      if (socket !== connectedSocket) {
        return
      }

      const message = parseBrowserServerMessage(value)

      if (!message) {
        reconnectAllowed = false
        pendingCommands.length = 0
        ready = false
        socket = null
        connectedSocket.disconnect()
        reportError(new Error('The host sent an invalid Browser message.'))

        return
      }

      if (message.type === 'videoSettingsResult') {
        if (pendingVideoSettings?.requestId === message.requestId) {
          finishVideoSettings(message.error ? new Error(message.error) : null)
        }

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

      if (viewport) {
        connectedSocket.emit('command', viewport)
      }

      while (pendingCommands.length) {
        connectedSocket.emit('command', pendingCommands.shift()!)
      }
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
    configureVideo(settings) {
      if (disposed || !ready || !socket?.connected) {
        return Promise.reject(new Error('Wait for the browser to reconnect.'))
      }

      if (pendingVideoSettings) {
        return Promise.reject(
          new Error('Stream settings are already being applied.')
        )
      }

      const requestId = crypto.randomUUID()

      const command = parseBrowserClientMessage({
        type: 'setVideoSettings',
        requestId,
        settings
      })

      if (!command) {
        return Promise.reject(new Error('Invalid stream settings.'))
      }

      const connectedSocket = socket

      return new Promise<void>((resolve, reject) => {
        pendingVideoSettings = {
          requestId,
          resolve,
          reject,
          timer: setTimeout(
            () =>
              finishVideoSettings(
                new Error(
                  'Stream settings timed out. Check the applied settings before retrying.'
                )
              ),
            15_000
          )
        }
        connectedSocket.emit('command', command)
      })
    },
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

      if (
        reconnectAllowed &&
        !connectedOnce &&
        command.type !== 'insertText' &&
        command.type !== 'copy' &&
        command.type !== 'fileChooserResponse' &&
        command.type !== 'dialogResponse' &&
        command.type !== 'videoOffer' &&
        command.type !== 'inputBarrier' &&
        command.type !== 'refreshRate' &&
        command.type !== 'webcodecsStop' &&
        command.type !== 'setVideoSettings' &&
        pendingCommands.length < 32
      ) {
        pendingCommands.push(command)
      } else if (
        command.type !== 'videoOffer' &&
        command.type !== 'inputBarrier' &&
        command.type !== 'refreshRate' &&
        command.type !== 'webcodecsStop'
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
      finishVideoSettings(new Error('Browser connection closed.'))
      pendingCommands.length = 0

      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
      }

      socket?.disconnect()
    }
  }
}
