type TaskTTYTerminalCommand = 'new-terminal' | 'close-terminal'
type TaskTTYBellNotification = {
  terminalId: string
  sequence: number
  title: string
  projectName: string
  worktreeName: string
}
type TaskTTYBellNotificationAction = {
  type: 'view' | 'dismiss'
  terminalId: string
  sequence: number
}

interface Window {
  readonly taskttyDesktop?: Readonly<{
    platform: NodeJS.Platform
    onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
    onTerminalCommand: (
      listener: (command: TaskTTYTerminalCommand) => void
    ) => () => void
    showBellNotification: (notification: TaskTTYBellNotification) => void
    clearBellNotification: (
      notification: Pick<TaskTTYBellNotification, 'terminalId' | 'sequence'>
    ) => void
    onBellNotificationAction: (
      listener: (action: TaskTTYBellNotificationAction) => void
    ) => () => void
  }>
}
