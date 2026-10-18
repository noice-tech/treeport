import type { Page } from '@playwright/test'

export async function createPanelMock(page: Page) {
  await page.route(
    '**/api/worktrees/*/web-panel-definitions',
    async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { definitions: [] } })
        return
      }

      await route.fallback()
    }
  )
}
