import * as Schema from 'effect/Schema'
import type {
  WebPanel,
  WebPanelInput,
  WebPanelPermission
} from '@treeport/panel-sdk'
import { browserUrlSchema } from './browser-protocol.js'
import { jsonValueSchema } from './json-schema.js'
import { webPanelPermissionSchema } from './web-panel-protocol.js'
import {
  terminalSizeSchema,
  type TerminalRuntimeMetadata
} from './terminal-protocol.js'

export type {
  GitDiff,
  GitDiffChangeSets,
  JsonValue,
  TreeFile,
  TreeFileListing,
  TreeFileSearchFile,
  TreeFileSearchMatch,
  TreeFileSearchResult,
  TreeFileWrite,
  TreeFileWriteResult,
  WebPanel,
  WebPanelContext,
  WebPanelInput,
  WebPanelLaunch,
  WebPanelPermission,
  WorktreeListener,
  WorktreeListenerDiscovery
} from '@treeport/panel-sdk'
export * from './browser-protocol.js'
export * from './http-protocol.js'
export * from './json-schema.js'
export * from './network-rpc.js'
export * from './network-rpc-client.js'
export * from './protocol-socket-client.js'
export * from './schema.js'
export * from './socket-protocol.js'
export * from './terminal-protocol.js'
export * from './web-panel-protocol.js'

export const PRODUCT_NAME = 'Treeport'
export const API_VERSION = 1
export const DESKTOP_PROTOCOL_VERSION = 3
export const TERMINAL_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const TERMINAL_NAME_MAX_LENGTH = 120
export const TERMINAL_ARGV_MAX_COUNT = 128
export const TERMINAL_EXECUTABLE_MAX_LENGTH = 4_096
export const TERMINAL_ARGUMENT_MAX_LENGTH = 4_096
export const TERMINAL_PRESET_ARGUMENT_MAX_COUNT = TERMINAL_ARGV_MAX_COUNT - 1
export const TERMINAL_CAPTURE_DEFAULT_LINES = 200
export const TERMINAL_CAPTURE_MAX_LINES = 5_000
export const WEB_PANEL_INPUT_MAX_BYTES = 64 * 1024
export const TREE_CONTEXT_FIELD_MAX_COUNT = 64
export const TREE_CONTEXT_VALUE_MAX_LENGTH = 16 * 1024
export const TREE_CONTEXT_VALUES_MAX_LENGTH = 64 * 1024
export const TREE_FILE_MAX_BYTES = 2 * 1024 * 1024
export const TREE_FILE_LIST_MAX_ENTRIES = 50_000
export const TREE_FILE_SEARCH_QUERY_MAX_LENGTH = 256
export const TREE_FILE_SEARCH_MAX_MATCHES = 500
export const TREE_FILE_SEARCH_PREVIEW_MAX_LENGTH = 300

export function formatCommandLine(argv: readonly string[]): string {
  return argv
    .map((value) => {
      if (value === '') {
        return '""'
      }

      if (!/[\s"'\\]/.test(value)) {
        return value
      }

      return `"${value.replace(/["\\]/g, '\\$&')}"`
    })
    .join(' ')
}

export type ProjectKind = 'repository' | 'folder'
export type WorktreeKind = 'main' | 'linked' | 'folder'
export type TerminalStatus = 'running' | 'exited' | 'missing'
export type PrState = 'no_pr' | 'open' | 'merged' | 'closed' | 'unknown'
export type OperationStatus = 'pending' | 'running' | 'completed' | 'failed'
export type OperationKind =
  | 'create'
  | 'finish'
  | 'discard'
  | 'project_cleanup'
  | 'remove'
  | 'external_remove'

export interface PrInfo {
  state: PrState
  number: number | null
  url: string | null
  baseBranch: string | null
  headBranch: string | null
  mergedAt: string | null
  refreshedAt: string | null
}

export interface TerminalRecord {
  id: string
  worktreeId: string
  name: string
  argv: string[]
  shellCommand: string | null
  interactiveShell: boolean
  status: TerminalStatus
  exitCode: number | null
  createdAt: string
  updatedAt: string
}

export interface TerminalPreset {
  id: string
  name: string
  executable: string
  args: string[]
  closeOnSuccess: boolean
  createdAt: string
  updatedAt: string
}

export type PackageScope = 'global' | 'project'
export type PackageResourceType = 'web-panel' | 'terminal-preset'

export interface PackageResourceDiagnostic {
  severity: 'warning' | 'error'
  message: string
  scope: PackageScope
  source?: string
  projectId?: string
  resourceType?: PackageResourceType
  path?: string
}

export type PackageSource =
  | string
  | {
      source: string
      autoload?: boolean
      webPanels?: string[]
      terminalPresets?: string[]
    }

export interface PackageListing {
  source: string
  identity: string
  scope: PackageScope
  projectId: string | null
  projectName: string | null
  installedPath: string | null
  resources: {
    webPanels: number
    terminalPresets: number
  }
  diagnostics: PackageResourceDiagnostic[]
}

export interface PackageOperationResult {
  action: 'install' | 'remove' | 'update' | 'reload'
  source: string | null
  scope: PackageScope
  projectId: string | null
  status: 'installed' | 'removed' | 'updated' | 'reloaded' | 'skipped'
  reason?: string
}

export type TerminalPresetDefinitionSource =
  | { type: 'user' }
  | { type: 'repository'; format: 'treeport' | 'zed' }
  | {
      type: 'package'
      packageId: string
      source: string
      scope: PackageScope
    }

export interface TerminalPresetDefinitionDiagnostic {
  path: string
  itemId: string | null
  message: string
}

export interface TerminalPresetDefinitionListing {
  definitions: TerminalPresetDefinition[]
  diagnostics: TerminalPresetDefinitionDiagnostic[]
}

export interface TerminalPresetDefinition {
  id: string
  name: string
  executable: string | null
  args: string[]
  shellCommand: string | null
  cwd: string | null
  env: Record<string, string>
  closeOnSuccess: boolean
  source: TerminalPresetDefinitionSource
}

export interface TerminalCapture {
  terminalId: string
  capturedAt: string
  lineLimit: number
  content: string
}

export interface TerminalPanel {
  id: string
  kind: 'terminal'
  worktreeId: string
  terminalId: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface BrowserPanel {
  id: string
  kind: 'browser'
  worktreeId: string
  title: string
  url: string
  createdAt: string
  updatedAt: string
}

export type Panel = TerminalPanel | WebPanel | BrowserPanel

export type WebPanelSource =
  | { type: 'project' }
  | {
      type: 'package'
      packageId: string
      source: string
      scope: PackageScope
    }

export interface WebPanelSandbox {
  allowSameOrigin: boolean
}

export interface WebPanelDefinition {
  id: string
  title: string
  icon: string | null
  source: WebPanelSource
  permissions: WebPanelPermission[]
  permissionsGranted: boolean
  sandbox: WebPanelSandbox
}

export interface OpenWebPanelResult {
  panel: WebPanel
  created: boolean
  reused: boolean
}

export interface OpenBrowserPanelResult {
  panel: BrowserPanel
}

export type TreeContextFieldInput = 'text' | 'textarea'

export interface TreeContextFieldDefinition {
  id: string
  label: string
  input: TreeContextFieldInput
}

export interface TreeContextFieldDiagnostic {
  scope: 'global' | 'project'
  path: string
  message: string
}

export interface TreeContextFieldListing {
  fields: TreeContextFieldDefinition[]
  diagnostics: TreeContextFieldDiagnostic[]
}

export type TreeContextValues = Record<string, string>

export interface WorktreeRecord {
  id: string
  projectId: string
  name: string
  path: string
  head: string
  branch: string | null
  detached: boolean
  locked: boolean
  lockReason: string | null
  prunable: boolean
  kind: WorktreeKind
  managedWrapperPath: string | null
  pr: PrInfo
  dirty: DirtyState | null
  terminals: TerminalRecord[]
  panels: Panel[]
  createdAt: string
  updatedAt: string
}

export const PROJECT_COLORS = [
  'rose',
  'orange',
  'amber',
  'emerald',
  'cyan',
  'blue',
  'violet',
  'pink'
] as const

export type ProjectColor = (typeof PROJECT_COLORS)[number]

export interface ProjectRecord {
  id: string
  name: string
  kind: ProjectKind
  /** Canonical root folder for this project. */
  rootPath: string
  /**
   * Repository root for repository projects. Folder projects use rootPath here
   * to preserve the version 1 API shape; inspect kind before using Git fields.
   */
  repositoryPath: string
  /**
   * Main checkout for repository projects. Folder projects use rootPath here
   * to preserve the version 1 API shape; inspect kind before using Git fields.
   */
  mainWorktreePath: string
  /** Empty for folder projects. */
  defaultBranch: string
  color: ProjectColor | null
  availability: {
    state: 'available' | 'unavailable'
    message: string | null
  }
  worktrees: WorktreeRecord[]
  createdAt: string
  updatedAt: string
}

export interface RecentProjectRecord {
  id: string
  name: string
  kind: ProjectKind
  rootPath: string
  repositoryPath: string
  lastOpenedAt: string
}

export type TreeportContext =
  | {
      managed: false
      reason: 'outside_treeport'
    }
  | {
      managed: true
      apiUrl: string
      daemonLifecycle: 'treeport' | 'service' | 'external'
      project: Pick<
        ProjectRecord,
        | 'id'
        | 'name'
        | 'kind'
        | 'rootPath'
        | 'repositoryPath'
        | 'mainWorktreePath'
        | 'defaultBranch'
        | 'availability'
      >
      worktree: Pick<
        WorktreeRecord,
        | 'id'
        | 'projectId'
        | 'name'
        | 'path'
        | 'head'
        | 'branch'
        | 'detached'
        | 'kind'
      > & { context: TreeContextValues }
      terminal: Pick<
        TerminalRecord,
        'id' | 'worktreeId' | 'name' | 'status' | 'exitCode'
      >
    }

export interface DirtyState {
  dirty: boolean
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
  total: number
}

export type CleanupCommandStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'

export interface CleanupCommandProgress {
  name: string
  status: CleanupCommandStatus
  stdout: string
  stderr: string
  exitCode: number | null
  error: string | null
  outputTruncated: boolean
}

export interface RemoveCleanupProgress {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  definitionHash: string | null
  skippedReason: string | null
  commands: CleanupCommandProgress[]
}

export interface RemovePreview {
  worktreeId: string
  name: string
  path: string
  head: string
  branch: string | null
  detached: boolean
  locked: boolean
  lockReason: string | null
  dirty: DirtyState
  detachedHeadReachable: boolean | null
  forceRequired: boolean
  eligible: boolean
  reasons: string[]
  warnings: string[]
  cleanup: {
    commands: string[]
    available: boolean
    unavailableReason: string | null
  }
  terminals: Array<Pick<TerminalRecord, 'id' | 'name' | 'status'>>
  confirmationToken: string
}

export interface RemovalCheckoutIdentity {
  path: string
  device: string
  inode: string
  gitWorktreeKey: string
  gitMarker: string
  repositoryIdentity: string | null
  managedWrapperPath: string | null
  quarantinePath: string
}

export interface CreateOperationRequest {
  name: string
  base: 'default' | 'current'
  context?: TreeContextValues | undefined
  initialTerminal?:
    | {
        name: string
        initialTitle?: string | undefined
        argv?: string[] | undefined
        returnToShell?: boolean | undefined
        initialSize?: { cols: number; rows: number } | undefined
      }
    | undefined
  sourceWorktreeId?: string | undefined
}

export interface CreateOperationResult {
  worktreeId: string
  terminalId: string | null
  terminalError: string | null
  setupError: string | null
}

export type RemoveOperationPhase =
  | 'accepted'
  | 'terminals_stopped'
  | 'cleanup_commands_completed'
  | 'git_removed'
  | 'cleanup_pending'

export interface RemoveOperationRequest {
  confirmation: boolean | null
  confirmationToken: string | null
  confirmDestructive: boolean | null
  preview: RemovePreview | null
  checkoutIdentity: RemovalCheckoutIdentity | null
  prunable: boolean | null
  gitWorktreeKey: string | null
  repositoryIdentity: string | null
  phase: RemoveOperationPhase | null
  managedWrapperPath: string | null
  cleanupCommands: RemoveCleanupProgress
}

export interface RemoveOperationResult {
  removed: true
  worktreeId: string
  name: string
  branchPreserved: string | null
  path: string
  recovered: boolean
  cleanup: {
    status: 'completed' | 'preserved'
    residualPath: string | null
    warning: string | null
    commands: CleanupCommandProgress[]
  }
}

export interface ExternalRemoveOperationResult {
  removed: true
  external: true
  worktreeId: string
  path: string
  head: string
  branch: string | null
  cleanup: {
    status: 'skipped'
    skippedReason: string
  }
}

interface OperationRecordBase {
  id: string
  projectId: string | null
  worktreeId: string | null
  status: OperationStatus
  error: string | null
  createdAt: string
  updatedAt: string
}

export type CreateOperationRecord = OperationRecordBase & {
  kind: 'create'
  request: CreateOperationRequest
  result: CreateOperationResult | null
}

export type RemoveOperationRecord = OperationRecordBase & {
  kind: 'remove'
  request: RemoveOperationRequest
  result: RemoveOperationResult | null
}

export type OperationRecord =
  | CreateOperationRecord
  | RemoveOperationRecord
  | (OperationRecordBase & {
      kind: 'external_remove'
      request: { source: 'git' }
      result: ExternalRemoveOperationResult | null
    })
  | (OperationRecordBase & {
      kind: 'finish' | 'discard' | 'project_cleanup'
      request: object
      result: object | null
    })

export const apiErrorBodySchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    details: Schema.optional(Schema.Unknown)
  })
})
export type ApiErrorBody = Schema.Schema.Type<typeof apiErrorBodySchema>

export interface DirectoryBreadcrumb {
  name: string
  path: string
}

export interface DirectoryEntry {
  name: string
  path: string
}

export type DirectoryRepositoryStatus =
  | { state: 'valid'; repositoryPath: string }
  | { state: 'incomplete'; message: string }
  | { state: 'not-repository'; message: string }

export type DirectoryProjectStatus =
  | { state: 'valid'; kind: ProjectKind; path: string }
  | { state: 'incomplete'; message: string }

export interface DirectoryBrowseResponse {
  input: string
  exact: boolean
  directory: {
    path: string
    parentPath: string | null
    homePath: string
    rootPath: string
    breadcrumbs: DirectoryBreadcrumb[]
    entries: DirectoryEntry[]
    truncated: boolean
  }
  project: DirectoryProjectStatus
  repository: DirectoryRepositoryStatus
}

export const browseDirectoryQuerySchema = Schema.Struct({
  input: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  hidden: Schema.optionalWith(
    Schema.Literal('true', 'false').pipe(
      Schema.transform(Schema.Boolean, {
        strict: true,
        decode: (value) => value === 'true',
        encode: (value) => (value ? 'true' : 'false')
      })
    ),
    { default: () => false }
  )
})

export const terminalCaptureQuerySchema = Schema.Struct({
  lines: Schema.optionalWith(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.between(1, TERMINAL_CAPTURE_MAX_LINES)
    ),
    { default: () => TERMINAL_CAPTURE_DEFAULT_LINES }
  )
})

export const registerProjectSchema = Schema.Struct({
  path: Schema.Trim.pipe(Schema.minLength(1)),
  name: Schema.optional(
    Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(120))
  )
})

export const updateProjectSchema = Schema.Struct({
  color: Schema.NullOr(Schema.Literal(...PROJECT_COLORS))
})

const terminalNameSchema = Schema.Trim.pipe(
  Schema.minLength(1),
  Schema.maxLength(TERMINAL_NAME_MAX_LENGTH)
)
const terminalArgvSchema = Schema.Array(Schema.String).pipe(
  Schema.minItems(1),
  Schema.maxItems(TERMINAL_ARGV_MAX_COUNT)
)
const terminalPresetArgumentSchema = Schema.String.pipe(
  Schema.maxLength(TERMINAL_ARGUMENT_MAX_LENGTH)
)
const terminalPresetExecutableSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(TERMINAL_EXECUTABLE_MAX_LENGTH),
  Schema.filter((value) => value.trim().length > 0, {
    message: () => 'Executable cannot be blank'
  })
)
const terminalPresetFields = {
  name: terminalNameSchema,
  executable: terminalPresetExecutableSchema,
  args: Schema.Array(terminalPresetArgumentSchema).pipe(
    Schema.maxItems(TERMINAL_PRESET_ARGUMENT_MAX_COUNT)
  ),
  closeOnSuccess: Schema.optionalWith(Schema.Boolean, {
    default: () => false
  })
}
export const repositoryTerminalPresetSchema =
  Schema.Struct(terminalPresetFields)
const repositoryTerminalPresetIdSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]{0,119}$/, {
    message: () =>
      'Preset IDs must contain only lowercase letters, numbers, dots, underscores, and hyphens'
  })
)
export const repositoryTerminalPresetsFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  presets: Schema.Record({
    key: repositoryTerminalPresetIdSchema,
    value: Schema.Unknown
  })
})
const terminalPresetRevisionSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64)
)

const treeContextFieldIdSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]{0,119}$/, {
    message: () =>
      'Field IDs must contain only lowercase letters, numbers, dots, underscores, and hyphens'
  })
)
export const treeContextFieldDefinitionSchema = Schema.Struct({
  id: treeContextFieldIdSchema,
  label: Schema.Trim.pipe(
    Schema.minLength(1),
    Schema.maxLength(120),
    Schema.filter((value) => !value.includes('\0'), {
      message: () => 'Field labels cannot contain NUL'
    })
  ),
  input: Schema.Literal('text', 'textarea')
})

export const treeContextValuesSchema = Schema.Record({
  key: treeContextFieldIdSchema,
  value: Schema.Trim.pipe(
    Schema.minLength(1),
    Schema.maxLength(TREE_CONTEXT_VALUE_MAX_LENGTH),
    Schema.filter((value) => !value.includes('\0'), {
      message: () => 'Tree context values cannot contain NUL'
    })
  )
}).pipe(
  Schema.filter(
    (values) => {
      const entries = Object.entries(values)
      return (
        entries.length <= TREE_CONTEXT_FIELD_MAX_COUNT &&
        entries.reduce(
          (length, [key, value]) => length + key.length + value.length,
          0
        ) <= TREE_CONTEXT_VALUES_MAX_LENGTH
      )
    },
    { message: () => 'Tree context exceeds its size limit' }
  )
)

const initialTerminalSchema = Schema.Struct({
  name: terminalNameSchema,
  initialTitle: Schema.optional(terminalNameSchema),
  argv: Schema.optional(terminalArgvSchema),
  returnToShell: Schema.optional(Schema.Boolean),
  initialSize: Schema.optional(terminalSizeSchema)
})

export const createWorktreeSchema = Schema.Struct({
  name: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(120)),
  base: Schema.optionalWith(Schema.Literal('default', 'current'), {
    default: () => 'default' as const
  }),
  context: Schema.optional(treeContextValuesSchema),
  sourceWorktreeId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  initialTerminal: Schema.optional(initialTerminalSchema)
}).pipe(
  Schema.filter(
    (value) => value.base !== 'current' || Boolean(value.sourceWorktreeId),
    { message: () => 'A source tree is required when starting from current' }
  )
)

const terminalCwdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.filter((value) => value.trim().length > 0 && !value.includes('\0'), {
    message: () => 'Working directory cannot be blank or contain NUL'
  })
)
const terminalEnvironmentKeySchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
  Schema.filter((value) => !value.includes('=') && !value.includes('\0'), {
    message: () => 'Environment keys cannot contain equals or NUL'
  })
)
const terminalShellCommandSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(TERMINAL_ARGUMENT_MAX_LENGTH),
  Schema.filter((value) => value.trim().length > 0 && !value.includes('\0'), {
    message: () => 'Shell command cannot be blank or contain NUL'
  })
)
const terminalEnvironmentSchema = Schema.Record({
  key: terminalEnvironmentKeySchema,
  value: Schema.String.pipe(
    Schema.maxLength(TERMINAL_ARGUMENT_MAX_LENGTH),
    Schema.filter((value) => !value.includes('\0'), {
      message: () => 'Environment values cannot contain NUL'
    })
  )
}).pipe(
  Schema.filter((value) => Object.keys(value).length <= 128, {
    message: () => 'Environment cannot contain more than 128 variables'
  })
)

export const createTerminalSchema = Schema.Struct({
  name: terminalNameSchema,
  initialTitle: Schema.optional(terminalNameSchema),
  argv: Schema.optional(terminalArgvSchema),
  shellCommand: Schema.optional(terminalShellCommandSchema),
  cwd: Schema.optional(terminalCwdSchema),
  env: Schema.optional(terminalEnvironmentSchema),
  returnToShell: Schema.optional(Schema.Boolean),
  closeOnSuccess: Schema.optional(Schema.Boolean),
  initialSize: Schema.optional(terminalSizeSchema)
}).pipe(
  Schema.filter((value) => !(value.argv && value.shellCommand), {
    message: () => 'A terminal cannot have both argv and a shell command'
  }),
  Schema.filter((value) => !(value.returnToShell && value.closeOnSuccess), {
    message: () => 'A terminal cannot return to a shell and close on success'
  })
)

export const updateTerminalSchema = Schema.Struct({ name: terminalNameSchema })

export const webPanelInputSchema: Schema.Schema<WebPanelInput> = Schema.Record({
  key: Schema.String,
  value: jsonValueSchema
})

export const createWebPanelSchema = Schema.Struct({
  definitionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  input: Schema.optional(Schema.NullOr(webPanelInputSchema)),
  launchCwd: Schema.optional(
    Schema.NullOr(Schema.String.pipe(Schema.maxLength(4_096)))
  )
})
export const updateWebPanelPermissionGrantSchema = Schema.Struct({
  granted: Schema.Boolean,
  permissions: Schema.Array(webPanelPermissionSchema)
})
export const createBrowserPanelSchema = Schema.Struct({
  url: Schema.optional(browserUrlSchema),
  sourceTerminalId: Schema.optional(
    Schema.NullOr(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
    )
  )
})
export const openBrowserPanelFromTerminalSchema = Schema.Struct({
  url: browserUrlSchema
})
export const openWebPanelSchema = Schema.Struct({
  ...createWebPanelSchema.fields,
  newInstance: Schema.optional(Schema.Boolean),
  sourceTerminalId: Schema.optional(
    Schema.NullOr(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
    )
  )
})
export const requestWorkspaceOpenSchema = Schema.Struct({
  sourceTerminalId: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128)
  )
})

export const webPanelStorageKeySchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)
export const getWebPanelStorageSchema = Schema.Struct({
  key: webPanelStorageKeySchema
})
export const setWebPanelStorageSchema = Schema.Struct({
  key: webPanelStorageKeySchema,
  value: jsonValueSchema
})
export const deleteWebPanelStorageSchema = Schema.Struct({
  key: webPanelStorageKeySchema
})

export const treeFilePathSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.filter(
    (value) =>
      !value.includes('\0') &&
      !value.startsWith('/') &&
      value.split('/').every((segment) => segment !== '' && segment !== '..'),
    { message: () => 'File path must be a relative path inside the tree' }
  )
)
export const readTreeFileSchema = Schema.Struct({ path: treeFilePathSchema })
export const searchTreeFilesSchema = Schema.Struct({
  query: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(TREE_FILE_SEARCH_QUERY_MAX_LENGTH),
    Schema.filter((value) => !/[\0\r\n]/.test(value), {
      message: () => 'Search query must be one line and cannot contain NUL'
    })
  )
})
export const writeTreeFileSchema = Schema.Struct({
  path: treeFilePathSchema,
  content: Schema.String,
  expectedRevision: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128)
  )
})

export const createTerminalPresetSchema = Schema.Struct(terminalPresetFields)
export const updateTerminalPresetSchema = Schema.Struct({
  ...terminalPresetFields,
  closeOnSuccess: Schema.optional(Schema.Boolean),
  expectedUpdatedAt: terminalPresetRevisionSchema
})
export const deleteTerminalPresetSchema = Schema.Struct({
  expectedUpdatedAt: terminalPresetRevisionSchema
})

export const packageProjectQuerySchema = Schema.Struct({
  path: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096))
})
export const packageInstallSchema = Schema.Struct({
  source: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  projectId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})
export const packageRemoveSchema = Schema.Struct({
  source: Schema.String.pipe(Schema.minLength(1)),
  projectId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})
export const packageUpdateSchema = Schema.Struct({
  source: Schema.optional(
    Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096))
  )
})
export const packageReloadSchema = Schema.Struct({
  projectId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})
export const removeWorktreeSchema = Schema.Struct({
  confirmationToken: Schema.String.pipe(Schema.length(64)),
  confirmDestructive: Schema.Boolean
})
export const spawnSchema = Schema.Struct({
  project: Schema.String.pipe(Schema.minLength(1)),
  worktreeName: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(120)),
  name: terminalNameSchema,
  argv: Schema.optional(terminalArgvSchema),
  base: Schema.optionalWith(Schema.Literal('default', 'current'), {
    default: () => 'default' as const
  }),
  sourceWorktreeId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
}).pipe(
  Schema.filter(
    (value) => value.base !== 'current' || Boolean(value.sourceWorktreeId),
    { message: () => 'A source tree is required when starting from current' }
  )
)

interface ProductEventPayloadMap {
  'project.created': { projectId: string }
  'project.updated': { projectId: string }
  'project.removed': { projectId: string }
  'worktree.created': { projectId: string; worktreeId: string }
  'worktree.updated': { worktreeId: string }
  'worktree.removed': { projectId: string; worktreeId: string }
  'create.started': { projectId: string; operationId: string }
  'create.completed': {
    projectId: string
    operationId: string
    worktreeId: string
  }
  'create.failed': { projectId: string; operationId: string }
  'terminal.created': {
    projectId?: string | undefined
    worktreeId: string
    terminalId: string
    terminal: TerminalRecord
  }
  'terminal.updated': { worktreeId: string; terminalId: string }
  'terminal.removed': { worktreeId: string; terminalId: string }
  'terminal.metadata': TerminalRuntimeMetadata
  'terminal.controller_changed': { terminalId: string; controlled: boolean }
  'panel.created': { worktreeId: string; panelId: string }
  'panel.updated': { worktreeId: string; panelId: string }
  'panel.open_requested': {
    worktreeId: string
    panelId: string
    panel: BrowserPanel | WebPanel
    sourceTerminalId: string | null
    sourcePanelId: string | null
  }
  'panel.removed': { worktreeId: string; panelId: string }
  'workspace.open_requested': {
    worktreeId: string
    sourceTerminalId: string
  }
  'remove.started': {
    operationId: string
    worktreeId: string
    kind: 'remove'
  }
  'remove.completed': { operationId: string; worktreeId: string }
  'remove.failed': {
    operationId: string
    worktreeId: string
    error: string
  }
}

export type ProductEventType = keyof ProductEventPayloadMap

export type ProductEventInputDataMap = {
  [Type in ProductEventType]: ProductEventPayloadMap[Type] & {
    worktreeId?: string | undefined
  }
}

export type ProductEventDataMap = {
  [Type in ProductEventType]: Omit<
    ProductEventPayloadMap[Type],
    'worktreeId'
  > & {
    worktreeId: string | null
  }
}

export type ProductEvent<Type extends ProductEventType = ProductEventType> = {
  [EventType in Type]: {
    id: string
    type: EventType
    at: string
    data: ProductEventDataMap[EventType]
  }
}[Type]
