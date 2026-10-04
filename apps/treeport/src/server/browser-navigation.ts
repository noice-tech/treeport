import type { CDPSession, Dialog, Page } from 'playwright'

// Playwright waits for a commit even when beforeunload keeps the current page.
// Race that wait with cancellation; Promise.race also observes the losing
// navigation promise if it later rejects during timeout or browser teardown.
export async function browserNavigation<T>(
  page: Page,
  navigate: () => Promise<T>,
  nativeCdp: CDPSession | null = null
): Promise<T> {
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
    return await Promise.race([navigate(), canceled])
  } finally {
    nativeEvents?.off('Treeport.navigationCanceled', cancel)
    page.off('dialog', onDialog)
  }
}
