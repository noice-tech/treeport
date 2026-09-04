import { describe, expect, it } from 'vitest'
import type { ProjectRecord, TerminalRecord } from '@treeport/shared'
import { removeProjectTerminal, upsertProjectTerminal } from './project-cache'

const terminal: TerminalRecord = {
  id: 'terminal-two',
  worktreeId: 'worktree-one',
  name: 'Shell',
  argv: ['/bin/sh'],
  shellCommand: null,
  interactiveShell: true,
  status: 'running',
  exitCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

function projects(): ProjectRecord[] {
  return [
    {
      id: 'project-one',
      name: 'Project',
      kind: 'folder',
      rootPath: '/project',
      repositoryPath: '/project',
      mainWorktreePath: '/project',
      defaultBranch: '',
      color: null,
      availability: { state: 'available', message: null },
      worktrees: [
        {
          id: 'worktree-one',
          projectId: 'project-one',
          name: 'Project',
          path: '/project',
          head: '',
          branch: null,
          detached: false,
          locked: false,
          lockReason: null,
          prunable: false,
          kind: 'folder',
          managedWrapperPath: null,
          pr: {
            state: 'unknown',
            number: null,
            url: null,
            baseBranch: null,
            headBranch: null,
            mergedAt: null,
            refreshedAt: null
          },
          dirty: null,
          terminals: [],
          panels: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ]
}

describe('project terminal cache', () => {
  it('applies event and response records idempotently', () => {
    const first = upsertProjectTerminal(
      projects(),
      'project-one',
      'worktree-one',
      terminal
    )
    const second = upsertProjectTerminal(
      first.projects,
      'project-one',
      'worktree-one',
      { ...terminal, updatedAt: '2026-01-01T00:00:01.000Z' }
    )

    expect(first.found).toBe(true)
    expect(second.found).toBe(true)
    expect(second.projects?.[0]?.worktrees[0]?.terminals).toEqual([
      { ...terminal, updatedAt: '2026-01-01T00:00:01.000Z' }
    ])
    expect(
      upsertProjectTerminal(
        second.projects,
        'missing-project',
        'worktree-one',
        terminal
      ).found
    ).toBe(false)
  })

  it('removes terminal records idempotently without changing unrelated cache data', () => {
    const initial = projects()
    initial[0]!.worktrees[0]!.terminals = [
      { ...terminal, id: 'terminal-one' },
      terminal
    ]
    const otherProject = structuredClone(initial[0]!)
    otherProject.id = 'project-two'
    otherProject.worktrees[0]!.id = 'worktree-two'
    otherProject.worktrees[0]!.projectId = otherProject.id
    otherProject.worktrees[0]!.terminals = [
      { ...terminal, id: 'terminal-other', worktreeId: 'worktree-two' }
    ]
    initial.push(otherProject)

    const first = removeProjectTerminal(initial, 'worktree-one', 'terminal-two')
    expect(first).toMatchObject({ worktreeFound: true, removed: true })
    expect(first.projects?.[0]?.worktrees[0]?.terminals).toEqual([
      { ...terminal, id: 'terminal-one' }
    ])
    expect(first.projects?.[1]).toBe(otherProject)

    const repeated = removeProjectTerminal(
      first.projects,
      'worktree-one',
      'terminal-two'
    )
    expect(repeated).toMatchObject({ worktreeFound: true, removed: false })
    expect(repeated.projects).toBe(first.projects)

    const missing = removeProjectTerminal(
      repeated.projects,
      'missing-worktree',
      'terminal-one'
    )
    expect(missing).toMatchObject({ worktreeFound: false, removed: false })
    expect(missing.projects).toBe(repeated.projects)
    expect(missing.projects?.[1]?.worktrees[0]?.terminals).toEqual([
      { ...terminal, id: 'terminal-other', worktreeId: 'worktree-two' }
    ])
  })
})
