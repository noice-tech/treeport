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
    kind: text('project_kind', { enum: ['repository', 'folder'] })
      .notNull()
      .default('repository'),
    repositoryPath: text('repository_path').notNull().unique(),
    mainWorktreePath: text('main_worktree_path').notNull(),
    defaultBranch: text('default_branch').notNull(),
    color: text(),
    repositoryIdentity: text('repository_identity'),
    repositoryDevice: text('repository_device').notNull(),
    repositoryInode: text('repository_inode').notNull(),
    nameIsCustom: integer('name_is_custom').notNull().default(0),
    isOpen: integer('is_open').notNull().default(1),
    showInRecents: integer('show_in_recents').notNull().default(0),
    lastOpenedAt: text('last_opened_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    check('projects_kind_check', sql`${table.kind} IN ('repository','folder')`),
    check(
      'projects_color_check',
      sql`${table.color} IS NULL OR ${table.color} IN ('rose','orange','amber','emerald','cyan','blue','violet','pink')`
    ),
    check('projects_name_is_custom_check', sql`${table.nameIsCustom} IN (0,1)`),
    check('projects_is_open_check', sql`${table.isOpen} IN (0,1)`),
    check(
      'projects_show_in_recents_check',
      sql`${table.showInRecents} IN (0,1)`
    ),
    uniqueIndex('projects_repository_identity_idx')
      .on(table.repositoryIdentity)
      .where(sql`${table.repositoryIdentity} IS NOT NULL`),
    index('projects_recent_idx').on(
      table.isOpen,
      table.showInRecents,
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
    managedWrapperPath: text('managed_wrapper_path'),
    treeContextJson: text('tree_context_json').notNull().default('{}'),
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
    check(
      'worktrees_kind_check',
      sql`${table.kind} IN ('main','linked','folder')`
    ),
    index('worktrees_project_idx').on(table.projectId),
    uniqueIndex('worktrees_git_key_idx')
      .on(table.projectId, table.gitWorktreeKey)
      .where(sql`${table.gitWorktreeKey} IS NOT NULL`)
  ]
)

export const terminalBellStates = sqliteTable(
  'terminal_bell_states',
  {
    terminalId: text('terminal_id').primaryKey(),
    worktreeId: text('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    sequence: integer().notNull(),
    occurredAt: text('occurred_at').notNull(),
    unread: integer().notNull()
  },
  (table) => [
    check('terminal_bell_states_sequence_check', sql`${table.sequence} > 0`),
    check('terminal_bell_states_unread_check', sql`${table.unread} IN (0,1)`)
  ]
)

export const workspaceItemOrders = sqliteTable(
  'workspace_item_orders',
  {
    worktreeId: text('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    surface: text({ enum: ['terminal', 'tool'] }).notNull(),
    itemId: text('item_id').notNull(),
    position: integer().notNull()
  },
  (table) => [
    uniqueIndex('workspace_item_orders_item_idx').on(
      table.surface,
      table.itemId
    ),
    check(
      'workspace_item_orders_surface_check',
      sql`${table.surface} IN ('terminal','tool')`
    ),
    check('workspace_item_orders_position_check', sql`${table.position} >= 0`),
    index('workspace_item_orders_worktree_idx').on(
      table.worktreeId,
      table.surface,
      table.position
    )
  ]
)

export const browserPanels = sqliteTable(
  'browser_panels',
  {
    id: text().primaryKey(),
    worktreeId: text('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    url: text().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('browser_panels_worktree_order_idx').on(
      table.worktreeId,
      table.createdAt,
      table.id
    )
  ]
)

export const webPanels = sqliteTable(
  'web_panels',
  {
    id: text().primaryKey(),
    worktreeId: text('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    definitionId: text('definition_id').notNull(),
    title: text().notNull(),
    inputJson: text('input_json').notNull().default('null'),
    launchCwd: text('launch_cwd'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('web_panels_worktree_order_idx').on(
      table.worktreeId,
      table.createdAt,
      table.id
    )
  ]
)

export const webPanelPermissionGrants = sqliteTable(
  'web_panel_permission_grants',
  {
    sourceKey: text('source_key').primaryKey(),
    definitionId: text('definition_id').notNull(),
    permissionsJson: text('permissions_json').notNull(),
    grantedAt: text('granted_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('web_panel_permission_definition_idx').on(table.definitionId)
  ]
)

export const webPanelStorage = sqliteTable(
  'web_panel_storage',
  {
    panelId: text('panel_id')
      .notNull()
      .references(() => webPanels.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    valueJson: text('value_json').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    uniqueIndex('web_panel_storage_panel_key_idx').on(table.panelId, table.key)
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
      sql`${table.kind} IN ('create','finish','discard','project_cleanup','remove','external_remove')`
    ),
    check(
      'operations_status_check',
      sql`${table.status} IN ('pending','running','completed','failed')`
    ),
    index('operations_worktree_idx').on(table.worktreeId),
    index('operations_project_kind_status_idx').on(
      table.projectId,
      table.kind,
      table.status
    )
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
