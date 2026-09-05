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
  await expect
    .poll(() =>
      page.evaluate(() => {
        const terminalId = location.pathname.split('/').at(-1)
        const socket = [...(window.__wsInstances ?? [])]
          .reverse()
          .find(
            (candidate: any) =>
              candidate.namespace === '/terminals' &&
              candidate.terminalId === terminalId
          )
        const state = terminalId
          ? JSON.parse(
              localStorage.getItem(
                `__treeport_terminal_state__:${terminalId}`
              ) || '{}'
            )
          : null
        return Boolean(socket && state?.controllerClientId === socket.clientId)
      })
    )
    .toBe(true)
}

export async function requestTerminalControl(page: Page) {
  await page.locator('.xterm-screen').click({ position: { x: 4, y: 4 } })
  await waitForTerminalControl(page)
}
