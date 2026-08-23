import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserFrame, BrowserServerMessage } from '@treeport/shared'
import {
  connectBrowserPanel,
  type BrowserPanelSocket
} from './browser-session-client'

type SocketEvent = 'message' | 'frame' | 'disconnect' | 'connect_error'
type SocketEventValue = BrowserFrame | BrowserServerMessage | Error | undefined

interface PanelFrame {
  type: 'frame'
  sequence: number
  mimeType: 'image/jpeg'
  width: number
  height: number
  data: ArrayBuffer
}

class FakeSocket implements BrowserPanelSocket {
  connected = true
  readonly emit = vi.fn()
  readonly disconnect = vi.fn()
  private readonly handlers = new Map<
    SocketEvent,
    Array<(value: SocketEventValue) => void>
  >()

  on(event: 'message', listener: (message: BrowserServerMessage) => void): void
  on(event: 'frame', listener: (frame: BrowserFrame) => void): void
  on(event: 'disconnect', listener: () => void): void
  on(event: 'connect_error', listener: (error: Error) => void): void
  on(
    event: SocketEvent,
    listener:
      | ((message: BrowserServerMessage) => void)
      | ((frame: BrowserFrame) => void)
      | (() => void)
      | ((error: Error) => void)
  ): void {
    // SAFETY: emitServer supplies the value type that corresponds to event.
    const invokeListener = listener as (eventValue: SocketEventValue) => void
    const invoke = (value: SocketEventValue) => invokeListener(value)
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), invoke])
  }

  hasHandler(event: SocketEvent): boolean {
    return (this.handlers.get(event)?.length ?? 0) > 0
  }

  emitServer(event: 'message', value: BrowserServerMessage): void
  emitServer(event: 'frame', value: BrowserFrame): void
  emitServer(event: 'disconnect', value?: undefined): void
  emitServer(event: 'connect_error', value: Error): void
  emitServer(event: SocketEvent, value?: SocketEventValue): void {
    this.handlers.get(event)?.forEach((listener) => listener(value))
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ticket: 'ticket-value' }), {
          status: 200
        })
    )
  )
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('forwards socket frames to the panel as typed transferable messages', async () => {
  const socket = new FakeSocket()
  const channel = new MessageChannel()
  const receivedFrame = new Promise<PanelFrame>((resolve) => {
    channel.port2.onmessage = (event) => {
      if (event.data?.type === 'frame') {
        resolve(event.data)
      }
    }
  })
  channel.port2.start()
  const connection = connectBrowserPanel(
    'panel-one',
    channel.port1,
    true,
    () => socket
  )
  await vi.waitFor(() => expect(socket.hasHandler('frame')).toBe(true))

  socket.emitServer('message', {
    type: 'ready',
    state: {
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      controlled: true,
      hasController: true,
      controller: 'you',
      viewport: { width: 1_280, height: 800 }
    }
  })
  socket.emitServer('frame', {
    sequence: 7,
    mimeType: 'image/jpeg',
    timestamp: 123,
    width: 1_280,
    height: 800,
    data: Uint8Array.from([1, 2, 3])
  })

  const message = await receivedFrame
  expect(message).toMatchObject({
    type: 'frame',
    sequence: 7,
    mimeType: 'image/jpeg',
    width: 1_280,
    height: 800
  })
  expect([...new Uint8Array(message.data)]).toEqual([1, 2, 3])

  connection.dispose()
  channel.port2.close()
})
