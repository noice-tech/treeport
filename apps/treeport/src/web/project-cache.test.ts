import { describe, expect, it } from 'vitest'
import type { ProjectRecord, TerminalRecord } from '@treeport/shared'
import { removeProjectTerminal, upsertProjectTerminal } from './project-cache'

const terminal = {
  id: 'terminal',
  worktreeId: 'worktree',
  name: 'Shell',
  argv: ['/bin/sh'],
  shellCommand: null,
  interactiveShell: true,
  status: 'running',
  exitCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
} satisfies TerminalRecord

const projects = (terminals: TerminalRecord[] = []): ProjectRecord[] =>
  // SAFETY: The cache helpers read only these project and worktree fields.
  [
    {
      id: 'project',
      worktrees: [{ id: 'worktree', terminals }]
    }
  ] as ProjectRecord[]

describe('project terminal cache', () => {
  it('applies repeated terminal events without duplicates or refreshes', () => {
    const created = upsertProjectTerminal(projects(), 'worktree', terminal)
    const repeated = upsertProjectTerminal(created.projects, 'worktree', {
      ...terminal,
      updatedAt: '2026-01-01T00:00:01.000Z'
    })

    expect(repeated).toMatchObject({ found: true })
    expect(repeated.projects?.[0]?.worktrees[0]?.terminals).toEqual([
      { ...terminal, updatedAt: '2026-01-01T00:00:01.000Z' }
    ])

    const removed = removeProjectTerminal(
      repeated.projects,
      'worktree',
      terminal.id
    )
    const removedAgain = removeProjectTerminal(
      removed.projects,
      'worktree',
      terminal.id
    )
    expect(removed.worktreeFound).toBe(true)
    expect(removedAgain.worktreeFound).toBe(true)
    expect(removedAgain.projects).toBe(removed.projects)
  })
})
