import { EventEmitter } from 'node:events'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parseBrowserOwnerServerMessage } from '@treeport/shared'
import type { BrowserFrame, BrowserRuntimeState } from '@treeport/shared'
import { receiveBrowserVideo } from './browser-video'
import {
  PlaywrightBrowser,
  type PlaywrightBrowserHost
} from './playwright-browser'
import { testAccess } from './test-access'

it('keeps the attempted HTTP URL when Chromium navigates to an internal error page', async () => {
  let currentUrl = 'about:blank'
  const frame = {}
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async () => ({ currentIndex: 0, entries: [] }))
  })
  const page = Object.assign(new EventEmitter(), {
    url: () => currentUrl,
    title: async () => 'localhost',
    isClosed: () => false,
    mainFrame: () => frame,
    setViewportSize: vi.fn(async () => undefined)
  })
  const host = testAccess<PlaywrightBrowserHost>({
    openPage: async () => ({
      browser: new EventEmitter(),
      context: { newCDPSession: async () => cdp },
      page
    }),
    closePage: vi.fn(async () => undefined)
  })
  const states: BrowserRuntimeState[] = []
  const browser = new PlaywrightBrowser(host, '/unused', {
    state: (state) => states.push(state),
    frame: () => undefined,
    popup: () => undefined,
    navigationError: () => undefined,
    crashed: () => undefined
  })
  onTestFinished(() => browser.close())
  await browser.launch()

  const attemptedUrl = 'http://127.0.0.1:3002/auth/sign-in'
  page.emit('request', {
    url: () => attemptedUrl,
    method: () => 'GET',
    isNavigationRequest: () => true,
    frame: () => frame
  })
  currentUrl = 'chrome-error://chromewebdata/'
  page.emit('load')
  await vi.waitFor(() => {
    expect(states).toHaveLength(4)
    expect(browser.state.loading).toBe(false)
    expect(browser.state.url).toBe(attemptedUrl)
  })
  // Every emitted state must remain usable in the desktop ownership handshake.
  for (const state of states) {
    expect(
      parseBrowserOwnerServerMessage({
        type: 'claimGranted',
        panelId: 'panel_browser',
        generation: 1,
        resumed: false,
        state
      })
    ).not.toBeNull()
  }

  currentUrl = 'https://example.com/recovered'
  page.emit('load')
  await vi.waitFor(() => expect(browser.state.url).toBe(currentUrl))
  currentUrl = 'about:blank'
  page.emit('load')
  await vi.waitFor(() => expect(browser.state.url).toBe('about:blank'))
})

it('relays encoded video without changing its dependencies and rejects invalid capture output', () => {
  const frames: Array<Omit<BrowserFrame, 'sequence'>> = []
  const failures: string[] = []
  const receive = (payload: string) =>
    receiveBrowserVideo(
      payload,
      (frame) => frames.push(frame),
      (message) => failures.push(message)
    )
  const frame = {
    mimeType: 'video/vp8',
    keyframe: true,
    timestamp: 1,
    width: 800,
    height: 600,
    data: Buffer.from([1, 2, 3]).toString('base64')
  }
  receive(JSON.stringify({ frame, error: null }))
  receive(
    JSON.stringify({
      frame: { ...frame, timestamp: 33_334, keyframe: false },
      error: null
    })
  )
  expect(frames).toEqual([
    { ...frame, data: Buffer.from([1, 2, 3]) },
    {
      ...frame,
      data: Buffer.from([1, 2, 3]),
      timestamp: 33_334,
      keyframe: false
    }
  ])
  receive(JSON.stringify({ frame: { ...frame, width: 100_000 }, error: null }))
  receive('{invalid')
  receive(JSON.stringify({ frame: null, error: 'Capture stopped' }))
  expect(frames).toHaveLength(2)
  expect(failures).toHaveLength(3)
  expect(failures.at(-1)).toBe('Capture stopped')
})
