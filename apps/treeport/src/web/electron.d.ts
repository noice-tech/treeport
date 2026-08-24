type TreeportDesktopCommand =
  | 'new-worktree'
  | 'new-terminal'
  | 'new-panel'
  | 'close-panel'
type TreeportDesktopFileAction = 'opened' | 'rejected'

type TreeportDesktopBrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

type TreeportDesktopBrowserState = {
  panelId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

type TreeportDesktopBrowserCommand =
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'stop' }

type TreeportDesktopBridge = Readonly<{
  platform: NodeJS.Platform
  openFileUrl: (url: string) => Promise<TreeportDesktopFileAction>
  getPathForFile?: (file: File) => Promise<string | null>
  onLocalFilePaste?: (listener: (paths: string[]) => void) => () => void
  onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
  onCommand: (listener: (command: TreeportDesktopCommand) => void) => () => void
  setTerminalSelectionActive: (active: boolean) => void
  onTerminalSelectionRelease: (listener: () => void) => () => void
  openBrowser: (
    panelId: string,
    url: string
  ) => Promise<TreeportDesktopBrowserState | null>
  setBrowserBounds: (
    panelId: string,
    bounds: TreeportDesktopBrowserBounds
  ) => void
  setBrowserVisible: (panelId: string, visible: boolean) => void
  sendBrowserCommand: (
    panelId: string,
    command: TreeportDesktopBrowserCommand
  ) => void
  resetBrowser: (panelId: string) => Promise<TreeportDesktopBrowserState | null>
  requestBrowserClose: (panelId: string, force: boolean) => Promise<boolean>
  disposeBrowser: (panelId: string) => void
  onBrowserState: (
    listener: (state: TreeportDesktopBrowserState) => void
  ) => () => void
  onBrowserPopup: (
    listener: (popup: { panelId: string; url: string }) => void
  ) => () => void
  requestAttention: () => void
}>

interface Window {
  readonly treeportDesktop?: TreeportDesktopBridge
  /** @deprecated Compatibility alias for desktop shells from before the rename. */
}
