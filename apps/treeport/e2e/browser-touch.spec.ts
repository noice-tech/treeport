import { expect, test } from '@playwright/test'
import type { BrowserClientMessage } from '@treeport/shared'
import { browserTouch, browserWheel } from '../src/server/browser-input'
import { browserCursor } from '../src/server/browser-cursor'

declare global {
  interface Window {
    browserMessages: BrowserClientMessage[]
    remoteTouches: { type: string; ids: number[] }[]
    remoteClicks: number
    remoteWheel: {
      ctrlKey: boolean
      metaKey: boolean
      altKey: boolean
      shiftKey: boolean
      x: number
      y: number
      deltaY: number
      trusted: boolean
    } | null
  }
}

test.use({ hasTouch: true, viewport: { width: 400, height: 600 } })

test('remote video forwards native touch, trackpad pinch and cancellation', async ({
  page
}) => {
  const remote = await page.context().newPage()
  await remote.setViewportSize({ width: 800, height: 600 })
  await remote.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1">
    <body style="margin:0;height:3000px"><button style="width:800px;height:600px">Tap</button></body>`)
  await remote.evaluate(() => {
    window.remoteClicks = 0
    window.remoteTouches = []
    document.addEventListener('click', () => window.remoteClicks++)

    for (const type of [
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel'
    ] as const) {
      document.addEventListener(type, (event) => {
        window.remoteTouches.push({
          type,
          ids: [...event.touches].map((touch) => touch.identifier)
        })
      })
    }
  })
  const remoteCdp = await remote.context().newCDPSession(remote)

  // Mount the real app without a daemon/video encoder. Only its transport is
  // replaced; Chromium supplies native touch arbitration and pointer capture.
  await page.route('**/src/web/browser-session-client.ts', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `export function connectBrowserApp(id, local, callbacks) {
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
          const { BrowserAppWorkspace } = await import('/src/web/features/browser-apps/browser-app-workspace.tsx');
          await import('/src/web/styles.css');
          createRoot(document.getElementById('root')).render(createElement(BrowserAppWorkspace, {
            app: { id: 'touch-check', title: 'Touch check', url: 'https://example.com/' },
            active: true, autoFocusBlocked: true, inputBlocked: false,
            onLoadingChange() {}, onFaviconChange() {}, onFocusSurface() {}
          }));
        </script>`
    })
  )
  await page.goto('/touch-check')
  const video = page.locator('video')
  await expect(video).toBeVisible()
  await expect(video).toHaveCSS('touch-action', 'none')
  const bounds = (await video.boundingBox())!
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2

  const messages = () =>
    page.evaluate(() =>
      window.browserMessages.filter(
        (message) =>
          message.type === 'pointer' ||
          message.type === 'wheel' ||
          message.type === 'touch'
      )
    )

  const replay = async () => {
    for (const message of (await messages()).filter(
      (message) => message.type === 'touch'
    )) {
      await browserTouch(remoteCdp, message)
    }
  }

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
  expect(await messages()).toEqual([
    {
      type: 'touch',
      phase: 'start',
      points: [{ id: expect.any(Number), x: 400, y: 300 }]
    }
  ])
  await touch('touchMove', [{ x: x + 2, y: y - 2 }])
  await touch('touchEnd', [])
  expect(
    (await messages()).map(
      (message) => message.type === 'touch' && message.phase
    )
  ).toEqual(['start', 'move', 'end'])
  await replay()
  await expect.poll(() => remote.evaluate(() => window.remoteClicks)).toBe(1)

  await clear()
  await touch('touchStart', [{ x, y }])
  await touch('touchMove', [{ x: x - 20, y: y - 40 }])
  await touch('touchMove', [{ x: x - 40, y: y - 80 }])
  await touch('touchEnd', [])
  const swipe = await messages()
  const scale = Math.min(bounds.width / 800, bounds.height / 600)
  expect(swipe).toHaveLength(4)
  expect(swipe[1]).toEqual({
    type: 'touch',
    phase: 'move',
    points: [
      {
        id: expect.any(Number),
        x: expect.closeTo(400 - 20 / scale),
        y: expect.closeTo(300 - 40 / scale)
      }
    ]
  })
  await replay()
  await expect
    .poll(() => remote.evaluate(() => window.scrollY))
    .toBeGreaterThan(0)
  expect(await remote.evaluate(() => window.remoteClicks)).toBe(1)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)

  await clear()
  await touch('touchStart', [{ x, y }])
  await touch('touchCancel', [])
  expect((await messages()).at(-1)).toEqual({
    type: 'touch',
    phase: 'cancel',
    points: []
  })
  await replay()
  expect(await remote.evaluate(() => window.remoteClicks)).toBe(1)

  // A page with custom touch handling receives stable contacts, including a
  // single-finger release while the other finger continues moving.
  await remote.evaluate(() => {
    document.body.style.touchAction = 'none'
    window.remoteTouches = []
  })
  await clear()
  await touch('touchStart', [{ x, y, id: 1 }])
  await touch('touchStart', [
    { x, y, id: 1 },
    { x: x + 50, y, id: 2 }
  ])
  await touch('touchStart', [
    { x, y, id: 1 },
    { x: x + 50, y, id: 2 },
    { x: x - 50, y, id: 3 }
  ])
  await touch('touchEnd', [{ x: x - 50, y, id: 3 }])
  await touch('touchMove', [
    { x: x - 10, y, id: 1 },
    { x: x + 60, y, id: 2 }
  ])
  await touch('touchEnd', [{ x: x - 10, y, id: 1 }])
  await touch('touchMove', [{ x: x + 70, y, id: 2 }])
  await touch('touchEnd', [])
  await replay()
  const contacts = await remote.evaluate(() => window.remoteTouches)
  expect(
    contacts
      .filter((event) => event.type === 'touchstart')
      .map((event) => event.ids.length)
  ).toEqual([1, 2, 3])
  expect(
    contacts
      .filter((event) => event.type === 'touchend')
      .map((event) => event.ids.length)
  ).toEqual([2, 1, 0])
  const secondId = contacts.find((event) => event.ids.length === 2)!.ids[1]
  expect(
    contacts.filter((event) => event.type === 'touchmove').at(-1)?.ids
  ).toEqual([secondId])

  // Native pinch zoom affects the remote page, not the workspace viewport.
  await remote.evaluate(() => {
    document.body.style.touchAction = 'auto'
  })
  await clear()
  await touch('touchStart', [
    { x: x - 20, y, id: 1 },
    { x: x + 20, y, id: 2 }
  ])

  for (let step = 1; step <= 8; step++) {
    await touch('touchMove', [
      { x: x - 20 - step * 6, y, id: 1 },
      { x: x + 20 + step * 6, y, id: 2 }
    ])
  }

  await touch('touchEnd', [])
  await replay()
  await expect
    .poll(() => remote.evaluate(() => window.visualViewport!.scale))
    .toBeGreaterThan(1)
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1)

  await remote.evaluate(() => {
    const viewport = window.visualViewport!
    const target = document.createElement('div')
    target.style.cssText = `position:fixed;width:20px;height:20px;cursor:crosshair;left:${viewport.offsetLeft + 400 / viewport.scale - 10}px;top:${viewport.offsetTop + 300 / viewport.scale - 10}px`
    document.body.append(target)
  })
  expect(await browserCursor(remote, { x: 400, y: 300 })).toBe('crosshair')

  await clear()
  await touch('touchStart', [
    { x, y, id: 1 },
    { x: x + 50, y, id: 2 }
  ])
  await video.evaluate((element) => element.blur())
  await touch('touchEnd', [])
  expect((await messages()).at(-1)).toEqual({
    type: 'touch',
    phase: 'cancel',
    points: []
  })

  // Trackpad pinch supplies ctrlKey on wheel without a physical Control key
  // press. Preserve it (and the focal point) just as a wheel-driven editor needs.
  await remote.evaluate(() => {
    window.remoteWheel = null
    document.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        window.remoteWheel = {
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          x: event.clientX,
          y: event.clientY,
          deltaY: event.deltaY,
          trusted: event.isTrusted
        }
      },
      { passive: false }
    )
  })
  await clear()
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.floor(x),
    y: Math.floor(y),
    deltaX: 0,
    deltaY: -40,
    modifiers: 2
  })

  const wheels = (await messages()).filter(
    (message) => message.type === 'wheel'
  )

  const wheelPoint = {
    x: 400 + (Math.floor(x) - x) / scale,
    y: 300 + (Math.floor(y) - y) / scale
  }

  expect(wheels).toEqual([
    {
      type: 'wheel',
      x: expect.closeTo(wheelPoint.x),
      y: expect.closeTo(wheelPoint.y),
      deltaX: 0,
      deltaY: -40,
      modifiers: 2
    }
  ])
  await browserWheel(remoteCdp, wheels[0]!)

  const focalPoint = await remote.evaluate(
    ({ x, y }) => ({
      x: window.visualViewport!.offsetLeft + x / window.visualViewport!.scale,
      y: window.visualViewport!.offsetTop + y / window.visualViewport!.scale,
      scale: window.visualViewport!.scale
    }),
    wheelPoint
  )

  await expect
    .poll(() => remote.evaluate(() => window.remoteWheel))
    .toEqual({
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      x: Math.floor(focalPoint.x),
      y: Math.floor(focalPoint.y),
      deltaY: expect.closeTo(-40 / focalPoint.scale),
      trusted: true
    })
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1)

  // Mouse dragging remains mouse input rather than becoming touch scrolling.
  await page.mouse.move(x, y)
  await clear()
  await page.mouse.down()
  // Fractional viewer coordinates must map consistently for moves and buttons.
  await page.mouse.move(x + 20.25, y + 20.75)
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

  const pointers = (await messages()).filter(
    (message) => message.type === 'pointer'
  )

  expect(pointers[1]).toMatchObject({
    x: pointers[2]!.x,
    y: pointers[2]!.y
  })

  // The viewer's desired viewport survives remounts independently of the
  // host's confirmed viewport. Returning in a landscape window must not
  // overwrite a custom portrait size, even in the first resize command.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page
    .getByRole('button', { name: 'Responsive mode', exact: true })
    .click()
  await page
    .getByRole('combobox', { name: 'Viewport preset' })
    .selectOption('phone')
  await page.getByRole('spinbutton', { name: 'Viewport width' }).fill('412')
  await page.getByRole('spinbutton', { name: 'Viewport width' }).press('Enter')
  await page.getByRole('spinbutton', { name: 'Viewport height' }).fill('915')
  await page.getByRole('spinbutton', { name: 'Viewport height' }).press('Enter')
  await page.reload()

  const resizes = () =>
    page.evaluate(() =>
      (window.browserMessages ?? []).filter(
        (message) => message.type === 'resize'
      )
    )

  await expect
    .poll(resizes)
    .toEqual([{ type: 'resize', width: 412, height: 915 }])
  await expect(
    page.getByRole('spinbutton', { name: 'Viewport width' })
  ).toHaveValue('412')
  await expect(
    page.getByRole('spinbutton', { name: 'Viewport height' })
  ).toHaveValue('915')

  // Exiting fixed-size mode must also survive a reload.
  await page
    .getByRole('button', { name: 'Responsive mode', exact: true })
    .click()
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Responsive mode', exact: true })
  ).toHaveAttribute('aria-pressed', 'false')
  await expect(
    page.getByRole('spinbutton', { name: 'Viewport width' })
  ).toHaveCount(0)
  await expect
    .poll(resizes)
    .toEqual([{ type: 'resize', width: 400, height: expect.any(Number) }])
})
