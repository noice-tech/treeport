import type { ApplicationUpdateStatus } from '../../src/server/application-update'
import type {
  TerminalPresetDefinition,
  TerminalPresetDefinitionDiagnostic,
  TreeContextFieldDefinition
} from '@treeport/shared'

export interface MockAppOptions {
  keyboardPlatform?: string
  startClosed?: boolean
  worktreeFree?: boolean
  includeSecondProject?: boolean
  desktopBridge?: boolean
  desktopFilePaths?: Record<string, string>
  initialPath?: string
  delayProjects?: boolean
  repositoryTerminalPresets?: TerminalPresetDefinition[]
  repositoryPresetDiagnostics?: TerminalPresetDefinitionDiagnostic[]
  treeContextFields?: TreeContextFieldDefinition[]
  applicationUpdate?: ApplicationUpdateStatus
  realReviewPanel?: boolean
  realFilesPanel?: boolean
  hostedBrowser?: boolean
  browserInstallRequired?: boolean
  browserBeforeUnload?: boolean
}
