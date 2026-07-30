type TreeportDesktopCommand =
  | 'new-worktree'
  | 'new-terminal'
  | 'new-terminal-menu'
  | 'close-terminal'

type TreeportDesktopBridge = Readonly<{
  platform: NodeJS.Platform
  openFileUrl: (url: string) => Promise<boolean>
  onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
  onCommand: (listener: (command: TreeportDesktopCommand) => void) => () => void
  requestAttention: () => void
}>

interface Window {
  readonly treeportDesktop?: TreeportDesktopBridge
  /** @deprecated Compatibility alias for desktop shells from before the rename. */
}
