import { describe, expect, it } from 'vitest'
import type { ProjectRecord } from '@treeport/shared'
import {
  deepestProjectTarget,
  resolveWorkspaceRoute,
  targetForProject,
  targetForWorktree,
  terminalTarget,
  worktreeTarget
} from './workspace-navigation'

function projectGraph(): ProjectRecord[] {
  return [
    {
      id: 'project-a',
      name: 'A',
      worktrees: [
        {
          id: 'worktree-a',
          projectId: 'project-a',
          name: 'A worktree',
          terminals: [
            { id: 'terminal-a', worktreeId: 'worktree-a', name: 'A terminal' },
            { id: 'terminal-b', worktreeId: 'worktree-a', name: 'B terminal' }
          ]
        }
      ]
    },
    {
      id: 'project-b',
      name: 'B',
      worktrees: [
        {
          id: 'worktree-b',
          projectId: 'project-b',
          name: 'B worktree',
          terminals: [
            { id: 'terminal-c', worktreeId: 'worktree-b', name: 'C terminal' }
          ]
        }
      ]
    },
    { id: 'project-empty', name: 'Empty', worktrees: [] }
  ] as ProjectRecord[]
}

describe('workspace route resolution', () => {
  it('keeps a valid hierarchy and resolves nonempty parent routes to their deepest child', () => {
    const projects = projectGraph()
    const terminal = terminalTarget('project-a', 'worktree-a', 'terminal-b')

    expect(resolveWorkspaceRoute(projects, terminal.pathname).canonical).toBe(
      true
    )
    expect(
      resolveWorkspaceRoute(projects, '/projects/project-a').target
    ).toEqual(terminalTarget('project-a', 'worktree-a', 'terminal-a'))
    expect(
      resolveWorkspaceRoute(projects, '/projects/project-empty')
    ).toMatchObject({
      canonical: true,
      selection: { project: { id: 'project-empty' }, worktree: null }
    })
  })

  it('repairs mismatched descendants within the deepest valid ancestor', () => {
    const projects = projectGraph()

    expect(
      resolveWorkspaceRoute(
        projects,
        '/projects/project-a/worktrees/worktree-b/terminals/terminal-c'
      ).target
    ).toEqual(terminalTarget('project-a', 'worktree-a', 'terminal-a'))
    expect(
      resolveWorkspaceRoute(
        projects,
        '/projects/project-a/worktrees/worktree-a/terminals/terminal-c'
      ).target
    ).toEqual(terminalTarget('project-a', 'worktree-a', 'terminal-a'))
  })

  it('uses an exact valid resume hint only at root and otherwise falls back deterministically', () => {
    const projects = projectGraph()
    const resume = terminalTarget('project-b', 'worktree-b', 'terminal-c')

    expect(
      resolveWorkspaceRoute(projects, '/', resume.pathname).target
    ).toEqual(resume)
    expect(
      resolveWorkspaceRoute(
        projects,
        '/',
        '/projects/project-b/worktrees/worktree-b/terminals/missing'
      ).target
    ).toEqual(terminalTarget('project-b', 'worktree-b', 'terminal-c'))
    expect(
      resolveWorkspaceRoute(projects, '/', '/projects/missing').target
    ).toEqual(deepestProjectTarget(projects[0]!))
    expect(resolveWorkspaceRoute([], '/projects/missing').target).toEqual({
      kind: 'root',
      pathname: '/'
    })
  })

  it('returns to the last terminal used in a project', () => {
    const projects = projectGraph()

    expect(targetForProject(projects[0]!, 'terminal-b')).toEqual(
      terminalTarget('project-a', 'worktree-a', 'terminal-b')
    )
    expect(targetForProject(projects[0]!, 'terminal-c')).toEqual(
      terminalTarget('project-a', 'worktree-a', 'terminal-a')
    )
    expect(targetForProject(projects[2]!, 'terminal-a')).toEqual({
      kind: 'project',
      pathname: '/projects/project-empty',
      projectId: 'project-empty'
    })
  })

  it('preserves a current terminal only when selecting its containing worktree', () => {
    const projects = projectGraph()
    const firstWorktree = projects[0]!.worktrees[0]!
    const secondWorktree = projects[1]!.worktrees[0]!

    expect(targetForWorktree(projects, firstWorktree, 'terminal-b')).toEqual(
      terminalTarget('project-a', 'worktree-a', 'terminal-b')
    )
    expect(targetForWorktree(projects, secondWorktree, 'terminal-b')).toEqual(
      terminalTarget('project-b', 'worktree-b', 'terminal-c')
    )
  })

  it('keeps an empty worktree route canonical', () => {
    const projects = projectGraph()
    const emptyWorktree = {
      ...projects[0]!.worktrees[0]!,
      id: 'worktree-empty',
      terminals: []
    }
    projects[0] = {
      ...projects[0]!,
      worktrees: [emptyWorktree]
    }
    const target = worktreeTarget('project-a', 'worktree-empty')

    expect(resolveWorkspaceRoute(projects, target.pathname)).toMatchObject({
      canonical: true,
      target
    })
  })
})
