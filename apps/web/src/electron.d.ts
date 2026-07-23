type TaskTTYTerminalCommand = 'new-terminal' | 'close-terminal'

interface Window {
  readonly taskttyDesktop?: Readonly<{
    onTerminalCommand: (
      listener: (command: TaskTTYTerminalCommand) => void
    ) => () => void
  }>
}
