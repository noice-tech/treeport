import type {
  ApiErrorBody,
  OperationRecord,
  ProjectColor,
  ProjectRecord,
  RecentProjectRecord,
  RemovePreview,
  TerminalPreset,
  TerminalRecord,
  TerminalSize,
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
  recentProjects: async () =>
    (await api<{ projects: RecentProjectRecord[] }>('/api/projects/recent'))
      .projects,
  terminalPresets: async () =>
    (await api<{ presets: TerminalPreset[] }>('/api/terminal-presets')).presets,
  createTerminalPreset: async (
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'>
  ) =>
    (
      await api<{ preset: TerminalPreset }>('/api/terminal-presets', {
        method: 'POST',
        body: JSON.stringify(input)
      })
    ).preset,
  updateTerminalPreset: async (
    presetId: string,
    input: Pick<TerminalPreset, 'name' | 'executable' | 'args'>,
    expectedUpdatedAt: string
  ) =>
    (
      await api<{ preset: TerminalPreset }>(
        `/api/terminal-presets/${presetId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ ...input, expectedUpdatedAt })
        }
      )
    ).preset,
  deleteTerminalPreset: async (presetId: string, expectedUpdatedAt: string) =>
    api<{ ok: true }>(`/api/terminal-presets/${presetId}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedUpdatedAt })
    }),
  addProject: async (path: string) =>
    (
      await api<{ project: ProjectRecord }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ path })
      })
    ).project,
  openProject: async (projectId: string) =>
    (
      await api<{ project: ProjectRecord }>(`/api/projects/${projectId}/open`, {
        method: 'POST'
      })
    ).project,
  closeProject: async (projectId: string) =>
    api<{ ok: true }>(`/api/projects/${projectId}/close`, {
      method: 'POST'
    }),
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
    initialTerminal: {
      name: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
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
        initialTerminal,
        ...(sourceWorktreeId ? { sourceWorktreeId } : {})
      })
    }),
  createTerminal: async (
    worktreeId: string,
    name: string,
    argv?: string[],
    returnToShell = false,
    initialSize?: TerminalSize
  ) =>
    (
      await api<{ terminal: TerminalRecord }>(
        `/api/worktrees/${worktreeId}/terminals`,
        {
          method: 'POST',
          body: JSON.stringify({
            name,
            ...(argv ? { argv } : {}),
            ...(returnToShell ? { returnToShell: true } : {}),
            ...(initialSize ? { initialSize } : {})
          })
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
  acknowledgeTerminalBell: async (terminalId: string, sequence: number) =>
    api<{ ok: true }>(`/api/terminals/${terminalId}/bell/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ sequence })
    }),
  uploadTerminalFile: async (terminalId: string, file: File) => {
    const extension = /\.([a-z0-9]{1,16})$/i.exec(file.name)?.[1]
    return (
      await api<{ file: { path: string } }>(
        `/api/terminals/${terminalId}/files`,
        {
          method: 'POST',
          headers: {
            'content-type': file.type || 'application/octet-stream',
            ...(extension
              ? { 'x-tasktty-file-extension': extension.toLowerCase() }
              : {})
          },
          body: file
        }
      )
    ).file.path
  },
  removePreview: async (worktreeId: string) =>
    (
      await api<{ preview: RemovePreview }>(
        `/api/worktrees/${worktreeId}/remove-preview`
      )
    ).preview,
  removeWorktree: async (
    worktreeId: string,
    preview: RemovePreview,
    confirmDestructive: boolean
  ) =>
    (
      await api<{ operation: OperationRecord }>(
        `/api/worktrees/${worktreeId}/remove`,
        {
          method: 'POST',
          body: JSON.stringify({
            confirmationToken: preview.confirmationToken,
            confirmDestructive
          })
        }
      )
    ).operation
}
