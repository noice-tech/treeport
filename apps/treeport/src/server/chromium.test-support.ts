import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

export async function prepareChromiumCache(root: string): Promise<string> {
  const executable = chromium.executablePath()
  await fs.access(executable, fs.constants.X_OK).catch((cause) => {
    throw new Error(
      `Integration tests require Playwright Chromium at ${executable}. Install it with: pnpm --filter @treeport/treeport exec playwright install chromium`,
      { cause }
    )
  })
  let revision = path.dirname(executable)
  while (!path.basename(revision).startsWith('chromium-')) {
    const parent = path.dirname(revision)
    if (parent === revision) {
      throw new Error(
        `Could not locate the Chromium revision for ${executable}`
      )
    }

    revision = parent
  }

  // Share only the installed binary. Each test writes its own video extension
  // and launch-status profiles, so browser files can run in parallel safely.
  const cache = path.join(root, 'browser-cache')
  await fs.mkdir(cache)
  await fs.symlink(revision, path.join(cache, path.basename(revision)), 'dir')
  return cache
}
