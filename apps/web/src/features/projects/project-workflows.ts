import type { RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type { ProjectRecord, RecentProjectRecord } from '@tasktty/shared'
import { ApiError, apiClient } from '../../api.js'
import {
  projectsQueryKey,
  recentProjectsQueryKey
} from '../../project-metadata.js'
import { terminalSessions } from '../../terminal-session.js'
import type { WorkspaceTarget } from '../../workspace-navigation.js'
import { useWorkspaceNavigate } from '../../workspace-router-navigation.js'

export function useProjectWorkflows({
  projects,
  selectedProject,
  targetForProject,
  projectSwitcherTriggerRef,
  closeProjectUi,
  openedProjectUi,
  setError
}: {
  projects: ProjectRecord[]
  selectedProject: ProjectRecord | null
  targetForProject: (project: ProjectRecord) => WorkspaceTarget
  projectSwitcherTriggerRef: RefObject<HTMLButtonElement | null>
  closeProjectUi: () => void
  openedProjectUi: () => void
  setError: (value: string | null) => void
}) {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigateToWorkspace = useWorkspaceNavigate()
  const showError = (value: unknown) =>
    setError(value instanceof Error ? value.message : String(value))

  const closeProject = useMutation({
    mutationFn: (project: ProjectRecord) => apiClient.closeProject(project.id),
    onSuccess: async (_, closedProject) => {
      const currentProjects =
        queryClient.getQueryData<ProjectRecord[]>(projectsQueryKey) ?? projects
      const remainingProjects = currentProjects.filter(
        (project) => project.id !== closedProject.id
      )
      const closedProjectIndex = currentProjects.findIndex(
        (project) => project.id === closedProject.id
      )
      const fallbackProject =
        remainingProjects[
          Math.min(
            Math.max(closedProjectIndex, 0),
            remainingProjects.length - 1
          )
        ] ?? null
      const closedSelection = selectedProject?.id === closedProject.id
      if (closedSelection) {
        await navigateToWorkspace(
          fallbackProject
            ? targetForProject(fallbackProject)
            : { kind: 'root', pathname: '/' },
          true
        )
        closeProjectUi()
      }

      queryClient.setQueryData<ProjectRecord[]>(
        projectsQueryKey,
        remainingProjects
      )
      for (const terminal of closedProject.worktrees.flatMap(
        (worktree) => worktree.terminals
      )) {
        terminalSessions.forget(terminal.id)
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectsQueryKey }),
        queryClient.invalidateQueries({ queryKey: recentProjectsQueryKey })
      ])
      if (closedSelection || !remainingProjects.length) {
        window.requestAnimationFrame(() =>
          projectSwitcherTriggerRef.current?.focus()
        )
      }
    },
    onError: (mutationError) => {
      showError(mutationError)
      if (
        mutationError instanceof ApiError &&
        mutationError.code === 'PROJECT_CLOSE_FAILED'
      ) {
        void queryClient.invalidateQueries({ queryKey: projectsQueryKey })
      }
    }
  })

  const requestProjectClose = (project: ProjectRecord) => {
    const terminalCount = project.worktrees.reduce(
      (count, worktree) => count + worktree.terminals.length,
      0
    )
    if (
      terminalCount > 0 &&
      !window.confirm(
        `Close “${
          project.name
        }”? This will terminate ${terminalCount} TaskTTY terminal ${
          terminalCount === 1
            ? 'session and its process'
            : 'sessions and their processes'
        }. Git worktrees and files will remain on disk, and you can reopen the project from Recent projects.`
      )
    ) {
      return
    }

    closeProject.mutate(project)
  }

  const projectOpened = async (project: ProjectRecord) => {
    const replacesEmptyRoot = projects.length === 0 && location.pathname === '/'
    queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) => [
      ...(current ?? []).filter((candidate) => candidate.id !== project.id),
      project
    ])
    queryClient.setQueryData<RecentProjectRecord[]>(
      recentProjectsQueryKey,
      (current) => current?.filter((candidate) => candidate.id !== project.id)
    )
    await navigateToWorkspace(targetForProject(project), replacesEmptyRoot)
    openedProjectUi()
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectsQueryKey }),
      queryClient.invalidateQueries({ queryKey: recentProjectsQueryKey })
    ])
  }

  return {
    closingProjectId: closeProject.isPending
      ? (closeProject.variables?.id ?? null)
      : null,
    requestProjectClose,
    projectOpened
  }
}
