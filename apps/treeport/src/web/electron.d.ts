type TreeportDesktopCommand = 'new-worktree' | 'new-terminal' | 'close-terminal'
type TreeportDesktopFileAction = 'opened' | 'copied' | 'rejected'

type TreeportDesktopBridge = Readonly<{
  platform: NodeJS.Platform
  openFileUrl: (url: string) => Promise<TreeportDesktopFileAction>
  onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
  onCommand: (listener: (command: TreeportDesktopCommand) => void) => () => void
  requestAttention: () => void
}>

interface Window {
  readonly treeportDesktop?: TreeportDesktopBridge
  /** @deprecated Compatibility alias for desktop shells from before the rename. */
}
