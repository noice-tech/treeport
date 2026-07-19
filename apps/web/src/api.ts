import type {
  ApiErrorBody,
  FinishPreflight,
  OperationRecord,
  ProjectRecord,
  TerminalRecord,
  WorktreeRecord,
} from "@wtr/shared";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T | ApiErrorBody;
  if (!response.ok) {
    const error = (body as ApiErrorBody).error;
    throw new ApiError(
      error?.code || "HTTP_ERROR",
      error?.message || `HTTP ${response.status}`,
      response.status,
      error?.details,
    );
  }
  return body as T;
}

export const apiClient = {
  projects: async () => (await api<{ projects: ProjectRecord[] }>("/api/projects")).projects,
  addProject: async (path: string) =>
    (
      await api<{ project: ProjectRecord }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ path }),
      })
    ).project,
  createWorktree: async (projectId: string, branch: string, fromCurrent: boolean) =>
    api<{
      worktree: WorktreeRecord;
      terminal: TerminalRecord | null;
      terminalError: string | null;
    }>(`/api/projects/${projectId}/worktrees`, {
      method: "POST",
      body: JSON.stringify({ branch, fromCurrent }),
    }),
  createTerminal: async (worktreeId: string, name: string, argv?: string[]) =>
    (
      await api<{ terminal: TerminalRecord }>(`/api/worktrees/${worktreeId}/terminals`, {
        method: "POST",
        body: JSON.stringify({ name, ...(argv ? { argv } : {}) }),
      })
    ).terminal,
  renameTerminal: async (terminalId: string, name: string) =>
    (
      await api<{ terminal: TerminalRecord }>(`/api/terminals/${terminalId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      })
    ).terminal,
  deleteTerminal: async (terminalId: string) =>
    api(`/api/terminals/${terminalId}`, { method: "DELETE" }),
  refreshPr: async (worktreeId: string) =>
    api(`/api/worktrees/${worktreeId}/pr/refresh`, { method: "POST", body: "{}" }),
  finishPreview: async (worktreeId: string) =>
    (await api<{ preview: FinishPreflight }>(`/api/worktrees/${worktreeId}/finish-preview`))
      .preview,
  discardPreview: async (worktreeId: string) =>
    (
      await api<{
        preview: FinishPreflight & { commits: { ahead: number; behind: number } | null };
      }>(`/api/worktrees/${worktreeId}/discard-preview`)
    ).preview,
  finish: async (worktreeId: string) =>
    (
      await api<{ operation: OperationRecord }>(`/api/worktrees/${worktreeId}/finish`, {
        method: "POST",
        body: "{}",
      })
    ).operation,
  discard: async (worktreeId: string, confirm: string) =>
    (
      await api<{ operation: OperationRecord }>(`/api/worktrees/${worktreeId}/discard`, {
        method: "POST",
        body: JSON.stringify({ confirm }),
      })
    ).operation,
  cleanupPreview: async (projectId: string) =>
    (await api<{ previews: FinishPreflight[] }>(`/api/projects/${projectId}/cleanup-preview`))
      .previews,
  cleanup: async (projectId: string) =>
    (
      await api<{ operation: OperationRecord }>(`/api/projects/${projectId}/cleanup`, {
        method: "POST",
        body: JSON.stringify({ preview: false }),
      })
    ).operation,
  diagnostics: () => api<Record<string, unknown>>("/api/diagnostics"),
  login: (token: string) =>
    api("/api/auth/session", { method: "POST", body: JSON.stringify({ token }) }),
};
