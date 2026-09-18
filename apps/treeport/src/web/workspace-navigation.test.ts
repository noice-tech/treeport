import { describe, expect, it } from 'vitest'
import type { ProjectRecord } from '@treeport/shared'
import {
  deepestProjectTarget,
  openRequestMatchesTerminal,
  openRequestMatchesWorkspace,
  tabTarget,
  resolveWorkspaceRoute,
  targetForTab,
  targetForProject,
  targetForWorktree,
  terminalTarget,
  worktreeTarget
} from './workspace-navigation'

function projectGraph(): ProjectRecord[] {
  // SAFETY: The test fixture provides the asserted contract used here.
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
          ],
          tabs: [
            {
              id: 'tab-a',
              kind: 'web',
              worktreeId: 'worktree-a',
              definitionId: 'project:review',
              title: 'Review'
            },
            {
              id: 'tab-browser',
              kind: 'browser',
              worktreeId: 'worktree-a',
              title: 'Example',
              url: 'https://example.com/'
            }
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
  it('targets only clients that show the source terminal or Browser', () => {
    expect(openRequestMatchesTerminal('terminal-a', 'terminal-a')).toBe(true)
    expect(openRequestMatchesTerminal('terminal-a', 'terminal-b')).toBe(false)
    expect(openRequestMatchesTerminal(null, 'terminal-a')).toBe(false)
    expect(openRequestMatchesTerminal(null, null)).toBe(false)
    expect(
      openRequestMatchesWorkspace(null, 'tab-source', null, 'tab-source')
    ).toBe(true)
    expect(
      openRequestMatchesWorkspace(null, 'tab-source', null, 'tab-other')
    ).toBe(false)
  })

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

  it('selects WebPanel and BrowserTab routes without a terminal and repairs stale routes', () => {
    const projects = projectGraph()
    const tab = projects[0]!.worktrees[0]!.tabs.find(
      (candidate) => candidate.kind === 'web'
    )!
    const target = tabTarget('project-a', 'worktree-a', 'tab-a')

    expect(resolveWorkspaceRoute(projects, target.pathname)).toMatchObject({
      canonical: true,
      target,
      selection: { terminal: null, tab: { id: 'tab-a' } }
    })
    expect(targetForTab(projects, tab)).toEqual(target)
    const browser = projects[0]!.worktrees[0]!.tabs.find(
      (candidate) => candidate.kind === 'browser'
    )!
    const browserTarget = tabTarget('project-a', 'worktree-a', 'tab-browser')
    expect(targetForTab(projects, browser)).toEqual(browserTarget)
    expect(
      resolveWorkspaceRoute(projects, browserTarget.pathname).selection.tab
    ).toMatchObject({ kind: 'browser', url: 'https://example.com/' })
    expect(
      resolveWorkspaceRoute(
        projects,
        '/projects/project-a/worktrees/worktree-a/tabs/missing'
      ).target
    ).toEqual(terminalTarget('project-a', 'worktree-a', 'terminal-a'))
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
    expect(
      resolveWorkspaceRoute(
        projects,
        '/projects/project-a/worktrees/worktree-empty/tabs/missing'
      ).target
    ).toEqual(target)
  })
})
