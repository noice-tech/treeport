import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { authorizeRequest } from './request-security'

const PANEL_PATH = /^\/api\/browser-devtools\/(panel_[a-f0-9]{32})$/u

export function createBrowserDevtoolsBridge(
  resolveEndpoint: (panelId: string) => Promise<string>
) {
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024
  })
  const upstreams = new Set<WebSocket>()

  return {
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const pathname = new URL(request.url ?? '/', 'http://treeport.local')
        .pathname
      if (!pathname.startsWith('/api/browser-devtools/')) {
        return false
      }

      const panelId = PANEL_PATH.exec(pathname)?.[1]
      const security = authorizeRequest(request, {
        socketUpgrade: true,
        devtoolsUpgrade: true
      })
      if (!panelId || !security.allowed) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return true
      }

      void resolveEndpoint(panelId).then(
        (endpoint) => {
          if (socket.destroyed) {
            return
          }

          server.handleUpgrade(request, socket, head, (viewer) => {
            server.emit('connection', viewer, request)
            // Chrome's debugging endpoint is loopback-only. Never pass the
            // DevTools window's Origin header to the local Chrome socket.
            const upstream = new WebSocket(endpoint, {
              perMessageDeflate: false,
              maxPayload: 16 * 1024 * 1024
            })
            upstreams.add(upstream)
            const pending: Array<{ data: Buffer; binary: boolean }> = []
            let pendingBytes = 0
            viewer.on('message', (data, binary) => {
              // SAFETY: ws message payloads are Node Buffers in this server.
              const message = Buffer.from(data as Buffer)
              if (upstream.readyState === WebSocket.OPEN) {
                if (upstream.bufferedAmount > 16 * 1024 * 1024) {
                  viewer.close(1009, 'DevTools input overflow')
                } else {
                  upstream.send(message, { binary })
                }
              } else if (upstream.readyState === WebSocket.CONNECTING) {
                pendingBytes += message.length
                if (pendingBytes > 1024 * 1024) {
                  viewer.close(1009, 'DevTools input overflow')
                } else {
                  pending.push({ data: message, binary })
                }
              }
            })
            upstream.on('open', () => {
              for (const message of pending) {
                upstream.send(message.data, { binary: message.binary })
              }
              pending.length = 0
            })
            upstream.on('message', (data, binary) => {
              if (viewer.readyState === WebSocket.OPEN) {
                if (viewer.bufferedAmount > 16 * 1024 * 1024) {
                  viewer.close(1009, 'DevTools output overflow')
                } else {
                  viewer.send(data, { binary })
                }
              }
            })
            viewer.on('close', () => {
              if (upstream.readyState === WebSocket.CONNECTING) {
                upstream.terminate()
              } else if (upstream.readyState === WebSocket.OPEN) {
                upstream.close()
              }
            })
            upstream.on('close', () => viewer.close())
            upstream.on('error', () => viewer.close())
            viewer.on('error', () => {
              if (upstream.readyState === WebSocket.CONNECTING) {
                upstream.terminate()
              } else if (upstream.readyState === WebSocket.OPEN) {
                upstream.close()
              }
            })
            upstream.on('close', () => upstreams.delete(upstream))
          })
        },
        () => {
          if (!socket.destroyed) {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
            socket.destroy()
          }
        }
      )
      return true
    },
    close() {
      for (const viewer of server.clients) {
        viewer.close(1001, 'Treeport stopped')
      }
      for (const upstream of upstreams) {
        if (upstream.readyState === WebSocket.CONNECTING) {
          upstream.terminate()
        } else if (upstream.readyState === WebSocket.OPEN) {
          upstream.close()
        }
      }
      server.close()
    }
  }
}
