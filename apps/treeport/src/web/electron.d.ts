type TreeportDesktopCommand =
  | 'new-worktree'
  | 'new-terminal'
  | `split-terminal-${'left' | 'right' | 'up' | 'down'}`
  | 'new-tab'
  | 'close-tab'
  | 'toggle-side-panel'
  | 'focus-location'
  | 'find-in-page'
  | 'reload'
  | 'select-previous-worktree'
  | 'select-next-worktree'
  | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
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
  findInPage(
    text: string,
    options?: { forward?: boolean; findNext?: boolean }
  ): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection'): void
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
    tabId: string,
    webContentsId: number,
    challenge: string
  ) => Promise<{
    endpoint: string
    tabId: string
    challenge: string
  } | null>
  browserCommand: (
    tabId: string,
    command:
      | { type: 'navigate'; url: string }
      | { type: 'back' }
      | { type: 'forward' }
      | { type: 'reload' }
      | { type: 'stop' }
  ) => Promise<{ ok: boolean; error: string | null }>
  setBrowserInputControl: (tabId: string, locked: boolean) => Promise<boolean>
  setBrowserPresentationActive: (
    tabId: string,
    active: boolean
  ) => Promise<boolean>
  requestBrowserClose: (tabId: string, force: boolean) => Promise<boolean>
  disposeBrowser: (tabId: string) => void
  onBrowserFocus: (listener: (tabId: string) => void) => () => void
  onBrowserPopup: (
    listener: (popup: { tabId: string; url: string }) => void
  ) => () => void
  onBrowserUnavailable: (
    listener: (failure: { tabId: string; message: string }) => void
  ) => () => void
  requestAttention: () => void
}>

interface Window {
  readonly treeportDesktop?: TreeportDesktopBridge
}
