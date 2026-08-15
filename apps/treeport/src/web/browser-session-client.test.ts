import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserFrame, BrowserServerMessage } from '@treeport/shared'

const socketClient = vi.hoisted(() => ({ io: vi.fn() }))
vi.mock('socket.io-client', () => ({ io: socketClient.io }))

class FakeSocket {
  connected = true
  readonly emit = vi.fn()
  readonly disconnect = vi.fn()
  private readonly handlers = new Map<
    string,
    Array<(value: BrowserFrame | BrowserServerMessage) => void>
  >()

  on(
    event: string,
    listener: (value: BrowserFrame | BrowserServerMessage) => void
  ): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }

  emitServer(event: string, value: BrowserFrame | BrowserServerMessage): void {
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
  socketClient.io.mockReturnValue(socket)
  const postMessage = vi.fn()
  const port = {
    postMessage,
    start: vi.fn(),
    close: vi.fn(),
    onmessage: null
  } as unknown as MessagePort
  const { connectBrowserPanel } = await import('./browser-session-client')
  const connection = connectBrowserPanel('panel-one', port, true)
  await vi.waitFor(() => expect(socketClient.io).toHaveBeenCalledOnce())

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

  const [message, transfer] = postMessage.mock.calls.find(
    ([value]) => value.type === 'frame'
  )!
  expect(message).toMatchObject({
    type: 'frame',
    sequence: 7,
    mimeType: 'image/jpeg',
    width: 1_280,
    height: 800
  })
  expect([...new Uint8Array(message.data)]).toEqual([1, 2, 3])
  expect(transfer).toEqual([message.data])

  connection.dispose()
})
