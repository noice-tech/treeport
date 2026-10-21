import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import {
  parseBrowserServerMessage,
  type BrowserServerMessage
} from '@treeport/shared'
import type { BrowserCapturePage } from './browser-video'
import { captureChromiumWebCodecs } from './chromium-webcodecs-capture'

export interface ChromiumWebCodecsViewer {
  start(
    send: (message: BrowserServerMessage) => boolean,
    frame: (data: Uint8Array) => boolean
  ): boolean
  ack(epoch: number, sequence: number): void
}

// One exact tab, one controlling viewer, one outstanding packet.
// The helper authenticates on loopback; viewers use the existing ticket/identity
// authenticated Treeport socket. Capability tokens never appear in URLs/logs.
export class ChromiumWebCodecsVideo {
  private helper: BrowserCapturePage['page'] | null = null
  private server: WebSocketServer | null = null
  private socket: WebSocket | null = null
  private viewer: {
    id: string
    epoch: number
    send(message: BrowserServerMessage): boolean
    frame(data: Uint8Array): boolean
    ready: boolean
    sequence: number
    outstanding: boolean
    first: Uint8Array | null
  } | null = null
  private epoch = 0
  private width = 0
  private height = 0

  constructor(
    private readonly openCapturePage: () => Promise<BrowserCapturePage>,
    private readonly extensionId: string,
    private readonly failed: (message: string) => void
  ) {}

  async start(width: number, height: number): Promise<void> {
    const captureWidth = Math.max(2, Math.round(width / 2) * 2)
    const captureHeight = Math.max(2, Math.round(height / 2) * 2)
    if (this.server) {
      if (this.width === captureWidth && this.height === captureHeight) {
        return
      }

      // Reacquire at the new native capture size, not an upscaled old track.
      // A fresh helper/encoder and epoch retire the old packet and decoder;
      // the viewer waits for a new IDR and acknowledges decoder readiness.
      const viewer = this.viewer
      await this.stop()
      await this.start(width, height).catch((error) => {
        this.failed(
          'WebCodecs capture could not be resized. Reconnect to restart video.'
        )
        throw error
      })
      if (
        viewer &&
        !this.viewerSource(viewer.id).start(viewer.send, viewer.frame)
      ) {
        this.failed('Capture helper unavailable after resizing.')
      }

      return
    }

    this.width = captureWidth
    this.height = captureHeight
    const { page: helper, targetId } = await this.openCapturePage()
    this.helper = helper
    const lost = () => {
      if (this.helper === helper) {
        this.helper = null
        this.failed('Browser video capture stopped. Reconnect to restart it.')
      }
    }
    helper.once('crash', lost)
    helper.once('close', lost)
    await helper
      .goto(`chrome-extension://${this.extensionId}/capture.html`)
      .catch(async (error) => {
        await this.stop()
        throw error
      })
    const token = crypto.randomBytes(32).toString('hex')
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      perMessageDeflate: false,
      maxPayload: 2 * 1024 * 1024
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    }).catch(async (error) => {
      await this.stop()
      throw error
    })
    // SAFETY: listening has completed on a TCP host/port, never a Unix socket.
    const address = server.address() as AddressInfo
    const connected = new Promise<void>((resolve, reject) => {
      const startup = setTimeout(
        () => reject(new Error('Capture helper authentication timed out.')),
        5000
      )
      server.on('connection', (socket, request) => {
        if (
          this.socket ||
          server.clients.size > 2 ||
          request.headers.origin !== `chrome-extension://${this.extensionId}`
        ) {
          socket.terminate()
          return
        }

        const timeout = setTimeout(() => socket.terminate(), 3000)
        socket.once('message', (data, binary) => {
          clearTimeout(timeout)
          if (
            binary ||
            !Buffer.isBuffer(data) ||
            data.byteLength > 256 ||
            data.toString() !== JSON.stringify({ token }) ||
            this.socket
          ) {
            socket.terminate()
            return
          }

          clearTimeout(startup)
          this.socket = socket
          socket.on('message', (data, binary) => {
            if (this.socket !== socket) {
              return
            }

            const viewer = this.viewer
            if (!binary) {
              let value: { type?: string; message?: string } | null = null
              try {
                value = JSON.parse(data.toString())
              } catch {
                this.failed('Invalid capture helper metadata.')
                return
              }
              if (value?.type === 'error') {
                this.failed(String(value.message))
                return
              }

              const config = parseBrowserServerMessage(value)
              if (
                !viewer ||
                config?.type !== 'webcodecsReady' ||
                config.epoch !== viewer.epoch
              ) {
                return
              }

              if (!viewer.send(config)) {
                this.failed('Viewer metadata queue is full.')
              }

              return
            }

            if (!viewer) {
              return
            }

            if (!Buffer.isBuffer(data)) {
              this.failed('Invalid capture packet representation.')
              return
            }

            const packet = new Uint8Array(data)
            if (packet.byteLength < 42 || packet.byteLength > 2 * 1024 * 1024) {
              this.failed('Invalid encoded packet.')
              return
            }

            const header = new DataView(packet.buffer, packet.byteOffset)
            if (header.getUint32(0) !== viewer.epoch) {
              return
            }

            if (
              viewer.outstanding ||
              header.getUint32(4) !== viewer.sequence + 1
            ) {
              this.failed('Encoded stream continuity lost.')
              return
            }

            viewer.sequence++
            viewer.outstanding = true
            if (!viewer.ready && viewer.sequence === 1) {
              viewer.first = packet
            } else if (!viewer.ready || !viewer.frame(packet)) {
              this.failed('Viewer media lane was revoked or congested.')
            }
          })
          socket.once('close', () => {
            if (this.socket === socket) {
              this.socket = null
              this.failed(
                'Capture helper disconnected. Reconnect to restart video.'
              )
            }
          })
          socket.on('error', () => socket.close())
          resolve()
        })
        socket.once('close', () => clearTimeout(timeout))
      })
    })
    await Promise.all([
      connected,
      helper.evaluate(`(async () => {
        const target = (await chrome.debugger.getTargets()).find(
          target => target.id === ${JSON.stringify(targetId)}
        );
        if (!target?.tabId) throw new Error('The Browser capture target is unavailable.');
        const sourceId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.tabId });
        // Bound native acquisition, not just post-capture scaling. This helper
        // is recreated on resize so a larger viewport never upscales an old track.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: {
            chromeMediaSource: 'tab', chromeMediaSourceId: sourceId,
            maxWidth: ${captureWidth}, maxHeight: ${captureHeight}, maxFrameRate: 60
          } }
        });
        await (async () => {
          const track = stream.getVideoTracks()[0];
          await track.applyConstraints({
            width: { exact: ${captureWidth} }, height: { exact: ${captureHeight} },
            frameRate: { max: 60 }
          });
          track.contentHint = 'motion';
          globalThis.__treeportWebCodecs = await (${captureChromiumWebCodecs.toString()})(
            track, ${JSON.stringify(`ws://127.0.0.1:${address.port}`)}, ${JSON.stringify(token)}
          );
        })().catch(error => {
          stream.getTracks().forEach(track => track.stop());
          throw error;
        });
      })()`)
    ]).catch(async (error) => {
      await this.stop()
      throw error
    })
  }

  viewerSource(id: string): ChromiumWebCodecsViewer {
    return {
      start: (send, frame) => {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
          return false
        }

        this.viewer = {
          id,
          epoch: ++this.epoch,
          send,
          frame,
          ready: false,
          sequence: 0,
          outstanding: false,
          first: null
        }
        this.socket.send(JSON.stringify({ type: 'start', epoch: this.epoch }))
        return true
      },
      ack: (epoch, sequence) => {
        const viewer = this.viewer
        if (!viewer || viewer.id !== id || viewer.epoch !== epoch) {
          return
        }

        if (sequence === 0 && !viewer.ready) {
          viewer.ready = true
          if (viewer.first) {
            const packet = viewer.first
            viewer.first = null
            if (!viewer.frame(packet)) {
              this.failed('Viewer media lane was revoked or congested.')
            }
          }

          return
        }

        if (
          sequence === viewer.sequence &&
          viewer.ready &&
          viewer.outstanding
        ) {
          viewer.outstanding = false
          this.socket?.send(JSON.stringify({ type: 'ack', epoch, sequence }))
        }
      }
    }
  }

  async closeViewer(id: string): Promise<void> {
    if (this.viewer?.id !== id) {
      return
    }

    this.viewer = null
    this.socket?.send(JSON.stringify({ type: 'stop' }))
  }

  async stop(): Promise<void> {
    this.viewer = null
    this.socket = null
    const server = this.server
    this.server = null
    this.width = 0
    this.height = 0
    for (const client of server?.clients ?? []) {
      client.terminate()
    }
    server?.close()
    const helper = this.helper
    this.helper = null
    await helper?.close().catch(() => undefined)
  }
}
