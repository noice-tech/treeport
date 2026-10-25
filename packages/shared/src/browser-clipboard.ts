import * as Schema from 'effect/Schema'

export const BROWSER_MAX_CLIPBOARD_LENGTH = 8 * 1024 * 1024

export const browserClipboardSchema = Schema.Struct({
  text: Schema.NullOr(Schema.String),
  html: Schema.NullOr(Schema.String),
  png: Schema.NullOr(
    Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/))
  )
}).pipe(
  Schema.filter(
    ({ text, html, png }) =>
      (text?.length ?? 0) + (html?.length ?? 0) + (png?.length ?? 0) <=
      BROWSER_MAX_CLIPBOARD_LENGTH
  )
)

export type BrowserClipboard = Schema.Schema.Type<typeof browserClipboardSchema>

/* eslint-disable anti-slop/no-unknown-returns -- CDP returns external JSON; copyBrowserPage decodes every response before use. */
interface BrowserClipboardCdp {
  send(method: 'Page.getFrameTree'): Promise<unknown>
  send(
    method: 'Page.createIsolatedWorld',
    params: { frameId: string; worldName: string }
  ): Promise<unknown>
  send(
    method: 'Runtime.callFunctionOn',
    params: {
      functionDeclaration: string
      executionContextId: number
      returnByValue: boolean
      userGesture: boolean
    }
  ): Promise<unknown>
}

/* eslint-enable anti-slop/no-unknown-returns */

export async function copyBrowserPage(
  cdp: BrowserClipboardCdp
): Promise<boolean | null> {
  const tree = Schema.decodeUnknownSync(
    Schema.Struct({ frameTree: Schema.Unknown })
  )(await cdp.send('Page.getFrameTree'))

  const frames = [tree.frameTree]

  for (const value of frames) {
    const frame = Schema.decodeUnknownSync(
      Schema.Struct({
        frame: Schema.Struct({ id: Schema.String }),
        childFrames: Schema.optional(Schema.Array(Schema.Unknown))
      })
    )(value)

    const world = Schema.decodeUnknownSync(
      Schema.Struct({ executionContextId: Schema.Number })
    )(
      await cdp.send('Page.createIsolatedWorld', {
        frameId: frame.frame.id,
        worldName: 'treeport-clipboard'
      })
    )

    const response = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          value: Schema.optional(Schema.NullOr(Schema.Boolean))
        }),
        exceptionDetails: Schema.optional(Schema.Unknown)
      })
    )(
      await cdp.send('Runtime.callFunctionOn', {
        functionDeclaration: copyBrowserSelection.toString(),
        executionContextId: world.executionContextId,
        returnByValue: true,
        userGesture: true
      })
    )

    if (response.exceptionDetails !== undefined) {
      throw new Error('The browser could not copy the selection.')
    }

    if (response.result.value !== null) {
      return response.result.value === true
    }

    frames.push(...(frame.childFrames ?? []))
  }

  return null
}

// Self-contained: runs in a private isolated world so websites cannot replace
// DOM APIs and trick this operation into exporting the host's old clipboard.
// Never read the native clipboard unless this command actually copied content;
// a password, empty selection, or cancelled copy must not export old host data.
function copyBrowserSelection(): boolean | null {
  if (!document.hasFocus()) {
    return null
  }

  let active = document.activeElement

  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement
  }

  if (
    active instanceof HTMLIFrameElement ||
    active instanceof HTMLFrameElement
  ) {
    return null
  }

  if (active instanceof HTMLInputElement && active.type === 'password') {
    return false
  }

  // Ask Chromium instead of inspecting DOM ranges: inputs such as email and
  // selections inside shadow roots need the browser's native selection logic.
  const hasSelection = document.queryCommandEnabled('copy')
  let copied = false

  const observe = (event: ClipboardEvent) => {
    if (!event.isTrusted) {
      return
    }

    // Runs after the page's copy handlers, so custom content takes precedence.
    copied = event.defaultPrevented
      ? (event.clipboardData?.types.length ?? 0) > 0
      : hasSelection
  }

  window.addEventListener('copy', observe)

  try {
    return document.execCommand('copy') && copied
  } finally {
    window.removeEventListener('copy', observe)
  }
}
