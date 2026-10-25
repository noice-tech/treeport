import type { BrowserClipboard } from '@treeport/shared'

export async function writeBrowserClipboard(
  value: BrowserClipboard
): Promise<void> {
  const formats: Record<string, Blob> = {}

  if (value.text !== null) {
    formats['text/plain'] = new Blob([value.text], { type: 'text/plain' })
  }

  if (value.html !== null) {
    formats['text/html'] = new Blob([value.html], { type: 'text/html' })
  }

  if (value.png !== null) {
    const bytes = Uint8Array.from(atob(value.png), (character) =>
      character.charCodeAt(0)
    )

    formats['image/png'] = new Blob([bytes], { type: 'image/png' })
  }

  if (Object.keys(formats).length === 0) {
    throw new Error('The browser did not copy a supported format.')
  }

  const nativeCopy = () => {
    if (value.png !== null) {
      throw new Error(
        'Allow clipboard access, then click Copy to clipboard to copy the image.'
      )
    }

    const previous = document.activeElement
    const buffer = document.createElement('textarea')
    buffer.value = value.text || ' '
    buffer.style.position = 'fixed'
    buffer.style.left = '-9999px'

    const copy = (event: ClipboardEvent) => {
      event.preventDefault()

      if (value.text !== null) {
        event.clipboardData?.setData('text/plain', value.text)
      }

      if (value.html !== null) {
        event.clipboardData?.setData('text/html', value.html)
      }
    }

    buffer.addEventListener('copy', copy)
    document.body.append(buffer)
    buffer.focus({ preventScroll: true })
    buffer.select()
    const copied = document.execCommand('copy')
    buffer.remove()

    if (previous instanceof HTMLElement) {
      previous.focus({ preventScroll: true })
    }

    if (!copied) {
      throw new Error(
        'Click Copy to clipboard to finish. If it is still denied, allow clipboard access for Treeport.'
      )
    }
  }

  // eslint-disable-next-line anti-slop/no-runtime-typeof -- ClipboardItem availability is a browser capability, not a protocol shape check.
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    return navigator.clipboard
      .write([new ClipboardItem(formats)])
      .catch(nativeCopy)
  }

  nativeCopy()
}
