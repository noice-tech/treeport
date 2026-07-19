import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  DirtyState,
  FinishPreflight,
  OperationKind,
  OperationRecord,
  PrInfo,
  ProjectRecord,
  TerminalRecord,
  WorktreeRecord,
} from "@wtr/shared";
import type { AppConfig } from "./config.js";
import { commandAvailable, type CommandRunner } from "./command.js";
import type { WtrDatabase } from "./database.js";
import { serializeOperation } from "./database.js";
import {
  assertCleanupTransition,
  assertDiscardConfirmation,
  DomainError,
  finishEligibility,
} from "./domain.js";
import { ProductEventBus } from "./events.js";
import type { GhAdapter } from "./gh.js";
import type { GitAdapter } from "./git.js";
import type { GtrAdapter } from "./gtr.js";
import type { TmuxAdapter } from "./tmux.js";
import { generateTmuxSessionName, generateTmuxSocketName } from "./tmux.js";

const now = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

interface ServiceDependencies {
  config: AppConfig;
  database: WtrDatabase;
  runner: CommandRunner;
  git: GitAdapter;
  gtr: GtrAdapter;
  tmux: TmuxAdapter;
  gh: GhAdapter;
  events?: ProductEventBus;
}

export interface CreateWorktreeResult {
  worktree: WorktreeRecord;
  terminal: TerminalRecord | null;
  terminalError: string | null;
}

export class WtrService {
  readonly events: ProductEventBus;
  private readonly worktreeLocks = new Set<string>();
  private readonly projectLocks = new Set<string>();

  constructor(private readonly deps: ServiceDependencies) {
    this.events = deps.events ?? new ProductEventBus();
  }

  get database(): WtrDatabase {
    return this.deps.database;
  }

  async initialize(): Promise<void> {
    await this.deps.tmux.initialize();
    const interrupted = this.deps.database.connection
      .prepare("SELECT id, worktree_id FROM operations WHERE status IN ('pending','running')")
      .all() as Array<{ id: string; worktree_id: string | null }>;
    const timestamp = now();
    const transaction = this.deps.database.connection.transaction(() => {
      for (const operation of interrupted) {
        this.deps.database.connection
          .prepare(
            "UPDATE operations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            "Daemon restarted before the operation completed; external state was preserved for retry",
            timestamp,
            operation.id,
          );
        if (operation.worktree_id) {
          this.deps.database.connection
            .prepare(
              "UPDATE worktrees SET status = 'cleanup_failed', cleanup_error = ?, updated_at = ? WHERE id = ? AND status = 'cleaning'",
            )
            .run(
              "Cleanup was interrupted by a daemon restart; inspect and retry",
              timestamp,
              operation.worktree_id,
            );
        }
      }
    });
    transaction();
    await this.reconcile();
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const projects = this.deps.database.projects();
    await Promise.all(
      projects.flatMap((project) =>
        project.worktrees.map(async (worktree) => {
          worktree.dirty = await this.deps.git.dirtyState(worktree.path).catch(() => null);
          await this.reconcileWorktreeTerminals(worktree);
        }),
      ),
    );
    return this.deps.database.projects().map((project) => ({
      ...project,
      worktrees: project.worktrees.map((worktree) => ({
        ...worktree,
        dirty:
          projects.flatMap((item) => item.worktrees).find((item) => item.id === worktree.id)
            ?.dirty ?? null,
      })),
    }));
  }

  getProject(projectId: string): ProjectRecord {
    const project = this.deps.database.project(projectId);
    if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    return project;
  }

  getWorktree(worktreeId: string): WorktreeRecord {
    const worktree = this.deps.database.worktree(worktreeId);
    if (!worktree || worktree.status === "removed")
      throw new DomainError("WORKTREE_NOT_FOUND", "Worktree not found", 404);
    return worktree;
  }

  getTerminal(terminalId: string): TerminalRecord {
    const terminal = this.deps.database.terminal(terminalId);
    if (!terminal) throw new DomainError("TERMINAL_NOT_FOUND", "Terminal not found", 404);
    return terminal;
  }

  getOperation(operationId: string): OperationRecord {
    const operation = this.deps.database.operation(operationId);
    if (!operation) throw new DomainError("OPERATION_NOT_FOUND", "Operation not found", 404);
    return operation;
  }

  async resolveProject(identifier: string): Promise<ProjectRecord> {
    const direct = this.deps.database.project(identifier);
    if (direct) return direct;
    const canonical = await fs
      .realpath(path.resolve(identifier))
      .catch(() => path.resolve(identifier));
    const projects = this.deps.database.projects();
    const match = projects.find(
      (project) =>
        isPathWithin(canonical, project.repositoryPath) ||
        project.worktrees.some((worktree) => isPathWithin(canonical, worktree.path)),
    );
    if (!match)
      throw new DomainError(
        "PROJECT_NOT_FOUND",
        `No registered project contains ${identifier}`,
        404,
      );
    return match;
  }

  async resolveWorktree(identifier: string): Promise<WorktreeRecord> {
    const direct = this.deps.database.worktree(identifier);
    if (direct && direct.status !== "removed") return direct;
    const canonical = await fs
      .realpath(path.resolve(identifier))
      .catch(() => path.resolve(identifier));
    const matches = this.deps.database
      .projects()
      .flatMap((project) => project.worktrees)
      .filter((worktree) => isPathWithin(canonical, worktree.path))
      .sort((a, b) => b.path.length - a.path.length);
    const match = matches[0];
    if (!match)
      throw new DomainError(
        "WORKTREE_NOT_FOUND",
        `No registered worktree contains ${identifier}`,
        404,
      );
    return match;
  }

  async registerProject(inputPath: string, requestedName?: string): Promise<ProjectRecord> {
    const checkout = await this.deps.git
      .canonicalizeRepositoryPath(inputPath)
      .catch((error: unknown) => {
        throw new DomainError(
          "NOT_A_GIT_REPOSITORY",
          error instanceof Error ? error.message : "Not a Git repository",
          400,
        );
      });
    const mainPath = await this.deps.git.resolveMainCheckout(checkout);
    const repositoryPath = await fs.realpath(mainPath);
    const existing = this.deps.database.projectByPath(repositoryPath);
    const timestamp = now();
    const projectId = existing?.id ?? id("proj");
    const defaultBranch = await this.deps.git.defaultBranch(repositoryPath);
    const name = requestedName?.trim() || existing?.name || path.basename(repositoryPath);
    this.deps.database.connection
      .prepare(
        `INSERT INTO projects(id,name,repository_path,main_worktree_path,default_branch,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(repository_path) DO UPDATE SET name=excluded.name, main_worktree_path=excluded.main_worktree_path,
           default_branch=excluded.default_branch, updated_at=excluded.updated_at`,
      )
      .run(
        projectId,
        name,
        repositoryPath,
        mainPath,
        defaultBranch,
        existing?.createdAt ?? timestamp,
        timestamp,
      );
    await this.importWorktrees(projectId, repositoryPath, mainPath);
    const project = this.getProject(projectId);
    this.events.publish(existing ? "project.updated" : "project.created", { projectId });
    return project;
  }

  async refreshProject(projectId: string): Promise<ProjectRecord> {
    if (this.projectLocks.has(projectId))
      throw new DomainError("PROJECT_BUSY", "Project is already being modified", 409);
    this.projectLocks.add(projectId);
    try {
      const project = this.getProject(projectId);
      await this.importWorktrees(project.id, project.repositoryPath, project.mainWorktreePath);
      const defaultBranch = await this.deps.git.defaultBranch(project.repositoryPath);
      this.deps.database.connection
        .prepare("UPDATE projects SET default_branch = ?, updated_at = ? WHERE id = ?")
        .run(defaultBranch, now(), projectId);
      await this.reconcile();
      this.events.publish("project.updated", { projectId });
      return this.getProject(projectId);
    } finally {
      this.projectLocks.delete(projectId);
    }
  }

  private async importWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
  ): Promise<void> {
    const discovered = await this.deps.git.listWorktrees(repositoryPath);
    const timestamp = now();
    const seen = new Set<string>();
    const insert = this.deps.database.connection.prepare(
      `INSERT INTO worktrees(id,project_id,path,branch,kind,tmux_socket_name,status,cleanup_error,created_at,updated_at)
       VALUES(?,?,?,?,?,?, 'active',NULL,?,?)
       ON CONFLICT(path) DO UPDATE SET project_id=excluded.project_id, branch=excluded.branch, kind=excluded.kind,
         status=CASE WHEN worktrees.status IN ('cleaning','cleanup_failed') THEN worktrees.status ELSE 'active' END,
         cleanup_error=CASE WHEN worktrees.status='cleanup_failed' THEN worktrees.cleanup_error ELSE NULL END,
         updated_at=excluded.updated_at`,
    );
    const transaction = this.deps.database.connection.transaction(() => {
      for (const item of discovered) {
        if (item.bare || item.prunable) continue;
        seen.add(item.path);
        const existing = this.deps.database.connection
          .prepare("SELECT id,created_at,tmux_socket_name FROM worktrees WHERE path=?")
          .get(item.path) as
          | { id: string; created_at: string; tmux_socket_name: string }
          | undefined;
        insert.run(
          existing?.id ?? id("wt"),
          projectId,
          item.path,
          item.branch,
          item.path === mainPath ? "main" : "linked",
          existing?.tmux_socket_name ?? generateTmuxSocketName(),
          existing?.created_at ?? timestamp,
          timestamp,
        );
      }
      const known = this.deps.database.connection
        .prepare(
          "SELECT id,path,status FROM worktrees WHERE project_id=? AND kind='linked' AND status!='removed'",
        )
        .all(projectId) as Array<{
        id: string;
        path: string;
        status: string;
      }>;
      for (const worktree of known) {
        if (
          !seen.has(worktree.path) &&
          worktree.status !== "cleaning" &&
          worktree.status !== "cleanup_failed"
        ) {
          this.deps.database.connection
            .prepare("UPDATE worktrees SET status='removed', updated_at=? WHERE id=?")
            .run(timestamp, worktree.id);
          this.deps.database.connection
            .prepare("UPDATE terminals SET status='missing', updated_at=? WHERE worktree_id=?")
            .run(timestamp, worktree.id);
        }
      }
    });
    transaction();
  }

  async createWorktree(
    projectId: string,
    branch: string,
    fromCurrent: boolean,
    initialTerminal?: { name: string; argv?: string[] },
    sourceWorktreeId?: string,
  ): Promise<CreateWorktreeResult> {
    if (this.projectLocks.has(projectId))
      throw new DomainError("PROJECT_BUSY", "Project is already being modified", 409);
    this.projectLocks.add(projectId);
    let worktreePath: string;
    let project: ProjectRecord;
    try {
      project = this.getProject(projectId);
      if (!(await this.deps.git.validateBranch(project.repositoryPath, branch))) {
        throw new DomainError("INVALID_BRANCH", `Invalid Git branch name: ${branch}`, 400);
      }
      project = this.getProject(projectId);
      if (
        project.worktrees.some(
          (worktree) => worktree.branch === branch && worktree.status !== "removed",
        )
      ) {
        throw new DomainError("WORKTREE_EXISTS", `A worktree for ${branch} already exists`, 409);
      }
      let sourcePath: string | undefined;
      if (fromCurrent && sourceWorktreeId) {
        const source = this.getWorktree(sourceWorktreeId);
        if (source.projectId !== projectId || source.status !== "active") {
          throw new DomainError(
            "INVALID_SOURCE_WORKTREE",
            "The source worktree must be active and belong to the project",
            400,
          );
        }
        sourcePath = source.path;
      }
      worktreePath = await this.deps.gtr.create(
        project.repositoryPath,
        branch,
        fromCurrent,
        sourcePath,
      );
      await this.importWorktrees(project.id, project.repositoryPath, project.mainWorktreePath);
    } finally {
      this.projectLocks.delete(projectId);
    }
    const worktree = this.deps.database.worktreeByPath(worktreePath);
    if (!worktree)
      throw new DomainError(
        "WORKTREE_DISCOVERY_FAILED",
        "git gtr succeeded but the worktree could not be discovered",
        500,
      );
    this.events.publish("worktree.created", { projectId, worktreeId: worktree.id });
    let terminal: TerminalRecord | null = null;
    let terminalError: string | null = null;
    if (initialTerminal) {
      try {
        terminal = await this.createTerminal(
          worktree.id,
          initialTerminal.name,
          initialTerminal.argv,
        );
      } catch (error) {
        terminalError = error instanceof Error ? error.message : String(error);
      }
    }
    return { worktree: this.getWorktree(worktree.id), terminal, terminalError };
  }

  async createTerminal(worktreeId: string, name: string, argv?: string[]): Promise<TerminalRecord> {
    const worktree = this.getWorktree(worktreeId);
    if (this.worktreeLocks.has(worktreeId) || worktree.status !== "active") {
      throw new DomainError(
        "WORKTREE_BUSY",
        "Cannot create a terminal while the worktree is cleaning or failed",
        409,
      );
    }
    this.worktreeLocks.add(worktreeId);
    const project = this.getProject(worktree.projectId);
    const terminalId = id("term");
    const sessionName = generateTmuxSessionName();
    const commandArgv = argv ? [...argv] : [this.deps.config.shell, "-l"];
    const timestamp = now();
    let inserted = false;
    try {
      this.deps.database.connection
        .prepare(
          `INSERT INTO terminals(id,worktree_id,name,tmux_session_name,argv_json,status,exit_code,created_at,updated_at)
           VALUES(?,?,?,?,?,'running',NULL,?,?)`,
        )
        .run(
          terminalId,
          worktreeId,
          name,
          sessionName,
          JSON.stringify(commandArgv),
          timestamp,
          timestamp,
        );
      inserted = true;
      await this.deps.tmux.createSession({
        socketName: worktree.tmuxSocketName,
        sessionName,
        terminalId,
        worktreeId,
        cwd: worktree.path,
        argv: commandArgv,
        env: {
          WTR_API_URL: this.deps.config.apiUrl,
          WTR_PROJECT_ID: project.id,
          WTR_WORKTREE_ID: worktree.id,
          WTR_TERMINAL_ID: terminalId,
        },
      });
    } catch (error) {
      if (inserted) {
        const state = await this.deps.tmux
          .sessionState(worktree.tmuxSocketName, sessionName)
          .catch(() => ({ status: "missing" as const, exitCode: null }));
        this.deps.database.connection
          .prepare("UPDATE terminals SET status=?,exit_code=?,updated_at=? WHERE id=?")
          .run(state.status, state.exitCode, now(), terminalId);
        this.events.publish("terminal.created", {
          projectId: project.id,
          worktreeId,
          terminalId,
          creationFailed: true,
        });
      }
      throw new DomainError(
        "TERMINAL_CREATE_FAILED",
        error instanceof Error ? error.message : String(error),
        500,
        inserted ? { terminalId } : undefined,
      );
    } finally {
      this.worktreeLocks.delete(worktreeId);
    }
    const terminal = this.getTerminal(terminalId);
    this.events.publish("terminal.created", { projectId: project.id, worktreeId, terminalId });
    return terminal;
  }

  async refreshTerminalStatus(terminalId: string): Promise<TerminalRecord> {
    const terminal = this.getTerminal(terminalId);
    const worktree = this.getWorktree(terminal.worktreeId);
    const state = await this.deps.tmux.sessionState(
      worktree.tmuxSocketName,
      terminal.tmuxSessionName,
    );
    if (state.status !== terminal.status || state.exitCode !== terminal.exitCode) {
      this.deps.database.connection
        .prepare("UPDATE terminals SET status=?,exit_code=?,updated_at=? WHERE id=?")
        .run(state.status, state.exitCode, now(), terminalId);
      this.events.publish("terminal.updated", { worktreeId: worktree.id, terminalId });
    }
    return this.getTerminal(terminalId);
  }

  async renameTerminal(terminalId: string, name: string): Promise<TerminalRecord> {
    this.getTerminal(terminalId);
    this.deps.database.connection
      .prepare("UPDATE terminals SET name=?, updated_at=? WHERE id=?")
      .run(name, now(), terminalId);
    const terminal = this.getTerminal(terminalId);
    this.events.publish("terminal.updated", { worktreeId: terminal.worktreeId, terminalId });
    return terminal;
  }

  async deleteTerminal(terminalId: string): Promise<void> {
    const terminal = this.getTerminal(terminalId);
    const worktree = this.deps.database.worktree(terminal.worktreeId);
    if (!worktree) throw new DomainError("WORKTREE_NOT_FOUND", "Worktree not found", 404);
    if (this.worktreeLocks.has(worktree.id))
      throw new DomainError("WORKTREE_BUSY", "Worktree is being modified", 409);
    this.worktreeLocks.add(worktree.id);
    try {
      await this.deps.tmux.killSession(
        worktree.tmuxSocketName,
        terminal.tmuxSessionName,
        terminal.id,
      );
      this.deps.database.connection.prepare("DELETE FROM terminals WHERE id=?").run(terminalId);
    } finally {
      this.worktreeLocks.delete(worktree.id);
    }
    this.events.publish("terminal.removed", { worktreeId: worktree.id, terminalId });
  }

  async refreshPr(worktreeId: string, force = false): Promise<PrInfo> {
    const worktree = this.getWorktree(worktreeId);
    if (worktree.kind === "main") return worktree.pr;
    const age = worktree.pr.refreshedAt
      ? Date.now() - Date.parse(worktree.pr.refreshedAt)
      : Number.POSITIVE_INFINITY;
    if (!force && age < 60_000) return worktree.pr;
    const pr = await this.deps.gh.pullRequest(worktree.path, worktree.branch);
    this.deps.database.connection
      .prepare(
        `UPDATE worktrees SET pr_state=?,pr_number=?,pr_url=?,pr_base_branch=?,pr_head_branch=?,pr_merged_at=?,pr_refreshed_at=?,updated_at=? WHERE id=?`,
      )
      .run(
        pr.state,
        pr.number,
        pr.url,
        pr.baseBranch,
        pr.headBranch,
        pr.mergedAt,
        pr.refreshedAt,
        now(),
        worktreeId,
      );
    this.events.publish("worktree.updated", { worktreeId });
    return pr;
  }

  async finishPreflight(worktreeId: string, refreshPr = true): Promise<FinishPreflight> {
    let worktree = this.getWorktree(worktreeId);
    if (refreshPr && worktree.kind === "linked") {
      await this.refreshPr(worktreeId, true);
      worktree = this.getWorktree(worktreeId);
    }
    const project = this.getProject(worktree.projectId);
    const dirty = await this.deps.git.dirtyState(worktree.path);
    const gitMerged =
      worktree.kind === "linked"
        ? await this.deps.git.isMerged(project.repositoryPath, worktree.branch)
        : false;
    const eligibility = finishEligibility({
      kind: worktree.kind,
      dirty,
      pr: worktree.pr,
      gitMerged,
    });
    return {
      worktreeId,
      branch: worktree.branch,
      path: worktree.path,
      pr: worktree.pr,
      gitMerged,
      dirty,
      eligible: eligibility.eligible,
      reasons: eligibility.reasons,
      terminals: worktree.terminals.map(({ id: terminalId, name, status }) => ({
        id: terminalId,
        name,
        status,
      })),
    };
  }

  async discardPreview(
    worktreeId: string,
  ): Promise<FinishPreflight & { commits: { ahead: number; behind: number } | null }> {
    const worktree = this.getWorktree(worktreeId);
    const project = this.getProject(worktree.projectId);
    const preflight = await this.finishPreflight(worktreeId, true);
    return {
      ...preflight,
      commits: await this.deps.git.commitSummary(
        project.repositoryPath,
        worktree.branch,
        project.defaultBranch,
      ),
    };
  }

  async beginFinish(worktreeId: string): Promise<OperationRecord> {
    const preflight = await this.finishPreflight(worktreeId, true);
    if (!preflight.eligible)
      throw new DomainError("FINISH_REFUSED", "Worktree is not safe to finish", 409, preflight);
    return this.prepareCleanup(worktreeId, "finish", { preflight }, false);
  }

  async beginDiscard(worktreeId: string, confirmation: string): Promise<OperationRecord> {
    const worktree = this.getWorktree(worktreeId);
    assertDiscardConfirmation(worktree.kind, worktree.branch, confirmation);
    const preview = await this.discardPreview(worktreeId);
    return this.prepareCleanup(worktreeId, "discard", { preview, confirmation }, true);
  }

  private prepareCleanup(
    worktreeId: string,
    kind: "finish" | "discard",
    request: Record<string, unknown>,
    force: boolean,
  ): OperationRecord {
    const worktree = this.getWorktree(worktreeId);
    if (this.worktreeLocks.has(worktreeId) || worktree.status === "cleaning") {
      throw new DomainError(
        "CLEANUP_IN_PROGRESS",
        "A cleanup operation is already running for this worktree",
        409,
      );
    }
    assertCleanupTransition(worktree.status, "cleaning");
    this.worktreeLocks.add(worktreeId);
    const operationId = id("op");
    const timestamp = now();
    const transaction = this.deps.database.connection.transaction(() => {
      this.deps.database.connection
        .prepare(
          `INSERT INTO operations(id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at)
           VALUES(?,?,?,?, 'pending',?,NULL,NULL,?,?)`,
        )
        .run(
          operationId,
          kind,
          worktree.projectId,
          worktreeId,
          serializeOperation(request),
          timestamp,
          timestamp,
        );
      this.deps.database.connection
        .prepare(
          "UPDATE worktrees SET status='cleaning', cleanup_error=NULL, updated_at=? WHERE id=?",
        )
        .run(timestamp, worktreeId);
    });
    transaction();
    this.events.publish("cleanup.started", { operationId, worktreeId, kind });
    setTimeout(() => void this.executeCleanup(operationId, force), 150).unref();
    return this.getOperation(operationId);
  }

  private async executeCleanup(operationId: string, force: boolean): Promise<void> {
    const operation = this.getOperation(operationId);
    if (!operation.worktreeId) return;
    const worktree = this.deps.database.worktree(operation.worktreeId);
    if (!worktree) return;
    const project = this.getProject(worktree.projectId);
    this.deps.database.connection
      .prepare("UPDATE operations SET status='running',updated_at=? WHERE id=?")
      .run(now(), operationId);
    try {
      await this.deps.tmux.killServer(worktree.tmuxSocketName);
      await this.deps.gtr.remove(project.repositoryPath, worktree.branch, {
        force,
        deleteBranch: true,
      });
      const timestamp = now();
      const transaction = this.deps.database.connection.transaction(() => {
        assertCleanupTransition("cleaning", "removed");
        this.deps.database.connection
          .prepare(
            "UPDATE worktrees SET status='removed',cleanup_error=NULL,updated_at=? WHERE id=?",
          )
          .run(timestamp, worktree.id);
        this.deps.database.connection
          .prepare("UPDATE terminals SET status='missing',updated_at=? WHERE worktree_id=?")
          .run(timestamp, worktree.id);
        this.deps.database.connection
          .prepare("UPDATE operations SET status='completed',result_json=?,updated_at=? WHERE id=?")
          .run(
            serializeOperation({ removed: true, branch: worktree.branch, path: worktree.path }),
            timestamp,
            operationId,
          );
      });
      transaction();
      this.events.publish("worktree.removed", { projectId: project.id, worktreeId: worktree.id });
      this.events.publish("cleanup.completed", { operationId, worktreeId: worktree.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timestamp = now();
      const transaction = this.deps.database.connection.transaction(() => {
        assertCleanupTransition("cleaning", "cleanup_failed");
        this.deps.database.connection
          .prepare(
            "UPDATE worktrees SET status='cleanup_failed',cleanup_error=?,updated_at=? WHERE id=?",
          )
          .run(message, timestamp, worktree.id);
        this.deps.database.connection
          .prepare("UPDATE operations SET status='failed',error=?,updated_at=? WHERE id=?")
          .run(message, timestamp, operationId);
      });
      transaction();
      await this.reconcileWorktreeTerminals(this.getWorktree(worktree.id));
      this.events.publish("cleanup.failed", {
        operationId,
        worktreeId: worktree.id,
        error: message,
      });
    } finally {
      this.worktreeLocks.delete(worktree.id);
    }
  }

  async cleanupPreview(projectId: string): Promise<FinishPreflight[]> {
    const project = this.getProject(projectId);
    const previews: FinishPreflight[] = [];
    for (const worktree of project.worktrees.filter(
      (item) => item.kind === "linked" && item.status !== "cleaning",
    )) {
      previews.push(await this.finishPreflight(worktree.id, true));
    }
    return previews;
  }

  async beginProjectCleanup(projectId: string): Promise<OperationRecord> {
    const previews = await this.cleanupPreview(projectId);
    const candidates = previews
      .filter((preview) => preview.eligible)
      .map((preview) => preview.worktreeId);
    const operationId = id("op");
    const timestamp = now();
    this.deps.database.connection
      .prepare(
        `INSERT INTO operations(id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at)
         VALUES(?,'project_cleanup',?,NULL,'pending',?,NULL,NULL,?,?)`,
      )
      .run(
        operationId,
        projectId,
        serializeOperation({ candidates, previews }),
        timestamp,
        timestamp,
      );
    setTimeout(() => void this.executeProjectCleanup(operationId, candidates), 150).unref();
    return this.getOperation(operationId);
  }

  private async executeProjectCleanup(operationId: string, worktreeIds: string[]): Promise<void> {
    this.deps.database.connection
      .prepare("UPDATE operations SET status='running',updated_at=? WHERE id=?")
      .run(now(), operationId);
    const children: string[] = [];
    const failures: string[] = [];
    for (const worktreeId of worktreeIds) {
      try {
        const child = this.prepareCleanup(
          worktreeId,
          "finish",
          { parentOperationId: operationId },
          false,
        );
        children.push(child.id);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const childId of children) {
      try {
        const child = await this.waitForOperation(childId);
        if (child.status === "failed")
          failures.push(`${child.id}: ${child.error ?? "cleanup failed"}`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    const timestamp = now();
    this.deps.database.connection
      .prepare("UPDATE operations SET status=?,result_json=?,error=?,updated_at=? WHERE id=?")
      .run(
        failures.length ? "failed" : "completed",
        serializeOperation({ childOperations: children }),
        failures.join("\n") || null,
        timestamp,
        operationId,
      );
  }

  private async waitForOperation(operationId: string): Promise<OperationRecord> {
    for (let attempt = 0; attempt < 6_000; attempt += 1) {
      const operation = this.getOperation(operationId);
      if (operation.status === "completed" || operation.status === "failed") return operation;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Cleanup operation ${operationId} did not complete within ten minutes`);
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = this.getProject(projectId);
    const linked = project.worktrees.filter((worktree) => worktree.kind === "linked");
    if (linked.length)
      throw new DomainError(
        "PROJECT_HAS_WORKTREES",
        "Remove linked worktrees before unregistering the project",
        409,
      );
    for (const worktree of project.worktrees)
      await this.deps.tmux.killServer(worktree.tmuxSocketName);
    this.deps.database.connection.prepare("DELETE FROM projects WHERE id=?").run(projectId);
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const [git, tmux, gtr, gh] = await Promise.all([
      commandAvailable(this.deps.runner, this.deps.config.gitPath, ["--version"]),
      commandAvailable(this.deps.runner, this.deps.config.tmuxPath, ["-V"]),
      this.deps.gtr.capabilities(true),
      this.deps.gh.diagnostics(),
    ]);
    return {
      nodeVersion: process.version,
      databasePath: this.deps.config.databasePath,
      registeredProjectCount: this.deps.database.projects().length,
      git,
      tmux,
      gtr,
      gh,
      defaultShell: this.deps.config.shell,
      bindAddress: `${this.deps.config.host}:${this.deps.config.port}`,
      authenticationEnabled: this.deps.config.authToken !== null,
      tailscale: { status: "unknown", managed: false },
    };
  }

  async reconcile(): Promise<void> {
    for (const project of this.deps.database.projects()) {
      try {
        await this.importWorktrees(project.id, project.repositoryPath, project.mainWorktreePath);
      } catch {
        // Keep metadata when a repository is temporarily unavailable.
      }
    }
    for (const project of this.deps.database.projects()) {
      for (const worktree of project.worktrees) await this.reconcileWorktreeTerminals(worktree);
    }
  }

  private async reconcileWorktreeTerminals(worktree: WorktreeRecord): Promise<void> {
    for (const terminal of worktree.terminals) {
      const state = await this.deps.tmux.sessionState(
        worktree.tmuxSocketName,
        terminal.tmuxSessionName,
      );
      if (state.status !== terminal.status || state.exitCode !== terminal.exitCode) {
        this.deps.database.connection
          .prepare("UPDATE terminals SET status=?,exit_code=?,updated_at=? WHERE id=?")
          .run(state.status, state.exitCode, now(), terminal.id);
        this.events.publish("terminal.updated", {
          worktreeId: worktree.id,
          terminalId: terminal.id,
        });
      }
    }
  }
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function preserveArgv(argv: readonly string[]): string[] {
  return [...argv];
}

export function operationKind(value: string): OperationKind {
  if (value === "finish" || value === "discard" || value === "project_cleanup") return value;
  throw new DomainError("INVALID_OPERATION_KIND", `Unknown operation kind: ${value}`);
}

export const emptyDirtyState = (): DirtyState => ({
  dirty: false,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  total: 0,
});
