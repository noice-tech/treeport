type TaskTTYTerminalCommand = 'new-terminal' | 'close-terminal'

interface Window {
  readonly taskttyDesktop?: Readonly<{
    platform: NodeJS.Platform
    openFileUrl: (url: string) => Promise<boolean>
    onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
    onTerminalCommand: (
      listener: (command: TaskTTYTerminalCommand) => void
    ) => () => void
  }>
}
