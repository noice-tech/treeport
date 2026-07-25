import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type DesktopCommand = 'new-worktree' | 'new-terminal' | 'close-terminal'
type BellNotification = {
  terminalId: string
  sequence: number
  title: string
  projectName: string
  worktreeName: string
}
type BellNotificationAction = {
  type: 'view' | 'dismiss'
  terminalId: string
  sequence: number
}
type BellNotificationFallback = Pick<
  BellNotification,
  'terminalId' | 'sequence'
>

function isBellNotificationFallback(
  value: unknown
): value is BellNotificationFallback {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const notification = value as Record<string, unknown>
  const keys = Object.keys(notification).sort()
  return (
    keys.length === 2 &&
    keys[0] === 'sequence' &&
    keys[1] === 'terminalId' &&
    typeof notification.terminalId === 'string' &&
    notification.terminalId.length > 0 &&
    notification.terminalId.length <= 128 &&
    Number.isSafeInteger(notification.sequence) &&
    (notification.sequence as number) > 0
  )
}

function isBellNotificationAction(
  value: unknown
): value is BellNotificationAction {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const action = value as Record<string, unknown>
  return (
    (action.type === 'view' || action.type === 'dismiss') &&
    typeof action.terminalId === 'string' &&
    action.terminalId.length > 0 &&
    action.terminalId.length <= 128 &&
    Number.isSafeInteger(action.sequence) &&
    (action.sequence as number) > 0
  )
}

contextBridge.exposeInMainWorld(
  'taskttyDesktop',
  Object.freeze({
    platform: process.platform,
    openFileUrl(url: string): Promise<boolean> {
      return ipcRenderer
        .invoke('open-file-url', url)
        .then((opened) => opened === true)
    },
    onFullscreenChange(listener: (fullscreen: boolean) => void) {
      const receive = (_event: IpcRendererEvent, value: unknown) => {
        if (typeof value === 'boolean') {
          listener(value)
        }
      }
      ipcRenderer.on('fullscreen-change', receive)
      return () => ipcRenderer.removeListener('fullscreen-change', receive)
    },
    onCommand(listener: (command: DesktopCommand) => void) {
      const receive = (_event: IpcRendererEvent, value: unknown) => {
        if (
          value === 'new-worktree' ||
          value === 'new-terminal' ||
          value === 'close-terminal'
        ) {
          listener(value)
        }
      }
      ipcRenderer.on('desktop-command', receive)
      return () => ipcRenderer.removeListener('desktop-command', receive)
    },
    showBellNotification(notification: BellNotification) {
      ipcRenderer.send('bell-notification:show', notification)
    },
    clearBellNotification(
      notification: Pick<BellNotification, 'terminalId' | 'sequence'>
    ) {
      ipcRenderer.send('bell-notification:clear', notification)
    },
    onBellNotificationFallback(
      listener: (notification: BellNotificationFallback) => void
    ) {
      const receive = (_event: IpcRendererEvent, value: unknown) => {
        if (isBellNotificationFallback(value)) {
          listener(value)
        }
      }
      ipcRenderer.on('bell-notification:fallback', receive)
      return () =>
        ipcRenderer.removeListener('bell-notification:fallback', receive)
    },
    onBellNotificationNative(
      listener: (notification: BellNotificationFallback) => void
    ) {
      const receive = (_event: IpcRendererEvent, value: unknown) => {
        if (isBellNotificationFallback(value)) {
          listener(value)
        }
      }
      ipcRenderer.on('bell-notification:native', receive)
      return () =>
        ipcRenderer.removeListener('bell-notification:native', receive)
    },
    onBellNotificationAction(
      listener: (action: BellNotificationAction) => void
    ) {
      const receive = (_event: IpcRendererEvent, value: unknown) => {
        if (isBellNotificationAction(value)) {
          listener(value)
        }
      }
      ipcRenderer.on('bell-notification:action', receive)
      return () =>
        ipcRenderer.removeListener('bell-notification:action', receive)
    }
  })
)

window.addEventListener('DOMContentLoaded', () => {
  document
    .querySelector('[data-tasktty-retry]')
    ?.addEventListener('click', () => ipcRenderer.send('retry-connection'))
})
