import type { BrowserServerMessage } from '@treeport/shared'
import {
  connectBrowserApp,
  type BrowserAppConnection,
  type BrowserAppSocketFactory
} from './browser-session-client'
import { BrowserVideoReceiver } from './browser-video-receiver'

export interface RemoteBrowserConnection extends BrowserAppConnection {
  stats(): ReturnType<BrowserVideoReceiver['stats']>
}

// The workspace owns a connection, not independent signaling and media objects.
// Visibility and disposal always reach both halves in the same order.
export function connectRemoteBrowser(
  appId: string,
  video: HTMLVideoElement,
  handlers: {
    message(message: BrowserServerMessage): void
    failed(message: string): void
    statusChanged(message: string): void
  },
  socketFactory?: BrowserAppSocketFactory
): RemoteBrowserConnection {
  const receiver = new BrowserVideoReceiver(
    video,
    (message) => connection.send(message),
    handlers.failed,
    handlers.statusChanged
  )
  const connection = connectBrowserApp(
    appId,
    false,
    {
      message: (message) => {
        if (message.type === 'ready') {
          handlers.statusChanged('Waiting for browser video…')
        }

        receiver.receive(message)
        if (message.type !== 'videoReady' && message.type !== 'videoAnswer') {
          handlers.message(message)
        }
      }
    },
    socketFactory
  )
  return {
    send: (message) => connection.send(message),
    setVisible: (visible) => {
      receiver.setVisible(visible)
      connection.setVisible(visible)
    },
    stats: () => receiver.stats(),
    dispose: () => {
      receiver.dispose()
      connection.dispose()
    }
  }
}
