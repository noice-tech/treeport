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
    const style = await target.evaluate((element, { x, y }) => {
      const computed = getComputedStyle(element)
      // Keep the native fallback of custom image cursors, not their URLs.
      let cursor = computed.cursor.split(',').at(-1)!.trim()
      if (cursor === 'auto') {
        // A canvas cannot resolve `auto` from the remote page's text layout.
        // Editable regions also show an I-beam over their empty space.
        const textCursor = computed.writingMode.startsWith('horizontal')
          ? 'text'
          : 'vertical-text'
        cursor = 'default'
        if (element instanceof HTMLElement && element.isContentEditable) {
          cursor = textCursor
        } else if (computed.userSelect !== 'none') {
          const shadowRoots: ShadowRoot[] = []
          let root = element.getRootNode()
          while (root instanceof ShadowRoot) {
            shadowRoots.push(root)
            root = root.host.getRootNode()
          }
          const caret = document.caretPositionFromPoint(x, y, { shadowRoots })
          const node = caret?.offsetNode
          if (
            node?.nodeType === Node.TEXT_NODE &&
            element.contains(node) &&
            node.parentElement &&
            getComputedStyle(node.parentElement).userSelect !== 'none'
          ) {
            // Caret hit testing snaps to nearby text even in padding. Only
            // forward an I-beam when the pointer is on an actual text run.
            const range = document.createRange()
            range.selectNodeContents(node)
            if (
              Array.from(range.getClientRects()).some(
                (rect) =>
                  x >= rect.left &&
                  x < rect.right &&
                  y >= rect.top &&
                  y < rect.bottom
              )
            ) {
              cursor = textCursor
            }
          }
        }
      }

      return {
        cursor,
        borderX: element.clientLeft,
        borderY: element.clientTop,
        width: element instanceof HTMLElement ? element.offsetWidth : 0,
        height: element instanceof HTMLElement ? element.offsetHeight : 0
      }
    }, position)
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
