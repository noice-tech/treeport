import type { ProjectRecord } from '@treeport/shared'

export const project: ProjectRecord = {
  id: 'proj_1',
  name: 'example',
  kind: 'repository',
  rootPath: '/repo',
  repositoryPath: '/repo',
  mainWorktreePath: '/repo',
  defaultBranch: 'trunk',
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
      pr: {
        state: 'no_pr',
        number: null,
        url: null,
        baseBranch: null,
        headBranch: null,
        mergedAt: null,
        refreshedAt: null
      },
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
      panels: [],
      terminals: [
        {
          id: 'term_shell',
          worktreeId: 'wt_main',
          name: 'Shell',
          argv: ['/bin/zsh', '-l'],
          shellCommand: null,
          interactiveShell: true,
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
      pr: {
        state: 'merged',
        number: 12,
        url: 'https://example.test/pr/12',
        baseBranch: 'trunk',
        headBranch: 'feature/topic',
        mergedAt: '2026-01-02',
        refreshedAt: '2026-01-02'
      },
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
      panels: [],
      terminals: [
        {
          id: 'term_pi',
          worktreeId: 'wt_topic',
          name: 'Pi',
          argv: ['pi'],
          shellCommand: null,
          interactiveShell: false,
          status: 'running',
          exitCode: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01'
        }
      ]
    }
  ]
}
