import { EventEmitter, once } from 'node:events'
import { expect, it, vi } from 'vitest'
import * as Effect from 'effect/Effect'
import { WebSocket } from 'ws'
import { DesktopRuntime } from './desktop-runtime'
import { createBrowserCdpBridge } from './browser-cdp-bridge'

it('keeps native beforeunload out of automation and reports only canceled navigation', async () => {
  const debuggerEvents = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: async () => ({})
  })
  const guest = Object.assign(new EventEmitter(), {
    debugger: debuggerEvents,
    isDestroyed: () => false,
    getTitle: () => 'Unsaved work',
    getURL: () => 'https://example.com/'
  })
  const runtime = new DesktopRuntime()
  try {
    // SAFETY: This fake supplies the guest/debugger methods used by bridge setup and teardown.
    const bridge = await runtime.run(
      createBrowserCdpBridge(
        guest as never,
        {
          panelId: 'test',
          challenge: 'test'
        },
        runtime
      )
    )
    const socket = new WebSocket(
      bridge.descriptor.endpoint.replace('http:', 'ws:') + 'devtools/browser'
    )
    await once(socket, 'open')
    const messages: string[] = []
    socket.on('message', (data) => messages.push(data.toString()))
    const event = (
      method: string,
      params: { type?: string; result?: boolean }
    ) => debuggerEvents.emit('message', {}, method, params)
    event('Page.javascriptDialogOpening', { type: 'beforeunload' })
    event('Page.javascriptDialogClosed', { result: false })
    event('Page.javascriptDialogOpening', { type: 'beforeunload' })
    event('Page.javascriptDialogClosed', { result: true })
    event('Page.javascriptDialogOpening', { type: 'alert' })
    event('Page.javascriptDialogClosed', { result: false })
    await vi.waitFor(() => expect(messages).toHaveLength(3))
    expect(messages.map((message) => JSON.parse(message).method)).toEqual([
      'Treeport.navigationCanceled',
      'Page.javascriptDialogOpening',
      'Page.javascriptDialogClosed'
    ])
    socket.terminate()
  } finally {
    await Effect.runPromise(runtime.close)
  }
  expect(debuggerEvents.listenerCount('message')).toBe(0)
})
