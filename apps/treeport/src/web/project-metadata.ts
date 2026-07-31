import { queryOptions } from '@tanstack/react-query'
import { apiClient } from './api'
import { METADATA_STALE_TIME_MS } from './metadata-sync'

export const projectsQueryKey = ['projects'] as const
export const recentProjectsQueryKey = ['recent-projects'] as const
export const terminalPresetsQueryKey = ['terminal-presets'] as const

export const projectsQueryOptions = queryOptions({
  queryKey: projectsQueryKey,
  queryFn: apiClient.projects,
  staleTime: METADATA_STALE_TIME_MS,
  refetchInterval: 5_000,
  refetchOnReconnect: true,
  refetchOnWindowFocus: true
})

export const recentProjectsQueryOptions = queryOptions({
  queryKey: recentProjectsQueryKey,
  queryFn: apiClient.recentProjects
})

export const terminalPresetsQueryOptions = queryOptions({
  queryKey: terminalPresetsQueryKey,
  queryFn: apiClient.terminalPresets,
  staleTime: 0,
  refetchInterval: 5_000,
  refetchOnReconnect: true,
  refetchOnWindowFocus: true
})
