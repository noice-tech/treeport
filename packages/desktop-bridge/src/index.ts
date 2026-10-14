export type DesktopCommand =
  | 'new-worktree'
  | 'new-terminal'
  | `split-terminal-${'left' | 'right' | 'up' | 'down'}`
  | 'new-panel'
  | 'close-panel'
  | 'toggle-side-panel'
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

export interface DesktopBrowserPopup {
  panelId: string
  url: string
}

export interface DesktopBrowserPermissions {
  origin: string | null
  decisions: Array<{ capability: string; label: string; allowed: boolean }>
}

export interface DesktopBrowserPermissionPrompt {
  id: string
  panelId: string
  origin: string
  capability: string
  destination: string | null
}

export interface DesktopBrowserUnavailable {
  panelId: string
  message: string
}

export interface DesktopBrowserBridgeDescriptor {
  endpoint: string
  panelId: string
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
    openBrowserDevtools: (panelId: string) => Promise<boolean>
    openFileUrl: (url: string) => Promise<DesktopFileActionResult>
    getPathForFile: (file: File) => Promise<string | null>
    onLocalFilePaste: (listener: (paths: string[]) => void) => () => void
    onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
    onCommand: (listener: (command: DesktopCommand) => void) => () => void
    zoomPage: (action: 'zoom-in' | 'zoom-out' | 'zoom-reset') => void
    setTerminalSelectionActive: (active: boolean) => void
    onTerminalSelectionRelease: (listener: () => void) => () => void
    registerBrowser: (
      panelId: string,
      webContentsId: number,
      challenge: string
    ) => Promise<DesktopBrowserBridgeDescriptor | null>
    browserCommand: (
      panelId: string,
      command: DesktopBrowserToolbarCommand
    ) => Promise<DesktopBrowserCommandResult>
    setBrowserInputControl: (
      panelId: string,
      locked: boolean
    ) => Promise<boolean>
    setBrowserPresentationActive: (
      panelId: string,
      active: boolean
    ) => Promise<boolean>
    requestBrowserClose: (panelId: string, force: boolean) => Promise<boolean>
    disposeBrowser: (panelId: string) => void
    onBrowserFocus: (listener: (panelId: string) => void) => () => void
    onBrowserPopup: (
      listener: (popup: DesktopBrowserPopup) => void
    ) => () => void
    browserPermissions: (
      panelId: string
    ) => Promise<DesktopBrowserPermissions | null>
    resetBrowserPermissions: (
      panelId: string,
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
  }>
>
