import { expect, type Page } from '@playwright/test'

export async function openWorktreeContextMenu(
  page: Page,
  worktreeName: string
) {
  await page
    .getByRole('button', { name: new RegExp(`^${worktreeName}(?:,|\\s|$)`) })
    .click({ button: 'right' })
  return page.getByRole('menu')
}

export async function waitForTerminalControl(page: Page) {
  const terminal = page.getByRole('main', { name: /terminal workspace$/ })
  await expect(terminal).toBeVisible()
  await expect(terminal.getByText('Viewing', { exact: true })).toBeHidden()
  await expect(
    terminal.getByText('Taking control…', { exact: true })
  ).toBeHidden()
}

export async function requestTerminalControl(page: Page) {
  await page.locator('.xterm-screen').click({ position: { x: 4, y: 4 } })
  await waitForTerminalControl(page)
}
