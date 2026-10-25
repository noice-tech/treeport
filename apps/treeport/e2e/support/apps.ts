import type { Page } from '@playwright/test'

export async function createAppMock(page: Page) {
  await page.route('**/api/worktrees/*/web-app-definitions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { definitions: [] } })

      return
    }

    await route.fallback()
  })
}
