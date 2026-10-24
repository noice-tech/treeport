import type { ApplicationUpdateStatus } from '../../src/server/application-update'

export interface MockAppOptions {
  keyboardPlatform?: string
  includeSecondProject?: boolean
  desktopBridge?: boolean
  desktopFilePaths?: Record<string, string>
  initialPath?: string
  applicationUpdate?: ApplicationUpdateStatus
}
