import { desc, sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable(
  'projects',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    repositoryPath: text('repository_path').notNull().unique(),
    mainWorktreePath: text('main_worktree_path').notNull(),
    defaultBranch: text('default_branch').notNull(),
    color: text(),
    repositoryDevice: text('repository_device').notNull(),
    repositoryInode: text('repository_inode').notNull(),
    nameIsCustom: integer('name_is_custom').notNull().default(0),
    isOpen: integer('is_open').notNull().default(1),
    lastOpenedAt: text('last_opened_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    check(
      'projects_color_check',
      sql`${table.color} IS NULL OR ${table.color} IN ('rose','orange','amber','emerald','cyan','blue','violet','pink')`
    ),
    check('projects_name_is_custom_check', sql`${table.nameIsCustom} IN (0,1)`),
    check('projects_is_open_check', sql`${table.isOpen} IN (0,1)`),
    uniqueIndex('projects_fs_identity_idx').on(
      table.repositoryDevice,
      table.repositoryInode
    ),
    index('projects_recent_idx').on(
      table.isOpen,
      desc(table.lastOpenedAt),
      table.id
    )
  ]
)

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text().primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text().notNull().unique(),
    gitWorktreeKey: text('git_worktree_key'),
    head: text().notNull().default(''),
    branch: text(),
    detached: integer().notNull().default(0),
    locked: integer().notNull().default(0),
    lockReason: text('lock_reason'),
    prunable: integer().notNull().default(0),
    kind: text().notNull(),
    tmuxSocketName: text('tmux_socket_name').notNull().unique(),
    status: text().notNull(),
    cleanupError: text('cleanup_error'),
    managedWrapperPath: text('managed_wrapper_path'),
    prState: text('pr_state').notNull().default('unknown'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    prBaseBranch: text('pr_base_branch'),
    prHeadBranch: text('pr_head_branch'),
    prMergedAt: text('pr_merged_at'),
    prRefreshedAt: text('pr_refreshed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    check('worktrees_detached_check', sql`${table.detached} IN (0,1)`),
    check('worktrees_locked_check', sql`${table.locked} IN (0,1)`),
    check('worktrees_prunable_check', sql`${table.prunable} IN (0,1)`),
    check('worktrees_kind_check', sql`${table.kind} IN ('main','linked')`),
    check(
      'worktrees_status_check',
      sql`${table.status} IN ('active','cleaning','cleanup_failed','removed')`
    ),
    index('worktrees_project_idx').on(table.projectId),
    uniqueIndex('worktrees_git_key_idx')
      .on(table.projectId, table.gitWorktreeKey)
      .where(sql`${table.gitWorktreeKey} IS NOT NULL`)
  ]
)

export const operations = sqliteTable(
  'operations',
  {
    id: text().primaryKey(),
    kind: text().notNull(),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null'
    }),
    worktreeId: text('worktree_id').references(() => worktrees.id, {
      onDelete: 'set null'
    }),
    status: text().notNull(),
    requestJson: text('request_json').notNull(),
    resultJson: text('result_json'),
    error: text(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    check(
      'operations_kind_check',
      sql`${table.kind} IN ('finish','discard','project_cleanup','remove','external_remove')`
    ),
    check(
      'operations_status_check',
      sql`${table.status} IN ('pending','running','completed','failed')`
    ),
    index('operations_worktree_idx').on(table.worktreeId)
  ]
)

export const terminalPresets = sqliteTable(
  'terminal_presets',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    executable: text().notNull(),
    argsJson: text('args_json').notNull(),
    closeOnSuccess: integer('close_on_success').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    check(
      'terminal_presets_close_on_success_check',
      sql`${table.closeOnSuccess} IN (0,1)`
    ),
    index('terminal_presets_order_idx').on(table.createdAt, table.id)
  ]
)
