import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserFrame, BrowserServerMessage } from '@treeport/shared'
import {
  connectBrowserPanel,
  type BrowserPanelSocket
} from './browser-session-client'

type SocketEvent = 'message' | 'frame' | 'disconnect' | 'connect_error'
type TransportFrame = Omit<BrowserFrame, 'data'> & { data: ArrayBuffer }
type SocketEventValue =
  | BrowserFrame
  | TransportFrame
  | BrowserServerMessage
  | Error
  | undefined

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
    this.handlers.set(event, [
      ...(this.handlers.get(event) ?? []),
      (value) => invokeListener(value)
    ])
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

  emitTransportFrame(value: TransportFrame): void {
    this.handlers.get('frame')?.forEach((listener) => listener(value))
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
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('connects the Browser workspace directly and preserves command and frame contracts', async () => {
  const socket = new FakeSocket()
  const reconnectedSocket = new FakeSocket()
  let socketCount = 0
  const messages: BrowserServerMessage[] = []
  const frames: BrowserFrame[] = []
  const connection = connectBrowserPanel(
    'panel-one',
    true,
    {
      message: (message) => messages.push(message),
      frame: (frame) => frames.push(frame)
    },
    () => (socketCount++ === 0 ? socket : reconnectedSocket)
  )
  connection.send({ type: 'navigate', url: 'https://example.com/' })
  await vi.waitFor(() => expect(socket.hasHandler('frame')).toBe(true))
  expect(fetch).toHaveBeenCalledWith(
    '/api/panels/panel-one/browser-ticket',
    expect.objectContaining({ method: 'POST' })
  )
  expect(
    JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))
  ).toMatchObject({ clientId: expect.any(String), visible: true })

  const ready: BrowserServerMessage = {
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
  }
  socket.emitServer('message', ready)
  socket.emitTransportFrame({
    sequence: 7,
    mimeType: 'image/jpeg',
    timestamp: 123,
    width: 1_280,
    height: 800,
    data: Uint8Array.from([1, 2, 3]).buffer
  })

  expect(messages).toEqual([ready])
  expect(frames).toEqual([
    expect.objectContaining({
      sequence: 7,
      mimeType: 'image/jpeg',
      data: Uint8Array.from([1, 2, 3])
    })
  ])
  expect(socket.emit).toHaveBeenNthCalledWith(1, 'command', {
    type: 'setVisible',
    visible: true
  })
  expect(socket.emit).toHaveBeenNthCalledWith(2, 'command', {
    type: 'navigate',
    url: 'https://example.com/'
  })

  vi.useFakeTimers()
  socket.emitServer('disconnect')
  connection.send({ type: 'takeControl' })
  connection.send({ type: 'frameAck', sequence: 7 })
  await vi.advanceTimersByTimeAsync(500)
  await vi.waitFor(() =>
    expect(reconnectedSocket.hasHandler('message')).toBe(true)
  )
  expect(fetch).toHaveBeenCalledTimes(2)
  reconnectedSocket.emitServer('message', ready)
  expect(reconnectedSocket.emit).toHaveBeenCalledExactlyOnceWith('command', {
    type: 'setVisible',
    visible: true
  })

  connection.dispose()
  expect(reconnectedSocket.emit).toHaveBeenLastCalledWith('command', {
    type: 'setVisible',
    visible: false
  })
  expect(reconnectedSocket.disconnect).toHaveBeenCalledOnce()
})
