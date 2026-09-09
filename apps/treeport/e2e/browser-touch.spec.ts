import { expect, test } from '@playwright/test'
import type { BrowserClientMessage } from '@treeport/shared'

declare global {
  interface Window {
    browserMessages: BrowserClientMessage[]
  }
}

test.use({ hasTouch: true, viewport: { width: 400, height: 600 } })

test('remote canvas separates taps, swipes and cancelled gestures', async ({
  page
}) => {
  // Mount the real panel without a daemon/video encoder. Only its transport is
  // replaced; Chromium supplies native touch arbitration and pointer capture.
  await page.route('**/src/web/browser-session-client.ts', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `export function connectBrowserPanel(id, local, callbacks) {
        window.browserMessages = [];
        queueMicrotask(() => callbacks.message({ type: 'ready', state: {
          url: 'https://example.com/', viewport: { width: 800, height: 600 },
          controlled: true, loading: false
        }}));
        return { send(message) { window.browserMessages.push(message) },
          setVisible() {}, dispose() {} };
      }`
    })
  )
  await page.route('**/touch-check', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body { margin: 0; min-height: 1200px }</style>
        <div id="root" style="width:400px;height:350px"></div>
        <script type="module">
          import RefreshRuntime from '/@react-refresh';
          RefreshRuntime.injectIntoGlobalHook(window);
          window.$RefreshReg$ = () => {};
          window.$RefreshSig$ = () => (type) => type;
          window.__vite_plugin_react_preamble_installed__ = true;
          const { default: { createElement } } = await import('/node_modules/.vite/deps/react.js');
          const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
          const { BrowserPanelWorkspace } = await import('/src/web/features/browser-panels/browser-panel-workspace.tsx');
          await import('/src/web/styles.css');
          createRoot(document.getElementById('root')).render(createElement(BrowserPanelWorkspace, {
            panel: { id: 'touch-check', title: 'Touch check', url: 'https://example.com/' },
            active: true, autoFocusBlocked: true, inputBlocked: false,
            onLoadingChange() {}, onFocusSurface() {}
          }));
        </script>`
    })
  )
  await page.goto('/touch-check')
  const canvas = page.locator('canvas')
  await expect(canvas).toBeVisible()
  await expect(canvas).toHaveCSS('touch-action', 'pinch-zoom')
  const bounds = (await canvas.boundingBox())!
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  const messages = () =>
    page.evaluate(() =>
      window.browserMessages.filter(
        (message) => message.type === 'pointer' || message.type === 'wheel'
      )
    )
  const clear = () =>
    page.evaluate(() => {
      window.browserMessages = []
    })
  const cdp = await page.context().newCDPSession(page)
  const touch = (
    type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
    points: { x: number; y: number; id?: number }[]
  ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })

  await touch('touchStart', [{ x, y }])
  expect(await messages()).toEqual([])
  await touch('touchMove', [{ x: x + 2, y: y - 2 }])
  await touch('touchEnd', [])
  expect(await messages()).toEqual([
    { type: 'pointer', phase: 'down', x: 400, y: 300, button: 'left' },
    { type: 'pointer', phase: 'up', x: 400, y: 300, button: 'left' }
  ])

  await clear()
  await touch('touchStart', [{ x, y }])
  await touch('touchMove', [{ x: x - 20, y: y - 40 }])
  await touch('touchMove', [{ x: x - 40, y: y - 80 }])
  await touch('touchEnd', [])
  const swipe = await messages()
  expect(swipe[0]).toEqual({ type: 'pointer', phase: 'move', x: 400, y: 300 })
  const scale = Math.min(bounds.width / 800, bounds.height / 600)
  expect(swipe).toHaveLength(3)
  for (const message of swipe.slice(1)) {
    expect(message).toEqual({
      type: 'wheel',
      deltaX: expect.closeTo(20 / scale),
      deltaY: expect.closeTo(40 / scale)
    })
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(0)

  await clear()
  await touch('touchStart', [{ x, y }])
  await touch('touchCancel', [])
  expect(await messages()).toEqual([])

  await touch('touchStart', [{ x, y, id: 1 }])
  await touch('touchStart', [
    { x, y, id: 1 },
    { x: x + 50, y, id: 2 }
  ])
  await touch('touchEnd', [])
  expect(await messages()).toEqual([])

  // Mouse dragging remains mouse input rather than becoming touch scrolling.
  await page.mouse.move(x, y)
  await clear()
  await page.mouse.down()
  await page.mouse.move(x + 20, y + 20)
  await page.mouse.up()
  expect(
    (await messages()).map((message) => [
      message.type,
      message.type === 'pointer' ? message.phase : null
    ])
  ).toEqual([
    ['pointer', 'down'],
    ['pointer', 'move'],
    ['pointer', 'up']
  ])
})
