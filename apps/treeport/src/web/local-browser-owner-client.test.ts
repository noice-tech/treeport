import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserOwnerServerMessage } from '@treeport/shared'
import { connectLocalBrowserOwner } from './local-browser-owner-client'

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('bounds ownership startup, cancels abandoned claims, and keeps a granted owner connected', async () => {
  vi.useFakeTimers()
  const events = new EventEmitter()
  const socket = {
    connected: true,
    on: events.on.bind(events),
    emit: vi.fn(),
    disconnect: vi.fn(() => {
      socket.connected = false
      events.emit('disconnect')
    })
  }
  const socketFactory = () => {
    socket.connected = true
    return socket
  }
  const handlers = {
    setRuntimeControl: vi.fn(async () => true),
    requestClose: vi.fn(async () => true),
    closed: vi.fn(),
    disconnected: vi.fn()
  }
  const ticket = { ticket: 'a'.repeat(43), challenge: 'b'.repeat(43) }

  const timedOut = connectLocalBrowserOwner(
    'panel_browser_1',
    ticket,
    'http://127.0.0.1:9222/',
    handlers,
    new AbortController().signal,
    socketFactory
  )
  const timeoutFailure = expect(timedOut).rejects.toThrow('did not respond')
  await vi.advanceTimersByTimeAsync(10_000)
  await timeoutFailure
  expect(socket.disconnect).toHaveBeenCalledTimes(1)
  // A failed claim is one failed attempt, not also a disconnected live owner.
  expect(handlers.disconnected).not.toHaveBeenCalled()
  events.removeAllListeners()

  const controller = new AbortController()
  const canceled = connectLocalBrowserOwner(
    'panel_browser_1',
    ticket,
    'http://127.0.0.1:9222/',
    handlers,
    controller.signal,
    socketFactory
  )
  const cancelFailure = expect(canceled).rejects.toThrow('canceled')
  controller.abort()
  await cancelFailure
  expect(socket.disconnect).toHaveBeenCalledTimes(2)
  expect(handlers.disconnected).not.toHaveBeenCalled()
  events.removeAllListeners()

  const activeController = new AbortController()
  const connecting = connectLocalBrowserOwner(
    'panel_browser_1',
    ticket,
    'http://127.0.0.1:9222/',
    handlers,
    activeController.signal,
    socketFactory
  )
  const claim: BrowserOwnerServerMessage = {
    type: 'claimGranted',
    panelId: 'panel_browser_1',
    generation: 3,
    resumed: true,
    state: {
      url: 'https://example.com/',
      title: 'Example',
      loading: true,
      canGoBack: false,
      canGoForward: false,
      viewport: { width: 800, height: 600 }
    }
  }
  events.emit('ownerMessage', claim)
  const owner = await connecting
  expect(owner.resumed).toBe(true)
  expect(owner.initialState).toEqual(claim.state)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(socket.disconnect).toHaveBeenCalledTimes(2)

  owner.sendReady(claim.state)
  owner.takeControl()
  expect(socket.emit.mock.calls).toEqual([
    [
      'ownerMessage',
      { type: 'ready', generation: 3, revision: 1, state: claim.state }
    ],
    ['ownerMessage', { type: 'takeControl', generation: 3 }]
  ])
  events.emit('ownerMessage', {
    type: 'runtimeControl',
    generation: 3,
    requestId: 'control_1',
    controller: 'none',
    retainPaint: false
  } satisfies BrowserOwnerServerMessage)
  await vi.waitFor(() =>
    expect(socket.emit).toHaveBeenLastCalledWith('ownerMessage', {
      type: 'runtimeControlResult',
      generation: 3,
      requestId: 'control_1',
      accepted: true
    })
  )
  expect(handlers.setRuntimeControl).toHaveBeenCalledWith('none', false)
  socket.connected = false
  events.emit('disconnect')
  expect(handlers.disconnected).toHaveBeenCalledTimes(1)
  const sentBeforeDispose = socket.emit.mock.calls.length
  owner.dispose()
  expect(socket.emit).toHaveBeenCalledTimes(sentBeforeDispose)
  expect(handlers.disconnected).toHaveBeenCalledTimes(1)
})
