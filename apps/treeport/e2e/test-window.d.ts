import type { NetworkProductEvent } from '@treeport/shared'

declare global {
  type TreeportTestDesktopCommand =
    | 'new-worktree'
    | 'new-terminal'
    | `split-terminal-${'left' | 'right' | 'up' | 'down'}`
    | 'new-app'
    | 'close-app'
    | 'toggle-side-panel'
    | 'focus-location'
    | 'find-in-page'
    | 'select-previous-worktree'
    | 'select-next-worktree'
    | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

  interface Window {
    __attentionRequests: number
    __dispatchDesktopCommand(command: TreeportTestDesktopCommand): void
    __dispatchDesktopFullscreen(fullscreen: boolean): void
    __dispatchTerminalSelectionRelease(): void
    __eventSource: {
      emit(name: NetworkProductEvent['type'], source: string): void
    }
    __openedDesktopFileUrls: string[]
  }
}
