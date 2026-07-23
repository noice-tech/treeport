import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { WorkspaceTarget } from './workspace-navigation.js'

export function useWorkspaceNavigate(): (
  target: WorkspaceTarget,
  replace?: boolean
) => Promise<void> {
  const navigate = useNavigate()
  return useCallback(
    (target: WorkspaceTarget, replace = false) => {
      switch (target.kind) {
        case 'root':
          return navigate({ to: '/', replace })
        case 'project':
          return navigate({
            to: '/projects/$projectId',
            params: { projectId: target.projectId },
            replace
          })
        case 'worktree':
          return navigate({
            to: '/projects/$projectId/worktrees/$worktreeId',
            params: {
              projectId: target.projectId,
              worktreeId: target.worktreeId
            },
            replace
          })
        case 'terminal':
          return navigate({
            to: '/projects/$projectId/worktrees/$worktreeId/terminals/$terminalId',
            params: {
              projectId: target.projectId,
              worktreeId: target.worktreeId,
              terminalId: target.terminalId
            },
            replace
          })
      }
    },
    [navigate]
  )
}
