import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type {
  OperationRecord,
  PrInfo,
  ProjectRecord,
  WorktreeRecord
} from '@tasktty/shared'
import { inferWorktreeName } from './zed.js'

interface Migration {
  version: number
  sql: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 7,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repository_path TEXT NOT NULL UNIQUE,
        main_worktree_path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        color TEXT CHECK(color IS NULL OR color IN ('rose','orange','amber','emerald','cyan','blue','violet','pink')),
        repository_device TEXT NOT NULL,
        repository_inode TEXT NOT NULL,
        name_is_custom INTEGER NOT NULL DEFAULT 0 CHECK(name_is_custom IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX projects_fs_identity_idx
        ON projects(repository_device, repository_inode);

      CREATE TABLE worktrees (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE,
        git_worktree_key TEXT,
        head TEXT NOT NULL DEFAULT '',
        branch TEXT,
        detached INTEGER NOT NULL DEFAULT 0 CHECK(detached IN (0,1)),
        locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)),
        lock_reason TEXT,
        prunable INTEGER NOT NULL DEFAULT 0 CHECK(prunable IN (0,1)),
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
      CREATE INDEX worktrees_project_idx ON worktrees(project_id);
      CREATE UNIQUE INDEX worktrees_git_key_idx
        ON worktrees(project_id, git_worktree_key)
        WHERE git_worktree_key IS NOT NULL;

      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('finish','discard','project_cleanup','remove','external_remove')),
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
    `
  }
]

interface ProjectRow {
  id: string
  name: string
  repository_path: string
  main_worktree_path: string
  default_branch: string
  color: ProjectRecord['color']
  repository_device: string
  repository_inode: string
  name_is_custom: number
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
  git_worktree_key: string | null
  prunable: number
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
    MIGRATIONS.forEach(({ version, sql }) => {
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

  projectByFilesystemIdentity(
    device: string,
    inode: string
  ): ProjectRecord | null {
    const row = this.connection
      .prepare(
        'SELECT * FROM projects WHERE repository_device = ? AND repository_inode = ?'
      )
      .get(device, inode) as ProjectRow | undefined
    return row ? this.mapProject(row) : null
  }

  projectFilesystemMetadata(projectId: string): {
    device: string
    inode: string
    nameIsCustom: boolean
  } | null {
    const row = this.connection
      .prepare(
        `SELECT repository_device,repository_inode,name_is_custom
         FROM projects WHERE id=?`
      )
      .get(projectId) as
      | {
          repository_device: string
          repository_inode: string
          name_is_custom: number
        }
      | undefined
    return row
      ? {
          device: row.repository_device,
          inode: row.repository_inode,
          nameIsCustom: Boolean(row.name_is_custom)
        }
      : null
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
      availability: { state: 'available', message: null },
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
      prunable: Boolean(row.prunable),
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
