type TaskTTYTerminalCommand = 'new-terminal' | 'close-terminal'

interface Window {
  readonly taskttyDesktop?: Readonly<{
    platform: NodeJS.Platform
    onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
    onTerminalCommand: (
      listener: (command: TaskTTYTerminalCommand) => void
    ) => () => void
  }>
}
