import {
  BROWSER_MAX_CLIPBOARD_LENGTH,
  browserClipboardSchema,
  type BrowserClipboard
} from '@treeport/browser-host/clipboard'
import { decodeUnknownOrNull } from '#protocol/schema'
import type { Page } from 'playwright'

export async function installBrowserClipboardBridge(
  page: Page,
  publish: (clipboard: BrowserClipboard) => boolean
): Promise<void> {
  await page.exposeBinding('__treeportClipboardWrite', (_source, value) => {
    const clipboard = decodeUnknownOrNull(browserClipboardSchema, value)

    if (!clipboard || !publish(clipboard)) {
      throw new Error('Take control of this browser before copying.')
    }
  })
  await page.addInitScript(bridgeBrowserClipboard, BROWSER_MAX_CLIPBOARD_LENGTH)
}

// EXTERNAL: Self-contained: Playwright installs this in every document, including frames,
// before website scripts can cache the original clipboard methods.
function bridgeBrowserClipboard(limit: number): void {
  const publish = (clipboard: BrowserClipboard): Promise<void> => {
    if (
      clipboard.text === null &&
      clipboard.html === null &&
      clipboard.png === null
    ) {
      return Promise.resolve()
    }

    if (
      (clipboard.text?.length ?? 0) +
        (clipboard.html?.length ?? 0) +
        (clipboard.png?.length ?? 0) >
      limit
    ) {
      return Promise.reject(new Error('The copied content is too large.'))
    }

    // SAFETY: exposeBinding installs this page-scoped function before init scripts.
    return (
      window as typeof window & {
        __treeportClipboardWrite(value: BrowserClipboard): Promise<void>
      }
    ).__treeportClipboardWrite(clipboard)
  }

  const clipboard = navigator.clipboard

  if (clipboard) {
    const writeText = clipboard.writeText.bind(clipboard)
    clipboard.writeText = async (text) => {
      const value = String(text)
      await writeText(value)
      await publish({ text: value, html: null, png: null })
    }

    const write = clipboard.write.bind(clipboard)
    clipboard.write = async (items) => {
      let value: BrowserClipboard = { text: null, html: null, png: null }
      const item = items[0]

      if (item) {
        for (const type of item.types) {
          if (!['text/plain', 'text/html', 'image/png'].includes(type)) {
            continue
          }

          const blob = await item.getType(type)

          if (
            blob.size > limit ||
            (type === 'image/png' && (blob.size * 4) / 3 > limit)
          ) {
            throw new Error('The copied content is too large.')
          }

          if (type === 'text/plain') {
            value = { ...value, text: await blob.text() }
          } else if (type === 'text/html') {
            value = { ...value, html: await blob.text() }
          } else {
            const bytes = new Uint8Array(await blob.arrayBuffer())
            let binary = ''

            for (let offset = 0; offset < bytes.length; offset += 16_384) {
              binary += String.fromCharCode(
                ...bytes.subarray(offset, offset + 16_384)
              )
            }

            value = { ...value, png: btoa(binary) }
          }
        }
      }

      await write(items)

      if (value.text !== null || value.html !== null || value.png !== null) {
        await publish(value)
      }
    }
  }

  const execCommand = document.execCommand.bind(document)
  document.execCommand = (command, showUI, argument) => {
    if (command.toLowerCase() !== 'copy') {
      return execCommand(command, showUI, argument)
    }

    let active = document.activeElement

    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement
    }

    if (active instanceof HTMLInputElement && active.type === 'password') {
      return execCommand(command, showUI, argument)
    }

    let value: BrowserClipboard | null = null

    // EXTERNAL: Register at invocation time, after the website's copy handlers. Read the
    // DataTransfer during dispatch: Chromium empties it as soon as copy returns.
    const observe = (event: ClipboardEvent) => {
      if (!event.isTrusted) {
        return
      }

      if (event.defaultPrevented) {
        const data = event.clipboardData
        value = {
          text: data?.types.includes('text/plain')
            ? data.getData('text/plain')
            : null,
          html: data?.types.includes('text/html')
            ? data.getData('text/html')
            : null,
          png: null
        }
      } else if (
        (active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement) &&
        active.selectionStart !== null &&
        active.selectionEnd !== null
      ) {
        value = {
          text: active.value.slice(active.selectionStart, active.selectionEnd),
          html: null,
          png: null
        }
      } else {
        const selection = window.getSelection()

        if (selection && !selection.isCollapsed) {
          const container = document.createElement('div')

          for (let index = 0; index < selection.rangeCount; index++) {
            container.append(selection.getRangeAt(index).cloneContents())
          }

          value = {
            text: selection.toString(),
            html: container.innerHTML,
            png: null
          }
        }
      }
    }

    window.addEventListener('copy', observe)

    try {
      const copied = execCommand(command, showUI, argument)

      // EXTERNAL: The native boolean return must stay synchronous for legacy copy libraries.
      if (copied && value !== null) {
        void publish(value).catch(() => undefined)
      }

      return copied
    } finally {
      window.removeEventListener('copy', observe)
    }
  }
}
