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
      | 'new-panel'
      | 'close-panel'
      | 'toggle-side-panel'
      | 'focus-location'
      | 'find-in-page'
      | 'select-previous-worktree'
      | 'select-next-worktree'
      | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
    const listeners = new Set<(command: DesktopCommand) => void>()
    const terminalSelectionReleaseListeners = new Set<() => void>()
    let fullscreenListener: ((fullscreen: boolean) => void) | null = null
    scope.__attentionRequests = 0
    scope.__openedDesktopFileUrls = []
    scope.treeportDesktop = Object.freeze({
      platform: 'darwin',
      openFileUrl(url: string) {
        scope.__openedDesktopFileUrls.push(url)
        return Promise.resolve(true)
      },
      getPathForFile(file: File) {
        return Promise.resolve(filePaths[file.name] ?? null)
      },
      onFullscreenChange(next: (fullscreen: boolean) => void) {
        fullscreenListener = next
        return () => {
          if (fullscreenListener === next) {
            fullscreenListener = null
          }
        }
      },
      onCommand(next: (command: DesktopCommand) => void) {
        listeners.add(next)
        return () => listeners.delete(next)
      },
      setTerminalSelectionActive() {},
      onTerminalSelectionRelease(next: () => void) {
        terminalSelectionReleaseListeners.add(next)
        return () => terminalSelectionReleaseListeners.delete(next)
      },
      requestAttention() {
        scope.__attentionRequests += 1
      }
    })
    scope.__dispatchDesktopCommand = (command: DesktopCommand) =>
      listeners.forEach((listener) => listener(command))
    scope.__dispatchTerminalSelectionRelease = () =>
      terminalSelectionReleaseListeners.forEach((listener) => listener())
    scope.__dispatchDesktopFullscreen = (fullscreen: boolean) =>
      fullscreenListener?.(fullscreen)
  }, filePaths)
}
