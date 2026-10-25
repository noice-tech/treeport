import {
  BROWSER_MAX_CLIPBOARD_LENGTH,
  browserClipboardSchema,
  copyBrowserPage,
  decodeUnknownOrNull,
  type BrowserClipboard
} from '@treeport/shared'
import type { CDPSession, Page } from 'playwright'

export interface BrowserClipboardReader {
  readonly page: Pick<Page, 'setContent' | 'evaluateHandle'>
  readonly cdp: CDPSession
}

export async function browserClipboard(
  page: Page,
  withReader: (
    read: (reader: BrowserClipboardReader) => Promise<BrowserClipboard>
  ) => Promise<BrowserClipboard>
): Promise<BrowserClipboard | null> {
  let copied = false

  // Cross-origin frames can live in separate renderer targets. Same-process
  // frames share a target and are traversed by copyBrowserPage itself.
  for (const frame of page.frames()) {
    const source = await page.context().newCDPSession(frame)

    const result = await copyBrowserPage(source).finally(() =>
      source.detach().catch(() => undefined)
    )

    if (result !== null) {
      copied = result
      break
    }
  }

  if (!copied) {
    return null
  }

  return withReader(async ({ page: reader, cdp }) => {
    await reader.setContent('<body contenteditable="true"></body>')

    const result = await reader.evaluateHandle(
      (limit) => ({
        read: new Promise<BrowserClipboard>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Clipboard read timed out.')),
            5_000
          )

          document.addEventListener(
            'paste',
            (event) => {
              event.preventDefault()
              clearTimeout(timer)
              const data = event.clipboardData
              const text = data?.getData('text/plain') || null
              const html = data?.getData('text/html') || null

              const image = Array.from(data?.files ?? []).find(
                (file) => file.type === 'image/png'
              )

              if (
                (text?.length ?? 0) +
                  (html?.length ?? 0) +
                  ((image?.size ?? 0) * 4) / 3 >
                limit
              ) {
                reject(
                  new Error(
                    'The copied content is too large. Select a smaller portion.'
                  )
                )

                return
              }

              if (!image) {
                resolve({ text, html, png: null })

                return
              }

              const file = new FileReader()
              file.onerror = () =>
                reject(new Error('Could not read the copied image.'))
              file.onload = () => {
                const encoded = String(file.result)
                resolve({
                  text,
                  html,
                  png: encoded.slice(encoded.indexOf(',') + 1)
                })
              }

              file.readAsDataURL(image)
            },
            { once: true }
          )
          document.body.focus()
        })
      }),
      BROWSER_MAX_CLIPBOARD_LENGTH
    )

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'v',
      code: 'KeyV',
      commands: ['Paste']
    })

    const clipboard = decodeUnknownOrNull(
      browserClipboardSchema,
      await result.evaluate((state) => state.read)
    )

    if (!clipboard) {
      throw new Error('The copied content is too large or unsupported.')
    }

    return clipboard
  })
}
