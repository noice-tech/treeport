import { z } from "zod";

export const PRODUCT_NAME = "wtr";
export const API_VERSION = 1;

export type WorktreeKind = "main" | "linked";
export type WorktreeStatus = "active" | "cleaning" | "cleanup_failed" | "removed";
export type TerminalStatus = "running" | "exited" | "missing";
export type PrState = "no_pr" | "open" | "merged" | "closed" | "unknown";
export type OperationStatus = "pending" | "running" | "completed" | "failed";
export type OperationKind = "finish" | "discard" | "project_cleanup";

export interface PrInfo {
  state: PrState;
  number: number | null;
  url: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  mergedAt: string | null;
  refreshedAt: string | null;
}

export interface TerminalRecord {
  id: string;
  worktreeId: string;
  name: string;
  tmuxSessionName: string;
  argv: string[];
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeRecord {
  id: string;
  projectId: string;
  path: string;
  branch: string;
  kind: WorktreeKind;
  tmuxSocketName: string;
  status: WorktreeStatus;
  cleanupError: string | null;
  pr: PrInfo;
  dirty: DirtyState | null;
  terminals: TerminalRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  repositoryPath: string;
  mainWorktreePath: string;
  defaultBranch: string;
  worktrees: WorktreeRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface DirtyState {
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  total: number;
}

export interface FinishPreflight {
  worktreeId: string;
  branch: string;
  path: string;
  pr: PrInfo;
  gitMerged: boolean;
  dirty: DirtyState;
  eligible: boolean;
  reasons: string[];
  terminals: Array<Pick<TerminalRecord, "id" | "name" | "status">>;
}

export interface OperationRecord {
  id: string;
  kind: OperationKind;
  projectId: string | null;
  worktreeId: string | null;
  status: OperationStatus;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export const registerProjectSchema = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
});

export const createWorktreeSchema = z.object({
  branch: z.string().trim().min(1).max(240),
  fromCurrent: z.boolean().optional().default(false),
  sourceWorktreeId: z.string().min(1).optional(),
  initialTerminal: z
    .object({
      name: z.string().trim().min(1).max(120),
      argv: z.array(z.string()).min(1).optional(),
    })
    .optional(),
});

export const createTerminalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  argv: z.array(z.string()).min(1).max(128).optional(),
});

export const updateTerminalSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const discardSchema = z.object({
  confirm: z.string().min(1),
});

export const spawnSchema = z.object({
  project: z.string().min(1),
  branch: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(120),
  argv: z.array(z.string()).min(1).max(128).optional(),
  fromCurrent: z.boolean().optional().default(false),
  sourceWorktreeId: z.string().min(1).optional(),
});

export const cleanupSchema = z.object({ preview: z.boolean().optional().default(false) });

export type ProductEventType =
  | "project.created"
  | "project.updated"
  | "worktree.created"
  | "worktree.updated"
  | "worktree.removed"
  | "terminal.created"
  | "terminal.updated"
  | "terminal.removed"
  | "terminal.controller_changed"
  | "cleanup.started"
  | "cleanup.completed"
  | "cleanup.failed";

export interface ProductEvent {
  id: string;
  type: ProductEventType;
  at: string;
  data: Record<string, unknown>;
}

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "take_control" };

export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "control"; controller: boolean; controllerId: string | null }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };
