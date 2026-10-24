export type DesktopCommand =
  | 'new-worktree'
  | 'new-terminal'
  | `split-terminal-${'left' | 'right' | 'up' | 'down'}`
  | 'new-app'
  | 'close-app'
  | 'toggle-apps-panel'
  | 'focus-location'
  | 'find-in-page'
  | 'reload'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'select-previous-worktree'
  | 'select-next-worktree'
  | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

export type DesktopFileActionResult = 'opened' | 'rejected'

export type TreeportTheme = 'tide' | 'moss'

export interface DesktopBrowserPopup {
  appId: string
  url: string
}

export interface DesktopBrowserPermissions {
  origin: string | null
  decisions: Array<{ capability: string; label: string; allowed: boolean }>
}

export interface DesktopBrowserPermissionPrompt {
  id: string
  appId: string
  origin: string
  capability: string
  destination: string | null
}

export interface DesktopBrowserUnavailable {
  appId: string
  message: string
}

export interface DesktopBrowserBridgeDescriptor {
  endpoint: string
  appId: string
  challenge: string
}

export type DesktopBrowserToolbarCommand =
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'stop' }

export interface DesktopBrowserCommandResult {
  ok: boolean
  error: string | null
}

// This public platform boundary is additive: workspace access must not depend
// on a desktop release. Detect the operations an enhancement actually needs.
export type DesktopBridge = Readonly<
  Partial<{
    runtime: { computerId: string; localBrowser: boolean } | null
    platform: string
    openBrowserDevtools: (appId: string) => Promise<boolean>
    inspectBrowserElement: (
      appId: string,
      backendNodeId: number,
      targetId: string | null
    ) => Promise<boolean>
    openFileUrl: (url: string) => Promise<DesktopFileActionResult>
    getPathForFile: (file: File) => Promise<string | null>
    onLocalFilePaste: (listener: (paths: string[]) => void) => () => void
    onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
    onCommand: (listener: (command: DesktopCommand) => void) => () => void
    zoomPage: (action: 'zoom-in' | 'zoom-out' | 'zoom-reset') => void
    setTerminalSelectionActive: (active: boolean) => void
    onTerminalSelectionRelease: (listener: () => void) => () => void
    registerBrowser: (
      appId: string,
      webContentsId: number,
      challenge: string
    ) => Promise<DesktopBrowserBridgeDescriptor | null>
    browserCommand: (
      appId: string,
      command: DesktopBrowserToolbarCommand
    ) => Promise<DesktopBrowserCommandResult>
    setBrowserInputControl: (appId: string, locked: boolean) => Promise<boolean>
    setBrowserPresentationActive: (
      appId: string,
      active: boolean
    ) => Promise<boolean>
    requestBrowserClose: (appId: string, force: boolean) => Promise<boolean>
    disposeBrowser: (appId: string) => void
    onBrowserFocus: (listener: (appId: string) => void) => () => void
    onBrowserPopup: (
      listener: (popup: DesktopBrowserPopup) => void
    ) => () => void
    browserPermissions: (
      appId: string
    ) => Promise<DesktopBrowserPermissions | null>
    resetBrowserPermissions: (
      appId: string,
      origin: string,
      capability: string | null
    ) => Promise<boolean>
    onBrowserPermissionPrompt: (
      listener: (prompt: DesktopBrowserPermissionPrompt | null) => void
    ) => () => void
    respondBrowserPermission: (id: string, allow: boolean) => void
    onBrowserUnavailable: (
      listener: (failure: DesktopBrowserUnavailable) => void
    ) => () => void
    requestAttention: () => void
    setTheme: (theme: TreeportTheme) => void
  }>
>
