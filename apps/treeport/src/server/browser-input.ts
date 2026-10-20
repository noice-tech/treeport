import type { BrowserClientMessage } from '@treeport/shared'
import type { CDPSession, Page } from 'playwright'

const keyboardStates = new WeakMap<
  Page,
  { mac: boolean; modifiers: number; meta: boolean; keys: Set<string> }
>()

export async function browserKey(
  page: Page,
  message: Extract<BrowserClientMessage, { type: 'key' }>
): Promise<void> {
  let state = keyboardStates.get(page)
  if (!state) {
    state = {
      // Local Electron guests can run on a different OS from the daemon.
      mac: await page.evaluate(() => /Mac/.test(navigator.platform)),
      modifiers: 0,
      meta: false,
      keys: new Set()
    }
    keyboardStates.set(page, state)
  }

  const meta = Boolean(message.modifiers & 4)
  // Match the remote platform's primary shortcut modifier, so Command+Z/K
  // from a Mac also works in a Linux/Windows browser and its web apps.
  const modifiers =
    !state.mac && meta ? (message.modifiers & ~4) | 2 : message.modifiers
  for (const [key, bit] of [
    ['Alt', 1],
    ['Control', 2],
    ['Meta', 4],
    ['Shift', 8]
  ] as const) {
    if ((modifiers & bit) === (state.modifiers & bit)) {
      continue
    }

    if (modifiers & bit) {
      await page.keyboard.down(key)
    } else {
      await page.keyboard.up(key)
    }

    state.modifiers = (state.modifiers & ~bit) | (modifiers & bit)
  }

  // macOS can omit keyup for keys pressed while Command is held. Release
  // them with Command so the next press is not treated as an auto-repeat.
  if (state.meta && !meta) {
    for (const key of state.keys) {
      await page.keyboard.up(key)
    }
    state.keys.clear()
  }

  state.meta = meta

  if (['Alt', 'Control', 'Meta', 'Shift'].includes(message.key)) {
    return
  }

  if (message.phase === 'down') {
    await page.keyboard.down(message.key)
    state.keys.add(message.key)
  } else {
    await page.keyboard.up(message.key)
    state.keys.delete(message.key)
  }
}

const wheelPreparations = new WeakMap<CDPSession, Promise<void>>()

export async function browserWheel(
  cdp: CDPSession,
  message: Extract<BrowserClientMessage, { type: 'wheel' }>
): Promise<void> {
  // The session scheduler bounds outstanding wheel ACKs. Keep coordinate
  // preparation and dispatch ordered, including reversals, even if CDP metrics
  // respond at different speeds; do not serialize on the compositor's input ACK.
  let dispatched: Promise<unknown> | null = null
  const preparation = (wheelPreparations.get(cdp) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const { cssVisualViewport } = await cdp.send('Page.getLayoutMetrics')
      // Trackpad pinch needs the per-event modifiers and exact focal point.
      dispatched = cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: message.x / cssVisualViewport.scale,
        y: message.y / cssVisualViewport.scale,
        deltaX: message.deltaX,
        deltaY: message.deltaY,
        modifiers: message.modifiers
      })
      // Attach a rejection observer immediately; the caller still awaits the
      // original promise and reports errors through the input scheduler.
      void dispatched.catch(() => undefined)
    })
  wheelPreparations.set(cdp, preparation)
  try {
    await preparation
    await dispatched
  } finally {
    if (wheelPreparations.get(cdp) === preparation) {
      wheelPreparations.delete(cdp)
    }
  }
}

export async function browserTouch(
  cdp: CDPSession,
  message: Extract<BrowserClientMessage, { type: 'touch' }>
): Promise<void> {
  // The stream uses viewport pixels; CDP multiplies coordinates by the page's
  // pinch scale. Undo that scale so contacts stay under the viewer's fingers.
  const scale =
    message.points.length > 0
      ? (await cdp.send('Page.getLayoutMetrics')).cssVisualViewport.scale
      : 1
  await cdp.send('Input.dispatchTouchEvent', {
    type:
      message.phase === 'start'
        ? 'touchStart'
        : message.phase === 'move'
          ? 'touchMove'
          : message.phase === 'end'
            ? 'touchEnd'
            : 'touchCancel',
    touchPoints: message.points.map(({ id, x, y }) => ({
      id,
      x: x / scale,
      y: y / scale
    }))
  })
}
