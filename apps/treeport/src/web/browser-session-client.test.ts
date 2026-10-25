import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserServerMessage } from '@treeport/shared'
import {
  connectBrowserApp,
  type BrowserAppSocket
} from './browser-session-client'

type SocketEvent = 'message' | 'disconnect' | 'connect_error'

type SocketEventValue = BrowserServerMessage | Error | undefined

class FakeSocket implements BrowserAppSocket {
  connected = true
  readonly emit = vi.fn()
  readonly disconnect = vi.fn()
  private readonly handlers = new Map<
    SocketEvent,
    Array<(value: SocketEventValue) => void>
  >()

  on(event: 'message', listener: (message: BrowserServerMessage) => void): void
  on(event: 'disconnect', listener: () => void): void
  on(event: 'connect_error', listener: (error: Error) => void): void
  on(
    event: SocketEvent,
    listener:
      | ((message: BrowserServerMessage) => void)
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
  emitServer(event: 'disconnect', value?: undefined): void
  emitServer(event: 'connect_error', value: Error): void
  emitServer(event: SocketEvent, value?: SocketEventValue): void {
    this.handlers.get(event)?.forEach((listener) => listener(value))
  }
}

beforeEach(() => {
  vi.stubGlobal('window', { location: { reload: vi.fn() } })

  const storage = new Map<string, string>([
    ['treeport-browser-client-id', '12121212-1212-4212-9212-121212121212']
  ])

  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ticket: 'b'.repeat(43) }), {
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

it('preserves control and video signaling and reconnects without replaying offers', async () => {
  const socket = new FakeSocket()
  const reconnectedSocket = new FakeSocket()
  let socketCount = 0
  const messages: BrowserServerMessage[] = []

  const connection = connectBrowserApp(
    'app-one',
    true,
    {
      message: (message) => messages.push(message)
    },
    () => (socketCount++ === 0 ? socket : reconnectedSocket)
  )

  connection.send({ type: 'resize', width: 900, height: 600 })
  connection.send({ type: 'resize', width: 280, height: 180 })
  connection.send({ type: 'navigate', url: 'https://example.com/' })
  await vi.waitFor(() => expect(socket.hasHandler('message')).toBe(true))
  expect(fetch).toHaveBeenCalledWith(
    '/api/apps/app-one/browser-ticket',
    expect.objectContaining({ method: 'POST' })
  )
  expect(
    JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))
  ).toMatchObject({
    clientId: sessionStorage.getItem('treeport-browser-client-id'),
    visible: true
  })

  const ready: BrowserServerMessage = {
    type: 'ready',
    state: {
      url: 'about:blank',
      title: '',
      faviconUrl: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      controlled: true,
      hasController: true,
      controller: 'you',
      controllerDetails: null,
      videoSettings: null,
      viewport: { width: 1_280, height: 800 }
    }
  }

  socket.emitServer('message', ready)
  socket.emitServer('message', { type: 'videoReady' })
  expect(window.location.reload).not.toHaveBeenCalled()
  expect(messages).toEqual([ready, { type: 'videoReady' }])
  expect(socket.emit).toHaveBeenNthCalledWith(1, 'command', {
    type: 'setVisible',
    visible: true
  })
  expect(socket.emit).toHaveBeenNthCalledWith(2, 'command', {
    type: 'resize',
    width: 280,
    height: 180
  })
  expect(socket.emit).toHaveBeenNthCalledWith(3, 'command', {
    type: 'navigate',
    url: 'https://example.com/'
  })

  vi.useFakeTimers()
  socket.emitServer('disconnect')
  connection.send({ type: 'takeControl' })
  connection.send({ type: 'videoOffer', requestId: 'stale', sdp: 'offer' })
  await vi.advanceTimersByTimeAsync(500)
  await vi.waitFor(() =>
    expect(reconnectedSocket.hasHandler('message')).toBe(true)
  )
  expect(fetch).toHaveBeenCalledTimes(2)
  reconnectedSocket.emitServer('message', ready)
  expect(window.location.reload).not.toHaveBeenCalled()
  expect(messages.at(-1)).toEqual(ready)
  expect(reconnectedSocket.emit.mock.calls).toEqual([
    ['command', { type: 'setVisible', visible: true }],
    ['command', { type: 'resize', width: 280, height: 180 }]
  ])
  connection.send({ type: 'navigate', url: 'https://example.com/reconnected' })
  expect(reconnectedSocket.emit).toHaveBeenLastCalledWith('command', {
    type: 'navigate',
    url: 'https://example.com/reconnected'
  })

  connection.dispose()
  expect(reconnectedSocket.disconnect).toHaveBeenCalledOnce()

  const clientId = sessionStorage.getItem('treeport-browser-client-id')

  const remounted = connectBrowserApp(
    'app-one',
    true,
    { message: vi.fn() },
    () => new FakeSocket()
  )

  expect(fetch).toHaveBeenCalledTimes(3)
  expect(
    JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)![1]?.body))
  ).toMatchObject({ clientId })
  remounted.dispose()

  // Switching away and back reloads the module, but retains this origin's
  // sessionStorage in the desktop workspace's WebContents.
  vi.resetModules()
  const restoredClient = await import('./browser-session-client')

  const restored = restoredClient.connectBrowserApp(
    'app-one',
    true,
    { message: vi.fn() },
    () => new FakeSocket()
  )

  expect(fetch).toHaveBeenCalledTimes(4)
  expect(
    JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)![1]?.body))
  ).toMatchObject({ clientId })
  restored.dispose()

  vi.resetModules()
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() })
  const otherWindowClient = await import('./browser-session-client')

  const otherWindow = otherWindowClient.connectBrowserApp(
    'app-one',
    true,
    { message: vi.fn() },
    () => new FakeSocket()
  )

  expect(fetch).toHaveBeenCalledTimes(5)
  expect(
    JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)![1]?.body))
  ).not.toMatchObject({ clientId })
  otherWindow.dispose()
})
