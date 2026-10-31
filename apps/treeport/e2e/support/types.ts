export interface MockAppOptions {
  keyboardPlatform?: string
  includeSecondProject?: boolean
  desktopBridge?: boolean
  desktopFilePaths?: Record<string, string>
  initialPath?: string
}
