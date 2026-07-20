import type {
  ApiErrorBody,
  OperationRecord,
  ProjectColor,
  ProjectRecord,
  RemovePreview,
  TerminalRecord,
  WorktreeRecord
} from '@tasktty/shared'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown
  ) {
    super(message)
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    }
  })
  const body = (await response.json().catch(() => ({}))) as T | ApiErrorBody
  if (!response.ok) {
    const error = (body as ApiErrorBody).error
    throw new ApiError(
      error?.code || 'HTTP_ERROR',
      error?.message || `HTTP ${response.status}`,
      response.status,
      error?.details
    )
  }

  return body as T
}

export const apiClient = {
  projects: async () =>
    (await api<{ projects: ProjectRecord[] }>('/api/projects')).projects,
  addProject: async (path: string) =>
    (
      await api<{ project: ProjectRecord }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ path })
      })
    ).project,
  updateProjectColor: async (projectId: string, color: ProjectColor | null) =>
    (
      await api<{ project: ProjectRecord }>(`/api/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ color })
      })
    ).project,
  worktreeDestination: async (projectId: string, name: string) =>
    (
      await api<{ destination: { name: string; path: string } }>(
        `/api/projects/${projectId}/worktree-destination?name=${encodeURIComponent(name)}`
      )
    ).destination,
  createWorktree: async (
    projectId: string,
    name: string,
    base: 'default' | 'current',
    sourceWorktreeId?: string
  ) =>
    api<{
      worktree: WorktreeRecord
      terminal: TerminalRecord | null
      terminalError: string | null
      setupError: string | null
    }>(`/api/projects/${projectId}/worktrees`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        base,
        initialTerminal: { name: 'Terminal' },
        ...(sourceWorktreeId ? { sourceWorktreeId } : {})
      })
    }),
  createTerminal: async (worktreeId: string, name: string, argv?: string[]) =>
    (
      await api<{ terminal: TerminalRecord }>(
        `/api/worktrees/${worktreeId}/terminals`,
        {
          method: 'POST',
          body: JSON.stringify({ name, ...(argv ? { argv } : {}) })
        }
      )
    ).terminal,
  renameTerminal: async (terminalId: string, name: string) =>
    (
      await api<{ terminal: TerminalRecord }>(`/api/terminals/${terminalId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name })
      })
    ).terminal,
  deleteTerminal: async (terminalId: string) =>
    api(`/api/terminals/${terminalId}`, { method: 'DELETE' }),
  removePreview: async (worktreeId: string) =>
    (
      await api<{ preview: RemovePreview }>(
        `/api/worktrees/${worktreeId}/remove-preview`
      )
    ).preview,
  removeWorktree: async (worktreeId: string, preview: RemovePreview) =>
    (
      await api<{ operation: OperationRecord }>(
        `/api/worktrees/${worktreeId}/remove`,
        {
          method: 'POST',
          body: JSON.stringify({
            confirmationToken: preview.confirmationToken,
            confirmDestructive: preview.warnings.length > 0
          })
        }
      )
    ).operation,
  login: (token: string) =>
    api('/api/auth/session', {
      method: 'POST',
      body: JSON.stringify({ token })
    })
}
