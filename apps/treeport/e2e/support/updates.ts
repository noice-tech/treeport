import type { Page } from '@playwright/test'
import type { ApplicationUpdateStatus } from '../../src/server/application-update'
import type { MockAppOptions } from './types'

export async function createUpdateMock(page: Page, options: MockAppOptions) {
  let applicationUpdate: ApplicationUpdateStatus =
    options.applicationUpdate ?? {
      currentVersion: '0.4.0',
      latestVersion: null,
      updateAvailable: false,
      checkedAt: '2026-03-20T12:00:00.000Z',
      canUpdate: false,
      blockedReason: null,
      phase: 'idle',
      operationId: null,
      targetVersion: null,
      error: null
    }
  let applicationUpdateRequests = 0

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/update') {
      if (route.request().method() === 'POST') {
        applicationUpdateRequests += 1
        applicationUpdate = { ...applicationUpdate, phase: 'starting' }
        await route.fulfill({ status: 202, json: applicationUpdate })
        return
      }

      await route.fulfill({ json: applicationUpdate })
      return
    }

    await route.fallback()
  })

  return {
    applicationUpdateRequests: () => applicationUpdateRequests,
    setApplicationUpdate: (status: ApplicationUpdateStatus) => {
      applicationUpdate = status
    }
  }
}
