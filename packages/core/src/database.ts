import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type {
  OperationRecord,
  PrInfo,
  ProjectRecord,
  TerminalRecord,
  WorktreeRecord
} from '@tasktty/shared'
import { inferWorktreeName } from './zed.js'

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repository_path TEXT NOT NULL UNIQUE,
    main_worktree_path TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('main','linked')),
    tmux_socket_name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('active','cleaning','cleanup_failed','removed')),
    cleanup_error TEXT,
    pr_state TEXT NOT NULL DEFAULT 'unknown',
    pr_number INTEGER,
    pr_url TEXT,
    pr_base_branch TEXT,
    pr_head_branch TEXT,
    pr_merged_at TEXT,
    pr_refreshed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX worktrees_project_idx ON worktrees(project_id);
  CREATE TABLE terminals (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    tmux_session_name TEXT NOT NULL,
    argv_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','exited','missing')),
    exit_code INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(worktree_id, tmux_session_name)
  );
  CREATE INDEX terminals_worktree_idx ON terminals(worktree_id);
  CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('finish','discard','project_cleanup')),
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
    request_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX operations_worktree_idx ON operations(worktree_id);
  `,
  `
  ALTER TABLE worktrees RENAME TO worktrees_v1;
  CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    head TEXT NOT NULL DEFAULT '',
    branch TEXT,
    detached INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    lock_reason TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('main','linked')),
    tmux_socket_name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('active','cleaning','cleanup_failed','removed')),
    cleanup_error TEXT,
    managed_wrapper_path TEXT,
    pr_state TEXT NOT NULL DEFAULT 'unknown',
    pr_number INTEGER,
    pr_url TEXT,
    pr_base_branch TEXT,
    pr_head_branch TEXT,
    pr_merged_at TEXT,
    pr_refreshed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO worktrees(
    id,project_id,path,head,branch,detached,locked,lock_reason,kind,tmux_socket_name,status,
    cleanup_error,managed_wrapper_path,pr_state,pr_number,pr_url,pr_base_branch,pr_head_branch,
    pr_merged_at,pr_refreshed_at,created_at,updated_at
  )
  SELECT id,project_id,path,'',CASE WHEN branch='(detached)' THEN NULL ELSE branch END,
    CASE WHEN branch='(detached)' THEN 1 ELSE 0 END,0,NULL,kind,tmux_socket_name,status,
    cleanup_error,NULL,pr_state,pr_number,pr_url,pr_base_branch,pr_head_branch,pr_merged_at,
    pr_refreshed_at,created_at,updated_at
  FROM worktrees_v1;

  ALTER TABLE terminals RENAME TO terminals_v1;
  CREATE TABLE terminals (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    tmux_session_name TEXT NOT NULL,
    argv_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','exited','missing')),
    exit_code INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(worktree_id, tmux_session_name)
  );
  INSERT INTO terminals SELECT * FROM terminals_v1;

  ALTER TABLE operations RENAME TO operations_v1;
  CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('finish','discard','project_cleanup','remove')),
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
    request_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO operations SELECT * FROM operations_v1;

  DROP TABLE operations_v1;
  DROP TABLE terminals_v1;
  DROP TABLE worktrees_v1;
  CREATE INDEX worktrees_project_idx ON worktrees(project_id);
  CREATE INDEX terminals_worktree_idx ON terminals(worktree_id);
  CREATE INDEX operations_worktree_idx ON operations(worktree_id);
  `,
  `
  ALTER TABLE projects ADD COLUMN color TEXT
    CHECK(color IS NULL OR color IN ('rose','orange','amber','emerald','cyan','blue','violet','pink'));
  `
]

interface ProjectRow {
  id: string
  name: string
  repository_path: string
  main_worktree_path: string
  default_branch: string
  color: ProjectRecord['color']
  created_at: string
  updated_at: string
}
interface WorktreeRow {
  id: string
  project_id: string
  path: string
  head: string
  branch: string | null
  detached: number
  locked: number
  lock_reason: string | null
  kind: 'main' | 'linked'
  tmux_socket_name: string
  status: 'active' | 'cleaning' | 'cleanup_failed' | 'removed'
  cleanup_error: string | null
  managed_wrapper_path: string | null
  pr_state: PrInfo['state']
  pr_number: number | null
  pr_url: string | null
  pr_base_branch: string | null
  pr_head_branch: string | null
  pr_merged_at: string | null
  pr_refreshed_at: string | null
  created_at: string
  updated_at: string
}
interface TerminalRow {
  id: string
  worktree_id: string
  name: string
  tmux_session_name: string
  argv_json: string
  status: TerminalRecord['status']
  exit_code: number | null
  created_at: string
  updated_at: string
}
interface OperationRow {
  id: string
  kind: OperationRecord['kind']
  project_id: string | null
  worktree_id: string | null
  status: OperationRecord['status']
  request_json: string
  result_json: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export function serializeOperation(
  value: Record<string, unknown> | null
): string | null {
  return value === null ? null : JSON.stringify(value)
}

export function deserializeOperation(
  value: string | null
): Record<string, unknown> | null {
  return value === null ? null : (JSON.parse(value) as Record<string, unknown>)
}

export class TaskTTYDatabase {
  readonly connection: Database.Database

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    this.connection = new Database(filePath)
    this.connection.pragma('journal_mode = WAL')
    this.connection.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.connection.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'
    )
    const applied = new Set(
      (
        this.connection
          .prepare('SELECT version FROM schema_migrations')
          .all() as Array<{
          version: number
        }>
      ).map((row) => row.version)
    )
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1
      if (applied.has(version)) {
        return
      }

      this.connection.transaction(() => {
        this.connection.exec(sql)
        this.connection
          .prepare(
            'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)'
          )
          .run(version, new Date().toISOString())
      })()
    })
  }

  close(): void {
    this.connection.close()
  }

  projects(): ProjectRecord[] {
    const projects = this.connection
      .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE')
      .all() as ProjectRow[]
    return projects.map((project) => this.mapProject(project))
  }

  project(id: string): ProjectRecord | null {
    const row = this.connection
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined
    return row ? this.mapProject(row) : null
  }

  projectByPath(repositoryPath: string): ProjectRecord | null {
    const row = this.connection
      .prepare(
        'SELECT * FROM projects WHERE repository_path = ? OR main_worktree_path = ?'
      )
      .get(repositoryPath, repositoryPath) as ProjectRow | undefined
    return row ? this.mapProject(row) : null
  }

  worktree(id: string): WorktreeRecord | null {
    const row = this.connection
      .prepare('SELECT * FROM worktrees WHERE id = ?')
      .get(id) as WorktreeRow | undefined
    if (!row) {
      return null
    }

    const project = this.connection
      .prepare('SELECT main_worktree_path FROM projects WHERE id = ?')
      .get(row.project_id) as { main_worktree_path: string } | undefined
    return this.mapWorktree(row, project?.main_worktree_path ?? row.path)
  }

  worktreeByPath(worktreePath: string): WorktreeRecord | null {
    const row = this.connection
      .prepare("SELECT * FROM worktrees WHERE path = ? AND status != 'removed'")
      .get(worktreePath) as WorktreeRow | undefined
    if (!row) {
      return null
    }

    const project = this.connection
      .prepare('SELECT main_worktree_path FROM projects WHERE id = ?')
      .get(row.project_id) as { main_worktree_path: string } | undefined
    return this.mapWorktree(row, project?.main_worktree_path ?? row.path)
  }

  /** Legacy terminal rows are retained only for startup migration compatibility. */
  terminal(id: string): TerminalRecord | null {
    const row = this.connection
      .prepare('SELECT * FROM terminals WHERE id = ?')
      .get(id) as TerminalRow | undefined
    return row ? this.mapTerminal(row) : null
  }

  operation(id: string): OperationRecord | null {
    const row = this.connection
      .prepare('SELECT * FROM operations WHERE id = ?')
      .get(id) as OperationRow | undefined
    return row ? this.mapOperation(row) : null
  }

  private mapProject(row: ProjectRow): ProjectRecord {
    const worktrees = this.connection
      .prepare(
        "SELECT * FROM worktrees WHERE project_id = ? AND status != 'removed' ORDER BY kind, created_at"
      )
      .all(row.id) as WorktreeRow[]
    return {
      id: row.id,
      name: row.name,
      repositoryPath: row.repository_path,
      mainWorktreePath: row.main_worktree_path,
      defaultBranch: row.default_branch,
      color: row.color,
      worktrees: worktrees.map((worktree) =>
        this.mapWorktree(worktree, row.main_worktree_path)
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private mapWorktree(
    row: WorktreeRow,
    mainWorktreePath: string
  ): WorktreeRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      name: inferWorktreeName(mainWorktreePath, row.path, row.kind),
      path: row.path,
      head: row.head,
      branch: row.branch,
      detached: Boolean(row.detached),
      locked: Boolean(row.locked),
      lockReason: row.lock_reason,
      kind: row.kind,
      tmuxSocketName: row.tmux_socket_name,
      status: row.status,
      cleanupError: row.cleanup_error,
      managedWrapperPath: row.managed_wrapper_path,
      pr: {
        state: row.pr_state,
        number: row.pr_number,
        url: row.pr_url,
        baseBranch: row.pr_base_branch,
        headBranch: row.pr_head_branch,
        mergedAt: row.pr_merged_at,
        refreshedAt: row.pr_refreshed_at
      },
      dirty: null,
      terminals: [],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private mapTerminal(row: TerminalRow): TerminalRecord {
    return {
      id: row.id,
      worktreeId: row.worktree_id,
      name: row.name,
      tmuxSessionName: row.tmux_session_name,
      argv: JSON.parse(row.argv_json) as string[],
      status: row.status,
      exitCode: row.exit_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private mapOperation(row: OperationRow): OperationRecord {
    return {
      id: row.id,
      kind: row.kind,
      projectId: row.project_id,
      worktreeId: row.worktree_id,
      status: row.status,
      request: deserializeOperation(row.request_json) ?? {},
      result: deserializeOperation(row.result_json),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}
