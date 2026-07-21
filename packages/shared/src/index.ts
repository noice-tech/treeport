import { z } from 'zod'

export * from './terminal-protocol.js'

export const PRODUCT_NAME = 'TaskTTY'
export const API_VERSION = 1
export const TERMINAL_MAX_UPLOAD_BYTES = 50 * 1024 * 1024

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

export const registerProjectSchema = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional()
})

export const updateProjectSchema = z.object({
  color: z.enum(PROJECT_COLORS).nullable()
})

const initialTerminalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  argv: z.array(z.string()).min(1).optional()
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

export const createTerminalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  argv: z.array(z.string()).min(1).max(128).optional()
})

export const updateTerminalSchema = z.object({
  name: z.string().trim().min(1).max(120)
})

export const removeWorktreeSchema = z.object({
  confirmationToken: z.string().length(64),
  confirmDestructive: z.boolean()
})

export const spawnSchema = z
  .object({
    project: z.string().min(1),
    worktreeName: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(120),
    argv: z.array(z.string()).min(1).max(128).optional(),
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
