import { queryOptions } from '@tanstack/react-query'
import { apiClient } from './api.js'
import {
  METADATA_STALE_TIME_MS,
  metadataRetryDelay,
  shouldRetryMetadataQuery
} from './metadata-sync.js'

export const projectsQueryKey = ['projects'] as const
export const recentProjectsQueryKey = ['recent-projects'] as const
export const terminalPresetsQueryKey = ['terminal-presets'] as const

export const projectsQueryOptions = queryOptions({
  queryKey: projectsQueryKey,
  queryFn: apiClient.projects,
  staleTime: METADATA_STALE_TIME_MS,
  retry: shouldRetryMetadataQuery,
  retryDelay: metadataRetryDelay,
  refetchInterval: 5_000,
  refetchOnReconnect: true,
  refetchOnWindowFocus: true
})

export const recentProjectsQueryOptions = queryOptions({
  queryKey: recentProjectsQueryKey,
  queryFn: apiClient.recentProjects,
  retry: false
})

export const terminalPresetsQueryOptions = queryOptions({
  queryKey: terminalPresetsQueryKey,
  queryFn: apiClient.terminalPresets,
  staleTime: 0,
  refetchInterval: 5_000,
  refetchOnReconnect: true,
  refetchOnWindowFocus: true
})
