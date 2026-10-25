import type { CDPSession, Dialog, Page } from 'playwright'

// EXTERNAL: Playwright waits for a commit even when beforeunload keeps the current page.
export async function browserNavigation<T>(
  page: Page,
  navigate: () => Promise<T>,
  nativeCdp: CDPSession | null = null,
  errorPresentation: 'throw' | 'page' = 'throw'
): Promise<T | undefined> {
  // SAFETY: Only the verified local Electron bridge is passed as nativeCdp.
  // Its private event is outside Playwright's fixed Chromium protocol table.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- The exact-guest bridge adds a private CDP event.
  const nativeEvents = nativeCdp as unknown as {
    on(event: 'Treeport.navigationCanceled', listener: () => void): void
    off(event: 'Treeport.navigationCanceled', listener: () => void): void
  } | null

  let cancel: () => void = () => undefined

  const canceled = new Promise<never>((_resolve, reject) => {
    cancel = () =>
      reject(
        new Error(
          'Navigation canceled by beforeunload. The current page was preserved.'
        )
      )
  })

  const onDialog = (dialog: Dialog) => {
    if (dialog.type() === 'beforeunload') {
      cancel()
    }
  }

  if (nativeCdp) {
    nativeEvents?.on('Treeport.navigationCanceled', cancel)
  } else {
    page.on('dialog', onDialog)
  }

  try {
    return await Promise.race([navigate(), canceled]).catch(async (cause) => {
      if (
        errorPresentation === 'page' &&
        cause instanceof Error &&
        /\bnet::ERR_(?!ABORTED\b)[A-Z_]+\b/.test(cause.message) &&
        (await page
          .waitForFunction(
            () => location.href === 'chrome-error://chromewebdata/',
            undefined,
            { timeout: 1_000 }
          )
          .then(async (handle) => {
            await handle.dispose()

            return true
          })
          .catch(() => false))
      ) {
        return undefined
      }

      throw cause
    })
  } finally {
    nativeEvents?.off('Treeport.navigationCanceled', cancel)
    page.off('dialog', onDialog)
  }
}
