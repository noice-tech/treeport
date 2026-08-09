import { queryOptions } from '@tanstack/react-query'
import { parseRpcResponse, rpc } from './api'
import { METADATA_STALE_TIME_MS } from './metadata-sync'

export const projectsQueryKey = ['projects'] as const
export const recentProjectsQueryKey = ['recent-projects'] as const
export const terminalPresetsQueryKey = ['terminal-presets'] as const

export const projectsQueryOptions = queryOptions({
  queryKey: projectsQueryKey,
  queryFn: async () =>
    (await parseRpcResponse(rpc.api.projects.$get())).projects,
  staleTime: METADATA_STALE_TIME_MS,
  refetchInterval: 5_000,
  refetchOnReconnect: true,
  refetchOnWindowFocus: true
})

export const recentProjectsQueryOptions = queryOptions({
  queryKey: recentProjectsQueryKey,
  queryFn: async () =>
    (await parseRpcResponse(rpc.api.projects.recent.$get())).projects
})

export const terminalPresetsQueryOptions = queryOptions({
  queryKey: terminalPresetsQueryKey,
  queryFn: async () =>
    (await parseRpcResponse(rpc.api['terminal-presets'].$get())).presets,
  staleTime: 0,
  refetchInterval: 5_000,
  refetchOnReconnect: true,
  refetchOnWindowFocus: true
})

export const terminalPresetDefinitionsQueryOptions = (projectId?: string) =>
  queryOptions({
    queryKey: ['terminal-preset-definitions', projectId ?? 'global'] as const,
    queryFn: async () =>
      (
        await parseRpcResponse(
          rpc.api['terminal-preset-definitions'].$get({
            query: { ...(projectId ? { projectId } : {}) }
          })
        )
      ).definitions,
    staleTime: 0,
    refetchInterval: 5_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true
  })
