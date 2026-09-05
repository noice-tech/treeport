import { expect, test } from '@playwright/test'
import type { PresenceUpdate, WorkspacePresence } from '@treeport/shared'
import { project } from './support/project'

// Mount the real presence hook and UI without terminal/browser-host processes.
// The HTTP and event-stream boundaries have real-network server coverage.
test('shows other people, groups their tabs, reports focus, and clears disconnected presence', async ({
  page
}) => {
  const alice = {
    source: 'tailscale' as const,
    login: 'alice@example.test',
    name: 'Alice',
    profilePicture: null
  }
  const bob = { ...alice, login: 'bob@example.test', name: 'Bob' }
  const worktree = {
    ...project.worktrees[0]!,
    panels: [
      { id: 'panel_pi', title: 'Pi' },
      { id: 'panel_review', title: 'Review' }
    ]
  }
  const updates: PresenceUpdate[] = []
  let failUpdates = false
  await page.route('**/api/presence', async (route) => {
    updates.push(route.request().postDataJSON())
    await route.fulfill({
      status: failUpdates ? 503 : 200,
      json: failUpdates
        ? { error: { message: 'Disconnected' } }
        : { identity: alice }
    })
  })
  await page.goto('/e2e/support/presence-harness.html')
  await page.bringToFront()
  await expect
    .poll(() => updates.at(-1))
    .toMatchObject({
      worktreeId: worktree.id,
      focusedPanelId: 'panel_pi',
      visible: true,
      focused: true
    })
  const people = page.getByRole('button', {
    name: /^People in this workspace:/
  })
  if (process.env.VITE_TREEPORT_MOCK_PRESENCE === '1') {
    await expect(people).toHaveText('Bob (demo) is here')
    await people.click()
    await expect(page.getByText('Pi · focused', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page
      .getByRole('button', { name: 'Focus Review', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Open topic workspace', exact: true })
      .click()
    await expect.poll(() => updates.at(-1)?.worktreeId).toBe('wt_topic')
    await expect(people).toHaveText('Bob (demo) is here')
    await people.click()
    await expect(
      page.getByText('Review · focused', { exact: true })
    ).toBeVisible()
    // The fixture must not add an identity or a second session to HTTP traffic.
    expect(new Set(updates.map((update) => update.sessionId)).size).toBe(1)
    for (const update of updates) {
      expect(update).not.toHaveProperty('identity')
      expect(update.sessionId).not.toBe('00000000-0000-4000-8000-000000000001')
    }
    return
  }

  await expect(people).toHaveCount(0)
  const self: WorkspacePresence = {
    identity: alice,
    sessionId: '11111111-1111-4111-8111-111111111111',
    worktreeId: worktree.id,
    focusedPanelId: 'panel_pi',
    visible: true,
    focused: true
  }
  const bobTab = {
    ...self,
    identity: bob,
    sessionId: '22222222-2222-4222-8222-222222222222'
  }
  await page.evaluate(
    (viewers) =>
      window.dispatchEvent(
        new CustomEvent('test-presence', { detail: viewers })
      ),
    [self]
  )
  await expect(people).toHaveCount(0)
  await page.evaluate(
    (viewers) =>
      window.dispatchEvent(
        new CustomEvent('test-presence', { detail: viewers })
      ),
    [
      self,
      bobTab,
      {
        ...bobTab,
        sessionId: '33333333-3333-4333-8333-333333333333',
        focusedPanelId: 'panel_review'
      }
    ]
  )
  await expect(people).toHaveText('Bob is here')
  await people.click()
  await expect(page.getByText('Pi · focused', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Review · focused', { exact: true })
  ).toBeVisible()
  await expect(page.getByText('Bob', { exact: true })).toHaveCount(1)

  await page.evaluate(
    (viewers) =>
      window.dispatchEvent(
        new CustomEvent('test-presence', { detail: viewers })
      ),
    [{ ...bobTab, visible: false, focused: false, focusedPanelId: null }]
  )
  await expect(
    page.getByText('Open in background', { exact: true })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Focus Review', exact: true }).click()
  await expect.poll(() => updates.at(-1)?.focusedPanelId).toBe('panel_review')
  // Headless Chrome keeps all pages focused. Supply the native browser signal
  // at this boundary, then verify the actual HTTP update from the hook.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => false
    })
    window.dispatchEvent(new Event('blur'))
  })
  await expect
    .poll(() => updates.at(-1))
    .toMatchObject({ focused: false, focusedPanelId: null })
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hasFocus')
    window.dispatchEvent(new Event('focus'))
  })
  await expect
    .poll(() => updates.at(-1))
    .toMatchObject({ focused: true, focusedPanelId: 'panel_review' })
  await page
    .getByRole('button', { name: 'Open topic workspace', exact: true })
    .click()
  await expect.poll(() => updates.at(-1)?.worktreeId).toBe('wt_topic')
  await expect(people).toHaveCount(0)

  await page.evaluate(
    (viewers) =>
      window.dispatchEvent(
        new CustomEvent('test-presence', { detail: viewers })
      ),
    [{ ...bobTab, worktreeId: 'wt_topic' }]
  )
  await expect(people).toHaveText('Bob is here')
  failUpdates = true
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(people).toHaveCount(0)
  failUpdates = false
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(people).toHaveText('Bob is here')
})
