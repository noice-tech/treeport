import { queryOptions } from '@tanstack/react-query'
import { parseResponse, rpc } from './api'
import { METADATA_STALE_TIME_MS } from './metadata-sync'

export const projectsQueryKey = ['projects'] as const
export const recentProjectsQueryKey = ['recent-projects'] as const
export const launchersQueryKey = ['launchers'] as const

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

export const launchersQueryOptions = queryOptions({
  queryKey: launchersQueryKey,
  queryFn: async () =>
    (await parseResponse(rpc.api['launchers'].$get())).launchers,
  staleTime: 0,
  refetchInterval: 5_000,
  refetchOnReconnect: true,
  refetchOnWindowFocus: true
})

interface LauncherDefinitionsQuery {
  projectId?: string
  worktreeId?: string
}

export const launcherDefinitionsQueryOptions = (context?: {
  projectId?: string
  worktreeId?: string
}) =>
  queryOptions({
    queryKey: [
      'launcher-definitions',
      context?.worktreeId ?? context?.projectId ?? 'global'
    ] as const,
    queryFn: async () => {
      const query: LauncherDefinitionsQuery = {}

      if (context?.projectId) {
        query.projectId = context.projectId
      }

      if (context?.worktreeId) {
        query.worktreeId = context.worktreeId
      }

      return await parseResponse(
        rpc.api['launcher-definitions'].$get({ query })
      )
    },
    staleTime: 0,
    refetchInterval: 5_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true
  })
