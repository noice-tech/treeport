import type { ProjectRecord } from '@treeport/shared'

export const project: ProjectRecord = {
  id: 'proj_1',
  name: 'example',
  kind: 'repository',
  rootPath: '/repo',
  repositoryPath: '/repo',
  mainWorktreePath: '/repo',
  defaultBranch: 'trunk',
  originUrl: null,
  color: null,
  availability: { state: 'available' as const, message: null },
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  worktrees: [
    {
      id: 'wt_main',
      projectId: 'proj_1',
      name: 'main tree',
      path: '/repo',
      head: 'aaaaaaaa',
      branch: 'trunk',
      detached: false,
      locked: false,
      lockReason: null,
      prunable: false,
      kind: 'main',
      managedWrapperPath: null,
      title: null,
      decorations: [],
      dirty: {
        dirty: false,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0,
        total: 0
      },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      workspaceItems: [],
      terminals: [
        {
          id: 'term_shell',
          worktreeId: 'wt_main',
          name: 'Shell',
          command: null,
          status: 'running',
          exitCode: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01'
        }
      ]
    },
    {
      id: 'wt_topic',
      projectId: 'proj_1',
      name: 'topic',
      path: '/worktrees/topic',
      head: 'bbbbbbbb',
      branch: 'feature/topic',
      detached: false,
      locked: false,
      lockReason: null,
      prunable: false,
      kind: 'linked',
      managedWrapperPath: null,
      title: null,
      decorations: [],
      dirty: {
        dirty: false,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0,
        total: 0
      },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      workspaceItems: [],
      terminals: [
        {
          id: 'term_pi',
          worktreeId: 'wt_topic',
          name: 'Pi',
          command: 'pi',
          status: 'running',
          exitCode: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01'
        }
      ]
    }
  ]
}
