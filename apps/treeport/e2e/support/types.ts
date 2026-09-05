import type { ApplicationUpdateStatus } from '../../src/server/application-update'
import type { TreeContextFieldDefinition } from '@treeport/shared'

export interface MockAppOptions {
  keyboardPlatform?: string
  includeSecondProject?: boolean
  desktopBridge?: boolean
  desktopFilePaths?: Record<string, string>
  initialPath?: string
  treeContextFields?: TreeContextFieldDefinition[]
  applicationUpdate?: ApplicationUpdateStatus
  realFilesPanel?: boolean
}
