import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useSetTerminalFocusIntent } from './terminal-focus'
import type { WorkspaceTarget } from './workspace-navigation'

export function useWorkspaceNavigate(): (
  target: WorkspaceTarget,
  replace?: boolean,
  focusTerminal?: boolean
) => Promise<void> {
  const navigate = useNavigate()
  const setTerminalFocusIntent = useSetTerminalFocusIntent()
  return useCallback(
    (target: WorkspaceTarget, replace = false, focusTerminal = true) => {
      if (target.kind === 'terminal') {
        setTerminalFocusIntent(target.terminalId, focusTerminal)
      }

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
        case 'panel':
          return navigate({
            to: '/projects/$projectId/worktrees/$worktreeId/panels/$panelId',
            params: {
              projectId: target.projectId,
              worktreeId: target.worktreeId,
              panelId: target.panelId
            },
            replace
          })
      }
    },
    [navigate, setTerminalFocusIntent]
  )
}
