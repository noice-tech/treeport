import type { RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type { ProjectRecord, RecentProjectRecord } from '@treeport/shared'
import { parseResponse } from 'hono/client'
import { rpc } from '../../api'
import { errorDetails } from '../../error-message'
import {
  projectsQueryKey,
  recentProjectsQueryKey
} from '../../project-metadata'
import { terminalSessions } from '../../terminal-session'
import type { WorkspaceTarget } from '../../workspace-navigation'
import { useWorkspaceNavigate } from '../../workspace-router-navigation'
import { notifyError } from '../notifications/error-notifications'

export function useProjectWorkflows({
  projects,
  selectedProject,
  targetForProject,
  projectSwitcherTriggerRef,
  closeProjectUi,
  openedProjectUi
}: {
  projects: ProjectRecord[]
  selectedProject: ProjectRecord | null
  targetForProject: (project: ProjectRecord) => WorkspaceTarget
  projectSwitcherTriggerRef: RefObject<HTMLButtonElement | null>
  closeProjectUi: () => void
  openedProjectUi: () => void
}) {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigateToWorkspace = useWorkspaceNavigate()
  const closeProject = useMutation({
    mutationFn: (project: ProjectRecord) =>
      parseResponse(
        rpc.api.projects[':projectId'].close.$post({
          param: { projectId: project.id }
        })
      ),
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
    onError: (mutationError, project) => {
      notifyError(mutationError, {
        operation: `close project “${project.name}”`
      })
      if (errorDetails(mutationError).code === 'PROJECT_CLOSE_FAILED') {
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
        }”? This will terminate ${terminalCount} Treeport terminal ${
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

  const projectOpened = async (
    project: ProjectRecord,
    focusTerminal = true
  ) => {
    const replacesEmptyRoot = projects.length === 0 && location.pathname === '/'
    queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) => [
      ...(current ?? []).filter((candidate) => candidate.id !== project.id),
      project
    ])
    queryClient.setQueryData<RecentProjectRecord[]>(
      recentProjectsQueryKey,
      (current) => current?.filter((candidate) => candidate.id !== project.id)
    )
    await navigateToWorkspace(
      targetForProject(project),
      replacesEmptyRoot,
      focusTerminal
    )
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectsQueryKey }),
      queryClient.invalidateQueries({ queryKey: recentProjectsQueryKey })
    ])
    openedProjectUi()
  }

  return {
    closingProjectId: closeProject.isPending
      ? (closeProject.variables?.id ?? null)
      : null,
    requestProjectClose,
    projectOpened
  }
}
