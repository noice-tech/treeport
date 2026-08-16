type TreeportDesktopCommand =
  | 'new-worktree'
  | 'new-terminal'
  | 'new-panel'
  | 'close-panel'
type TreeportDesktopFileAction = 'opened' | 'rejected'

type TreeportDesktopBridge = Readonly<{
  platform: NodeJS.Platform
  openFileUrl: (url: string) => Promise<TreeportDesktopFileAction>
  getPathForFile?: (file: File) => Promise<string | null>
  onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
  onCommand: (listener: (command: TreeportDesktopCommand) => void) => () => void
  setTerminalSelectionActive: (active: boolean) => void
  onTerminalSelectionRelease: (listener: () => void) => () => void
  requestAttention: () => void
}>

interface Window {
  readonly treeportDesktop?: TreeportDesktopBridge
  /** @deprecated Compatibility alias for desktop shells from before the rename. */
}
