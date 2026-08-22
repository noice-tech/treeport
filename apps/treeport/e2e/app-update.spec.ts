import { expect, test } from '@playwright/test'
import type { ApplicationUpdateStatus } from '../src/server/application-update'
import { mockApp } from './app-fixture'

const availableUpdate: ApplicationUpdateStatus = {
  currentVersion: '0.4.0',
  latestVersion: '0.5.0',
  updateAvailable: true,
  checkedAt: '2026-03-20T12:00:00.000Z',
  canUpdate: true,
  blockedReason: null,
  phase: 'idle',
  operationId: null,
  targetVersion: '0.5.0',
  error: null
}

test('updates a local backend and restores the selected workspace', async ({
  page
}) => {
  const pathname = '/projects/proj_1/worktrees/wt_topic/terminals/term_pi'
  const mocked = await mockApp(page, [], {
    applicationUpdate: availableUpdate,
    desktopBridge: true,
    initialPath: pathname
  })

  const updateAvailable = page.getByRole('button', {
    name: 'Treeport 0.5.0 update available'
  })
  await expect(updateAvailable).toBeVisible()
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(updateAvailable).toBeVisible()
  await expect(
    page.getByRole('button', { name: /^Notifications/ })
  ).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 800 })

  await updateAvailable.click()
  const popover = page.getByLabel('Treeport update')
  await expect(
    popover.getByText('Installed 0.4.0 · Available 0.5.0')
  ).toBeVisible()
  await expect(
    popover.getByText(
      'Treeport will restart. Running terminals will stay active.'
    )
  ).toBeVisible()
  await popover.getByRole('button', { name: 'Update Treeport' }).click()
  await expect.poll(mocked.applicationUpdateRequests).toBe(1)
  await expect(popover.getByText('Starting the update…')).toBeVisible()

  mocked.setApplicationUpdate({ ...availableUpdate, phase: 'stage' })
  await expect(popover.getByText('Downloading the update…')).toBeVisible()

  mocked.setApplicationUpdate({
    ...availableUpdate,
    phase: 'failed',
    error: 'npm could not resolve the release.'
  })
  await expect(
    page.getByRole('button', { name: 'Treeport update failed' })
  ).toBeVisible()
  await expect(
    popover.getByText('npm could not resolve the release.')
  ).toBeVisible()

  await popover.getByRole('button', { name: 'Update Treeport' }).click()
  await expect.poll(mocked.applicationUpdateRequests).toBe(2)
  const reloaded = page.waitForEvent('load')
  mocked.setApplicationUpdate({
    ...availableUpdate,
    currentVersion: '0.5.0',
    latestVersion: '0.5.0',
    updateAvailable: false,
    phase: 'complete'
  })
  await reloaded

  await expect(page).toHaveURL(new RegExp(`${pathname}$`))
  await expect(
    page.getByRole('button', { name: /^Notifications/ })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Treeport .*update/ })
  ).toHaveCount(0)
})
