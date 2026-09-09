import type { Frame, JSHandle, Page } from 'playwright'
import { browserCursorSchema, decodeUnknownOrNull } from '@treeport/shared'

export async function browserCursor(
  page: Page,
  point: { x: number; y: number }
) {
  let frame: Frame | null = page.mainFrame()
  let position = point
  while (frame) {
    const handle: JSHandle<Element | null> = await frame.evaluateHandle(
      ({ x, y }) => {
        let element = document.elementFromPoint(x, y)
        while (element?.shadowRoot) {
          const child = element.shadowRoot.elementFromPoint(x, y)
          if (!child || child === element) {
            break
          }

          element = child
        }
        return element
      },
      position
    )
    const target = handle.asElement()
    if (!target) {
      await handle.dispose()
      return 'default' as const
    }

    const child: Frame | null = await target.contentFrame()
    const style = await target.evaluate((element) => ({
      // Keep the native fallback of custom image cursors, not their URLs.
      cursor: getComputedStyle(element).cursor.split(',').at(-1)!.trim(),
      borderX: element.clientLeft,
      borderY: element.clientTop,
      width: element instanceof HTMLElement ? element.offsetWidth : 0,
      height: element instanceof HTMLElement ? element.offsetHeight : 0
    }))
    const bounds = child ? await target.boundingBox() : null
    await handle.dispose()
    if (!child || !bounds || !bounds.width || !bounds.height) {
      return decodeUnknownOrNull(browserCursorSchema, style.cursor) ?? 'default'
    }

    // Playwright bounds are in top-level viewport coordinates, including scale.
    position = {
      x: ((point.x - bounds.x) * style.width) / bounds.width - style.borderX,
      y: ((point.y - bounds.y) * style.height) / bounds.height - style.borderY
    }
    frame = child
  }

  return 'default' as const
}
