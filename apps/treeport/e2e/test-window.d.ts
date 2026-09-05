interface TreeportTestSocketMessage {
  type: string
  data?: string
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
  readyState: number
  clientId: string
  cols: number
  rows: number
  revision: number
  receive(event: string, payload: import('@treeport/shared').JsonValue): void
  close(): void
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
  | 'select-previous-worktree'
  | 'select-next-worktree'
  | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

interface Window {
  __attentionRequests: number
  __delayTakeControl: boolean
  __dispatchDesktopCommand(command: TreeportTestDesktopCommand): void
  __dispatchDesktopFullscreen(fullscreen: boolean): void
  __dispatchTerminalSelectionRelease(): void
  __eventSource: {
    emit(name: string, source: string): void
  }
  __lastWs: TreeportTestWebSocket
  __openedDesktopFileUrls: string[]
  __openedTerminalLink: Parameters<Window['open']> | null
  __openedTerminalLinks: Array<Parameters<Window['open']>>
  __pasteTerminalFile(): { files: number; prevented: boolean }
  __releaseTakeControl: (() => void) | null
  __restoreStorageGetItem(): void
  __suppressInitialTitle: boolean
  __terminalStateListener: boolean
  __wsInstances: TreeportTestWebSocket[]
  __wsSent: TreeportTestSocketMessage[]
}
