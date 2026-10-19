import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import { parseBrowserOwnerServerMessage } from '@treeport/shared'
import type { BrowserRuntimeState } from '@treeport/shared'
import {
  prepareBrowserVideoExtension,
  type BrowserCapturePage
} from './browser-video'
import type { BrowserClipboardReader } from './browser-clipboard'
import { PlaywrightBrowser } from './playwright-browser'
import type { PlaywrightBrowserHost } from './browser-page-host'
import { testAccess } from './test-access'

it('keeps the attempted HTTP URL when Chromium navigates to an internal error page', async () => {
  let currentUrl = 'about:blank'
  const frame = {}
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async () => ({
      currentIndex: 0,
      entries: [],
      cssVisualViewport: { scale: 2 }
    }))
  })
  const page = Object.assign(new EventEmitter(), {
    url: () => currentUrl,
    title: async () => 'localhost',
    isClosed: () => false,
    mainFrame: () => frame,
    mouse: {
      move: vi.fn(async (_x: number, _y: number) => undefined),
      down: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined)
    },
    keyboard: { insertText: vi.fn(async () => undefined) },
    exposeBinding: vi.fn(async () => undefined),
    addInitScript: vi.fn(async () => undefined),
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
  const navigationError = vi.fn()
  const browser = new PlaywrightBrowser(host, '/unused', {
    state: (state) => states.push(state),
    popup: () => undefined,
    clipboard: () => false,
    fileChooser: () => undefined,
    navigationError,
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
  page.emit('requestfailed', {
    isNavigationRequest: () => true,
    frame: () => frame,
    failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' })
  })
  expect(browser.state.loading).toBe(false)
  expect(navigationError).not.toHaveBeenCalled()
  currentUrl = 'chrome-error://chromewebdata/'
  page.emit('load')
  await vi.waitFor(() => {
    expect(states).toHaveLength(5)
    expect(browser.state.loading).toBe(false)
    expect(browser.state.url).toBe(attemptedUrl)
  })
  // Every emitted state must remain usable in the desktop ownership handshake.
  for (const state of states) {
    expect(
      parseBrowserOwnerServerMessage({
        type: 'claimGranted',
        appId: 'app_browser',
        generation: 1,
        resumed: false,
        state
      })
    ).not.toBeNull()
  }

  currentUrl = 'https://example.com/recovered'
  page.emit('load')
  await vi.waitFor(() => expect(browser.state.url).toBe(currentUrl))
  currentUrl = 'file:///tmp/preview%20draft.html#section'
  page.emit('load')
  await vi.waitFor(() => expect(browser.state.url).toBe(currentUrl))
  currentUrl = 'about:blank'
  page.emit('load')
  await vi.waitFor(() => expect(browser.state.url).toBe('about:blank'))

  // Native button events reuse the correctly scaled position. Navigation,
  // other input and failed positioning invalidate it; explicit moves still run.
  const point = { type: 'pointer' as const, x: 20, y: 40 }
  await browser.command({ ...point, phase: 'move' })
  await browser.command({ ...point, phase: 'down' })
  await browser.command({ ...point, phase: 'up' })
  expect(page.mouse.move).toHaveBeenCalledExactlyOnceWith(10, 20)
  expect(page.mouse.down).toHaveBeenCalledOnce()
  expect(page.mouse.up).toHaveBeenCalledOnce()
  await browser.command({ ...point, phase: 'move' })
  expect(page.mouse.move).toHaveBeenCalledTimes(2)
  page.emit('framenavigated', frame)
  await browser.command({ ...point, phase: 'down' })
  expect(page.mouse.move).toHaveBeenCalledTimes(3)
  await browser.command({ type: 'insertText', text: 'x' })
  await browser.command({ ...point, phase: 'down' })
  expect(page.mouse.move).toHaveBeenCalledTimes(4)
  page.mouse.move.mockRejectedValueOnce(new Error('Positioning failed'))
  await expect(browser.command({ ...point, phase: 'move' })).rejects.toThrow(
    'Positioning failed'
  )
  await browser.command({ ...point, phase: 'down' })
  expect(page.mouse.move).toHaveBeenCalledTimes(6)
})

it('dismisses hosted beforeunload safely and settles canceled reload without losing the page', async () => {
  const cdp = Object.assign(new EventEmitter(), {
    send: async () => ({ currentIndex: 0, entries: [] })
  })
  const dismiss = vi.fn(async () => {
    throw new Error('No dialog is showing')
  })
  let rejectReload: (error: Error) => void = () => undefined
  const page = Object.assign(new EventEmitter(), {
    url: () => 'https://example.com/unsaved',
    title: async () => 'Unsaved work',
    isClosed: () => false,
    exposeBinding: vi.fn(async () => undefined),
    addInitScript: vi.fn(async () => undefined),
    setViewportSize: async () => undefined,
    reload: () =>
      new Promise((_resolve, reject) => {
        rejectReload = reject
        queueMicrotask(() =>
          page.emit('dialog', { type: () => 'beforeunload', dismiss })
        )
      })
  })
  const host = testAccess<PlaywrightBrowserHost>({
    openPage: async () => ({
      browser: new EventEmitter(),
      context: { newCDPSession: async () => cdp },
      page
    }),
    closePage: vi.fn(async () => undefined)
  })
  const browser = new PlaywrightBrowser(host, '/unused', {
    state: () => undefined,
    popup: () => undefined,
    clipboard: () => false,
    fileChooser: () => undefined,
    navigationError: () => undefined,
    crashed: () => undefined
  })
  onTestFinished(() => browser.close())
  await browser.launch()
  await expect(browser.command({ type: 'reload' })).rejects.toThrow(
    'Navigation canceled by beforeunload'
  )
  expect(dismiss).toHaveBeenCalledOnce()
  expect(browser.state.loading).toBe(false)
  expect(browser.state.url).toBe('https://example.com/unsaved')
  expect(page.listenerCount('dialog')).toBe(1)
  expect(host.closePage).not.toHaveBeenCalled()
  rejectReload(new Error('Browser disconnected during cleanup'))
  await new Promise<void>((resolve) => setImmediate(resolve))
})

it('does not grant helper pages allocation or viewport capabilities', () => {
  expectTypeOf<BrowserCapturePage['page']>().not.toHaveProperty(
    'setViewportSize'
  )
  expectTypeOf<BrowserCapturePage['page']>().not.toHaveProperty('context')
  expectTypeOf<BrowserClipboardReader['page']>().not.toHaveProperty(
    'setViewportSize'
  )
  expectTypeOf<BrowserClipboardReader['page']>().not.toHaveProperty('context')
})

it('prepares a private exact-tab capture extension without website entry points', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-video-'))
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }))
  const extension = await prepareBrowserVideoExtension(directory)
  expect(extension.id).toMatch(/^[a-p]{32}$/)
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')
  )
  expect(manifest.permissions).toEqual(['tabCapture', 'debugger'])
  expect(manifest.externally_connectable).toBeUndefined()
  expect(manifest.web_accessible_resources).toBeUndefined()
  expect(manifest.content_scripts).toBeUndefined()
})
