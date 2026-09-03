import { z } from 'zod'
import type {
  WebPanel,
  WebPanelInput,
  WebPanelPermission
} from '@treeport/panel-sdk'
import { browserUrlSchema } from './browser-protocol.js'
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
  }
}

export interface ExternalRemoveOperationResult {
  removed: true
  external: true
  worktreeId: string
  path: string
  head: string
  branch: string | null
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

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown }
}

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

export const browseDirectoryQuerySchema = z.object({
  input: z.string().trim().min(1).max(4096),
  hidden: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((value) => value === 'true')
})

export const terminalCaptureQuerySchema = z.object({
  lines: z.coerce
    .number()
    .int()
    .min(1)
    .max(TERMINAL_CAPTURE_MAX_LINES)
    .optional()
    .default(TERMINAL_CAPTURE_DEFAULT_LINES)
})

export const registerProjectSchema = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional()
})

export const updateProjectSchema = z.object({
  color: z.enum(PROJECT_COLORS).nullable()
})

const terminalNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TERMINAL_NAME_MAX_LENGTH)
const terminalArgvSchema = z
  .array(z.string())
  .min(1)
  .max(TERMINAL_ARGV_MAX_COUNT)
const terminalPresetArgumentSchema = z
  .string()
  .max(TERMINAL_ARGUMENT_MAX_LENGTH)
const terminalPresetExecutableSchema = z
  .string()
  .min(1)
  .max(TERMINAL_EXECUTABLE_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, {
    message: 'Executable cannot be blank'
  })
const terminalPresetFields = {
  name: terminalNameSchema,
  executable: terminalPresetExecutableSchema,
  args: z
    .array(terminalPresetArgumentSchema)
    .max(TERMINAL_PRESET_ARGUMENT_MAX_COUNT),
  closeOnSuccess: z.boolean().default(false)
}
export const repositoryTerminalPresetSchema =
  z.strictObject(terminalPresetFields)
const repositoryTerminalPresetIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,119}$/, {
    message:
      'Preset IDs must contain only lowercase letters, numbers, dots, underscores, and hyphens'
  })
export const repositoryTerminalPresetsFileSchema = z.strictObject({
  version: z.literal(1),
  presets: z.record(repositoryTerminalPresetIdSchema, z.unknown())
})
const terminalPresetRevisionSchema = z.string().min(1).max(64)

const treeContextFieldIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,119}$/, {
    message:
      'Field IDs must contain only lowercase letters, numbers, dots, underscores, and hyphens'
  })
export const treeContextFieldDefinitionSchema = z.strictObject({
  id: treeContextFieldIdSchema,
  label: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => !value.includes('\0'), {
      message: 'Field labels cannot contain NUL'
    }),
  input: z.enum(['text', 'textarea'])
})

export const treeContextValuesSchema = z
  .record(
    treeContextFieldIdSchema,
    z
      .string()
      .trim()
      .min(1)
      .max(TREE_CONTEXT_VALUE_MAX_LENGTH)
      .refine((value) => !value.includes('\0'), {
        message: 'Tree context values cannot contain NUL'
      })
  )
  .superRefine((values, context) => {
    const entries = Object.entries(values)
    if (entries.length > TREE_CONTEXT_FIELD_MAX_COUNT) {
      context.addIssue({
        code: 'custom',
        message: `Tree context cannot contain more than ${TREE_CONTEXT_FIELD_MAX_COUNT} values`
      })
    }

    const totalLength = entries.reduce(
      (length, [key, value]) => length + key.length + value.length,
      0
    )
    if (totalLength > TREE_CONTEXT_VALUES_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: `Tree context cannot contain more than ${TREE_CONTEXT_VALUES_MAX_LENGTH} characters`
      })
    }
  })

const initialTerminalSchema = z.object({
  name: terminalNameSchema,
  initialTitle: terminalNameSchema.optional(),
  argv: terminalArgvSchema.optional(),
  returnToShell: z.boolean().optional(),
  initialSize: terminalSizeSchema.optional()
})

export const createWorktreeSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    base: z.enum(['default', 'current']).default('default'),
    context: treeContextValuesSchema.optional(),
    sourceWorktreeId: z.string().min(1).optional(),
    initialTerminal: initialTerminalSchema.optional()
  })
  .superRefine((value, context) => {
    if (value.base === 'current' && !value.sourceWorktreeId) {
      context.addIssue({
        code: 'custom',
        path: ['sourceWorktreeId'],
        message: 'A source tree is required when starting from current'
      })
    }
  })

const terminalCwdSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.trim().length > 0 && !value.includes('\0'), {
    message: 'Working directory cannot be blank or contain NUL'
  })
const terminalEnvironmentKeySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('=') && !value.includes('\0'), {
    message: 'Environment keys cannot contain equals or NUL'
  })
const terminalShellCommandSchema = z
  .string()
  .min(1)
  .max(TERMINAL_ARGUMENT_MAX_LENGTH)
  .refine((value) => value.trim().length > 0 && !value.includes('\0'), {
    message: 'Shell command cannot be blank or contain NUL'
  })
const terminalEnvironmentSchema = z
  .record(
    terminalEnvironmentKeySchema,
    z
      .string()
      .max(TERMINAL_ARGUMENT_MAX_LENGTH)
      .refine((value) => !value.includes('\0'), {
        message: 'Environment values cannot contain NUL'
      })
  )
  .refine((value) => Object.keys(value).length <= 128, {
    message: 'Environment cannot contain more than 128 variables'
  })

export const createTerminalSchema = z
  .object({
    name: terminalNameSchema,
    initialTitle: terminalNameSchema.optional(),
    argv: terminalArgvSchema.optional(),
    shellCommand: terminalShellCommandSchema.optional(),
    cwd: terminalCwdSchema.optional(),
    env: terminalEnvironmentSchema.optional(),
    returnToShell: z.boolean().optional(),
    closeOnSuccess: z.boolean().optional(),
    initialSize: terminalSizeSchema.optional()
  })
  .refine((value) => !(value.argv && value.shellCommand), {
    message: 'A terminal cannot have both argv and a shell command'
  })
  .refine((value) => !(value.returnToShell && value.closeOnSuccess), {
    message: 'A terminal cannot return to a shell and close on success'
  })

export const updateTerminalSchema = z.object({
  name: terminalNameSchema
})

export const webPanelInputSchema: z.ZodType<WebPanelInput> = z.record(
  z.string(),
  z.json()
)

export const createWebPanelSchema = z.object({
  definitionId: z.string().min(1).max(256),
  input: webPanelInputSchema.nullable().optional(),
  launchCwd: z.string().max(4096).nullable().optional()
})

export const updateWebPanelPermissionGrantSchema = z.strictObject({
  granted: z.boolean(),
  permissions: z.array(webPanelPermissionSchema)
})

export const createBrowserPanelSchema = z.strictObject({
  url: browserUrlSchema.optional(),
  sourceTerminalId: z.string().min(1).max(128).nullable().optional()
})

export const openBrowserPanelFromTerminalSchema = z.strictObject({
  url: browserUrlSchema
})

export const openWebPanelSchema = createWebPanelSchema.extend({
  newInstance: z.boolean().optional(),
  sourceTerminalId: z.string().min(1).max(128).nullable().optional()
})

export const requestWorkspaceOpenSchema = z.object({
  sourceTerminalId: z.string().min(1).max(128)
})

export const webPanelStorageKeySchema = z.string().min(1).max(128)

export const getWebPanelStorageSchema = z.object({
  key: webPanelStorageKeySchema
})

export const setWebPanelStorageSchema = z.object({
  key: webPanelStorageKeySchema,
  value: z.json()
})

export const deleteWebPanelStorageSchema = z.object({
  key: webPanelStorageKeySchema
})

export const treeFilePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes('\0') &&
      !value.startsWith('/') &&
      value.split('/').every((segment) => segment !== '' && segment !== '..'),
    { message: 'File path must be a relative path inside the tree' }
  )

export const readTreeFileSchema = z.strictObject({
  path: treeFilePathSchema
})

export const writeTreeFileSchema = z.strictObject({
  path: treeFilePathSchema,
  content: z.string(),
  expectedRevision: z.string().min(1).max(128)
})

export const createTerminalPresetSchema = z.object(terminalPresetFields)

export const updateTerminalPresetSchema = z.object({
  ...terminalPresetFields,
  closeOnSuccess: z.boolean().optional(),
  expectedUpdatedAt: terminalPresetRevisionSchema
})

export const deleteTerminalPresetSchema = z.object({
  expectedUpdatedAt: terminalPresetRevisionSchema
})

export const packageProjectQuerySchema = z.object({
  path: z.string().trim().min(1).max(4096)
})

export const packageInstallSchema = z.object({
  source: z.string().trim().min(1).max(4096),
  projectId: z.string().min(1).optional()
})

export const packageRemoveSchema = z.object({
  source: z.string().trim().min(1).max(4096),
  projectId: z.string().min(1).optional()
})

export const packageUpdateSchema = z.object({
  source: z.string().trim().min(1).max(4096).optional()
})

export const packageReloadSchema = z.object({
  projectId: z.string().min(1).optional()
})

export const removeWorktreeSchema = z.object({
  confirmationToken: z.string().length(64),
  confirmDestructive: z.boolean()
})

export const spawnSchema = z
  .object({
    project: z.string().min(1),
    worktreeName: z.string().trim().min(1).max(120),
    name: terminalNameSchema,
    argv: terminalArgvSchema.optional(),
    base: z.enum(['default', 'current']).default('default'),
    sourceWorktreeId: z.string().min(1).optional()
  })
  .superRefine((value, context) => {
    if (value.base === 'current' && !value.sourceWorktreeId) {
      context.addIssue({
        code: 'custom',
        path: ['sourceWorktreeId'],
        message: 'A source tree is required when starting from current'
      })
    }
  })

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
