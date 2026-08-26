type TreeportDesktopCommand =
  | 'new-worktree'
  | 'new-terminal'
  | 'new-panel'
  | 'close-panel'
  | 'focus-location'
type TreeportDesktopFileAction = 'opened' | 'rejected'

interface TreeportBrowserWebview extends HTMLElement {
  src: string
  getWebContentsId(): number
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  canGoBack(): boolean
  canGoForward(): boolean
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
}

type TreeportDesktopBridge = Readonly<{
  platform: NodeJS.Platform
  openFileUrl: (url: string) => Promise<TreeportDesktopFileAction>
  getPathForFile?: (file: File) => Promise<string | null>
  onLocalFilePaste?: (listener: (paths: string[]) => void) => () => void
  onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
  onCommand: (listener: (command: TreeportDesktopCommand) => void) => () => void
  setTerminalSelectionActive: (active: boolean) => void
  onTerminalSelectionRelease: (listener: () => void) => () => void
  registerBrowser: (
    panelId: string,
    webContentsId: number,
    challenge: string
  ) => Promise<{
    endpoint: string
    panelId: string
    challenge: string
  } | null>
  browserCommand: (
    panelId: string,
    command:
      | { type: 'navigate'; url: string }
      | { type: 'back' }
      | { type: 'forward' }
      | { type: 'reload' }
      | { type: 'stop' }
  ) => Promise<{ ok: boolean; error: string | null }>
  setBrowserAgentControl: (panelId: string, locked: boolean) => Promise<boolean>
  requestBrowserClose: (panelId: string, force: boolean) => Promise<boolean>
  disposeBrowser: (panelId: string) => void
  onBrowserPopup: (
    listener: (popup: { panelId: string; url: string }) => void
  ) => () => void
  requestAttention: () => void
}>

interface Window {
  readonly treeportDesktop?: TreeportDesktopBridge
}
