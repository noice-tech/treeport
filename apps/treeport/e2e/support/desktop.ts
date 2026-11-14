import type { Page } from '@playwright/test'

export async function installKeyboardPlatform(page: Page, platform: string) {
  await page.addInitScript((platform) => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: platform
    })
  }, platform)
}

export async function installDesktopBridge(
  page: Page,
  filePaths: Record<string, string>
) {
  await page.addInitScript((filePaths) => {
    const scope = window

    type DesktopCommand =
      | 'new-worktree'
      | 'new-terminal'
      | `split-terminal-${'left' | 'right' | 'up' | 'down'}`
      | 'new-app'
      | 'close-app'
      | 'toggle-apps-panel'
      | 'toggle-full-view'
      | 'focus-location'
      | 'find-in-page'
      | 'select-previous-worktree'
      | 'select-next-worktree'
      | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

    const listeners = new Set<(command: DesktopCommand) => void>()
    scope.__attentionRequests = 0
    scope.__openedDesktopFileUrls = []
    Object.defineProperty(scope, 'treeportDesktop', {
      value: Object.freeze({
        platform: 'darwin',
        onBrowserPermissionPrompt() {
          return () => {}
        },
        openFileUrl(url: string) {
          scope.__openedDesktopFileUrls.push(url)

          return Promise.resolve('opened')
        },
        getPathForFile(file: File) {
          return Promise.resolve(filePaths[file.name] ?? null)
        },
        onCommand(next: (command: DesktopCommand) => void) {
          listeners.add(next)

          return () => listeners.delete(next)
        },
        requestAttention() {
          scope.__attentionRequests += 1
        }
      })
    })
    scope.__dispatchDesktopCommand = (command: DesktopCommand) =>
      listeners.forEach((listener) => listener(command))
  }, filePaths)
}
