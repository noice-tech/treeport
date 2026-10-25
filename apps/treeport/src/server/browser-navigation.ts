import type { CDPSession, Dialog, Page } from 'playwright'

// Playwright waits for a commit even when beforeunload keeps the current page.
// Race that wait with cancellation; Promise.race also observes the losing
// navigation promise if it later rejects during timeout or browser teardown.
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

  // Hosted pages dismiss beforeunload. Local Electron pages retain native
  // ownership and report the actual native result through the exact-guest CDP.
  if (nativeCdp) {
    nativeEvents?.on('Treeport.navigationCanceled', cancel)
  } else {
    page.on('dialog', onDialog)
  }

  try {
    return await Promise.race([navigate(), canceled]).catch(async (cause) => {
      // Only interactive navigation may rely on Chromium's visible error page.
      // Automation must still receive the failure, and transport/timeouts must
      // not disappear just because an earlier navigation left an error page.
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
