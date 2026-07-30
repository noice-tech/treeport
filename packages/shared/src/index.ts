import { z } from 'zod'
import { terminalSizeSchema } from './terminal-protocol.js'

export * from './socket-protocol.js'
export * from './terminal-protocol.js'

export const PRODUCT_NAME = 'Treeport'
export const API_VERSION = 1
export const DESKTOP_PROTOCOL_VERSION = 2
export const TERMINAL_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const TERMINAL_NAME_MAX_LENGTH = 120
export const TERMINAL_ARGV_MAX_COUNT = 128
export const TERMINAL_EXECUTABLE_MAX_LENGTH = 4_096
export const TERMINAL_ARGUMENT_MAX_LENGTH = 4_096
export const TERMINAL_PRESET_ARGUMENT_MAX_COUNT = TERMINAL_ARGV_MAX_COUNT - 1
export const TERMINAL_CAPTURE_DEFAULT_LINES = 200
export const TERMINAL_CAPTURE_MAX_LINES = 5_000

export type WorktreeKind = 'main' | 'linked'
export type WorktreeStatus =
  | 'active'
  | 'cleaning'
  | 'cleanup_failed'
  | 'removed'
export type TerminalStatus = 'running' | 'exited' | 'missing'
export type PrState = 'no_pr' | 'open' | 'merged' | 'closed' | 'unknown'
export type OperationStatus = 'pending' | 'running' | 'completed' | 'failed'
export type OperationKind =
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
  tmuxSessionName: string
  argv: string[]
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

export interface TerminalCapture {
  terminalId: string
  capturedAt: string
  lineLimit: number
  content: string
}

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
  tmuxSocketName: string
  status: WorktreeStatus
  cleanupError: string | null
  managedWrapperPath: string | null
  pr: PrInfo
  dirty: DirtyState | null
  terminals: TerminalRecord[]
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
  repositoryPath: string
  mainWorktreePath: string
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
      project: Pick<
        ProjectRecord,
        | 'id'
        | 'name'
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
        | 'status'
      >
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

export interface OperationRecord {
  id: string
  kind: OperationKind
  projectId: string | null
  worktreeId: string | null
  status: OperationStatus
  request: Record<string, unknown>
  result: Record<string, unknown> | null
  error: string | null
  createdAt: string
  updatedAt: string
}

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
const terminalPresetRevisionSchema = z.string().min(1).max(64)

const initialTerminalSchema = z.object({
  name: terminalNameSchema,
  argv: terminalArgvSchema.optional(),
  returnToShell: z.boolean().optional(),
  initialSize: terminalSizeSchema.optional()
})

export const createWorktreeSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    base: z.enum(['default', 'current']).default('default'),
    sourceWorktreeId: z.string().min(1).optional(),
    initialTerminal: initialTerminalSchema.optional()
  })
  .superRefine((value, context) => {
    if (value.base === 'current' && !value.sourceWorktreeId) {
      context.addIssue({
        code: 'custom',
        path: ['sourceWorktreeId'],
        message: 'A source worktree is required when starting from current'
      })
    }
  })

export const createTerminalSchema = z
  .object({
    name: terminalNameSchema,
    argv: terminalArgvSchema.optional(),
    returnToShell: z.boolean().optional(),
    closeOnSuccess: z.boolean().optional(),
    initialSize: terminalSizeSchema.optional()
  })
  .refine((value) => !(value.returnToShell && value.closeOnSuccess), {
    message: 'A terminal cannot return to a shell and close on success'
  })

export const updateTerminalSchema = z.object({
  name: terminalNameSchema
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
        message: 'A source worktree is required when starting from current'
      })
    }
  })

export type ProductEventType =
  | 'project.created'
  | 'project.updated'
  | 'project.removed'
  | 'worktree.created'
  | 'worktree.updated'
  | 'worktree.removed'
  | 'terminal.created'
  | 'terminal.updated'
  | 'terminal.removed'
  | 'terminal.metadata'
  | 'terminal.controller_changed'
  | 'remove.started'
  | 'remove.completed'
  | 'remove.failed'

export interface ProductEvent {
  id: string
  type: ProductEventType
  at: string
  data: Record<string, unknown>
}
