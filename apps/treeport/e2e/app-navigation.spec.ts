import { expect, test } from '@playwright/test'
import { mockApp } from './support/mock-app'

test.describe('desktop worktree terminal UI', () => {
  test('navigates and persists a desktop workspace', async ({ page }) => {
    await mockApp(page, [], { includeSecondProject: true })
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project example'
      })
    ).toBeVisible()
    await expect(page.getByText('topic', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: /^(main tree|topic)$/ })
    ).toHaveText(['main tree', 'topic'])

    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect(page.locator('.xterm-rows')).toContainText(
      'same persistent terminal session'
    )
    await expect(
      page
        .getByRole('button', {
          name: 'zsh · /worktrees/topic, running',
          exact: true
        })
        .last()
    ).toBeVisible()
    const shortcutModifier = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Meta' : 'Control'
    )
    await page.keyboard.press(`${shortcutModifier}+Shift+P`)
    const search = page.getByLabel('Search projects')
    await expect(search).toBeFocused()
    await search.fill('missing')
    await expect(page.getByText('No open projects found.')).toBeVisible()
    await search.fill('example')
    await expect(
      page.getByRole('button', { name: 'example', exact: true })
    ).toBeVisible()

    await page.locator('.xterm-screen').click()
    await expect(search).toHaveCount(0)
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    const switcher = page.getByRole('button', {
      name: 'Switch project, current project example'
    })
    await expect(page.getByText('topic', { exact: true })).toBeVisible()

    await switcher.click()
    const projectSearch = page.getByLabel('Search projects')
    await projectSearch.fill('another')
    await projectSearch.press('Enter')

    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
    await expect(page.getByText('topic', { exact: true })).toHaveCount(0)
    await expect(page.getByText('another topic', { exact: true })).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page
      .getByRole('button', {
        name: 'Switch project, current project another-project'
      })
      .click()
    await expect(page.getByLabel('Search projects')).toHaveValue('')

    await page.reload()
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
    await expect(page.getByText('another topic', { exact: true })).toBeVisible()

    await page
      .getByRole('button', {
        name: 'Switch project, current project another-project'
      })
      .click()
    await page.getByRole('button', { name: 'example', exact: true }).click()
    await expect(page.getByText('topic', { exact: true })).toBeVisible()
    await expect(page.locator('.xterm-rows')).toContainText(
      'same persistent terminal session'
    )
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    await page
      .getByRole('button', {
        name: 'Switch project, current project example'
      })
      .click()
    const projectOption = page
      .getByRole('listitem')
      .filter({ hasText: 'example' })
    await projectOption.hover()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Close project example' }).click()
    await expect(
      page.getByRole('button', {
        name: 'Switch project, current project another-project'
      })
    ).toBeVisible()
  })
})
