interface TreeportTestSocketMessage {
  type: string
  data?: string
}

interface TreeportTestBrowserCommand {
  type: string
  [key: string]: unknown
}

interface TreeportTestTerminalState {
  terminalId: string
  cols: number
  rows: number
  revision: number
  generation: number
  controllerClientId: string
}

interface TreeportTestWebSocket {
  url: string
  namespace: string
  terminalId: string
  streamId: string
  generation: number
  onmessage: (event: { data: string }) => void
  onclose: () => void
  applyTerminalState(state: TreeportTestTerminalState): void
}

type TreeportTestDesktopCommand =
  | 'new-worktree'
  | 'new-terminal'
  | 'new-panel'
  | 'close-panel'
  | 'toggle-side-panel'
  | 'focus-location'
  | 'find-in-page'
  | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

interface Window {
  __attentionRequests: number
  __browserCommands: TreeportTestBrowserCommand[]
  __browserNavigationCompleted: string | null
  __delayTakeControl: boolean
  __dispatchDesktopCommand(command: TreeportTestDesktopCommand): void
  __dispatchDesktopFullscreen(fullscreen: boolean): void
  __dispatchTerminalSelectionRelease(): void
  __eventSource: {
    disconnect(): void
    emit(name: string, source?: string): void
  }
  __lastWs: TreeportTestWebSocket
  __openedDesktopFileUrls: string[]
  __openedTerminalLink: Parameters<Window['open']> | null
  __openedTerminalLinks: Array<Parameters<Window['open']>>
  __pasteTerminalFile(): { files: number; prevented: boolean }
  __releaseTakeControl: (() => void) | null
  __repeatBrowserState(): void
  __setBrowserLoading(loading: boolean): void
  __setBrowserUrl(url: string): void
  __restoreStorageGetItem(): void
  __suppressInitialTitle: boolean
  __terminalStateListener: boolean
  __wsInstances: TreeportTestWebSocket[]
  __wsSent: TreeportTestSocketMessage[]
}
