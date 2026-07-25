type TaskTTYDesktopCommand = 'new-worktree' | 'new-terminal' | 'close-terminal'

interface Window {
  readonly taskttyDesktop?: Readonly<{
    platform: NodeJS.Platform
    openFileUrl: (url: string) => Promise<boolean>
    onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
    onCommand: (
      listener: (command: TaskTTYDesktopCommand) => void
    ) => () => void
    requestAttention: () => void
  }>
}
