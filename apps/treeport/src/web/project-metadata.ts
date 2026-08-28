import { queryOptions } from '@tanstack/react-query'
import { parseResponse } from 'hono/client'
import { rpc } from './api'
import { METADATA_STALE_TIME_MS } from './metadata-sync'

export const projectsQueryKey = ['projects'] as const
export const recentProjectsQueryKey = ['recent-projects'] as const
export const terminalPresetsQueryKey = ['terminal-presets'] as const

export const projectsQueryOptions = queryOptions({
  queryKey: projectsQueryKey,
  queryFn: async () => (await parseResponse(rpc.api.projects.$get())).projects,
  staleTime: METADATA_STALE_TIME_MS,
  refetchInterval: 5_000,
  refetchOnReconnect: true,
  refetchOnWindowFocus: true
})

export const recentProjectsQueryOptions = queryOptions({
  queryKey: recentProjectsQueryKey,
  queryFn: async () =>
    (await parseResponse(rpc.api.projects.recent.$get())).projects
})

export const terminalPresetsQueryOptions = queryOptions({
  queryKey: terminalPresetsQueryKey,
  queryFn: async () =>
    (await parseResponse(rpc.api['terminal-presets'].$get())).presets,
  staleTime: 0,
  refetchInterval: 5_000,
  refetchOnReconnect: true,
  refetchOnWindowFocus: true
})

export const treeContextFieldsQueryOptions = (projectId: string | null) =>
  queryOptions({
    queryKey: ['tree-context-fields', projectId ?? 'none'] as const,
    queryFn: async () =>
      await parseResponse(
        rpc.api['tree-context-fields'].$get({
          query: { projectId: projectId! }
        })
      ),
    enabled: projectId !== null,
    staleTime: 0,
    refetchInterval: 5_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true
  })

interface TerminalPresetDefinitionsQuery {
  projectId?: string
  worktreeId?: string
}

export const terminalPresetDefinitionsQueryOptions = (context?: {
  projectId?: string
  worktreeId?: string
}) =>
  queryOptions({
    queryKey: [
      'terminal-preset-definitions',
      context?.worktreeId ?? context?.projectId ?? 'global'
    ] as const,
    queryFn: async () => {
      const query: TerminalPresetDefinitionsQuery = {}
      if (context?.projectId) {
        query.projectId = context.projectId
      }

      if (context?.worktreeId) {
        query.worktreeId = context.worktreeId
      }

      return await parseResponse(
        rpc.api['terminal-preset-definitions'].$get({ query })
      )
    },
    staleTime: 0,
    refetchInterval: 5_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true
  })
