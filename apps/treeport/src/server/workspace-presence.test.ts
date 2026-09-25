import crypto from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  PRESENCE_TIMEOUT_MS,
  type ProductEvent,
  type ViewerIdentity
} from '@treeport/shared'
import { ProductEventBus } from './core/events'
import { WorkspacePresenceManager } from './workspace-presence'

it('renews quiet viewers without broadcasts, expires lost tabs, and bounds memory', ({
  onTestFinished
}) => {
  vi.useFakeTimers()
  const events = new ProductEventBus()
  const manager = new WorkspacePresenceManager(events)
  const received: ProductEvent[] = []
  const unsubscribe = events.subscribe((event) => received.push(event))
  onTestFinished(() => {
    manager.dispose()
    unsubscribe()
    vi.useRealTimers()
  })
  const alice: ViewerIdentity = {
    source: 'tailscale',
    login: 'alice@example.test',
    name: 'Alice',
    profilePicture: null
  }
  const tab = {
    sessionId: crypto.randomUUID(),
    worktreeId: 'wt',
    focusedPanelId: 'pi',
    visible: true,
    focused: true
  }
  manager.update(alice, tab)
  manager.update(alice, { ...tab, sessionId: crypto.randomUUID() })
  expect(manager.snapshot()).toHaveLength(2)
  vi.advanceTimersByTime(15_000)
  manager.update(alice, tab)
  expect(received).toHaveLength(2)
  vi.advanceTimersByTime(PRESENCE_TIMEOUT_MS - 15_000)
  expect(manager.snapshot()).toMatchObject([{ sessionId: tab.sessionId }])
  expect(received.at(-1)).toMatchObject({
    type: 'presence.changed',
    data: { viewers: [{ sessionId: tab.sessionId }] }
  })
  vi.advanceTimersByTime(15_000)
  expect(manager.snapshot()).toEqual([])
  expect(received.at(-1)).toMatchObject({
    type: 'presence.changed',
    data: { viewers: [] }
  })

  for (let index = 0; index < 256; index++) {
    manager.update(alice, { ...tab, sessionId: crypto.randomUUID() })
  }
  expect(() => manager.update(alice, tab)).toThrow('Too many workspace viewers')
  vi.advanceTimersByTime(PRESENCE_TIMEOUT_MS)
  manager.update(alice, tab)
  expect(manager.snapshot()).toHaveLength(1)
  manager.update(alice, { ...tab, worktreeId: null, focusedPanelId: null })
  expect(manager.snapshot()).toEqual([])
  const count = received.length
  vi.advanceTimersByTime(PRESENCE_TIMEOUT_MS)
  expect(received).toHaveLength(count)
})
