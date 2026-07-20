import { describe, expect, it } from 'vitest'
import {
  detectDefaultBranch,
  parseDirtyStatus,
  parseWorktreePorcelain
} from './git.js'

describe('git parsing', () => {
  it('parses attached, detached, and locked worktrees with paths containing spaces', () => {
    const result = parseWorktreePorcelain(`worktree /tmp/main repo
HEAD abc123
branch refs/heads/trunk

worktree /tmp/worktrees/feature cache
HEAD def456
detached
locked editor owns it
`)
    expect(result).toEqual([
      {
        path: '/tmp/main repo',
        head: 'abc123',
        branch: 'trunk',
        bare: false,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false
      },
      {
        path: '/tmp/worktrees/feature cache',
        head: 'def456',
        branch: null,
        bare: false,
        detached: true,
        locked: true,
        lockReason: 'editor owns it',
        prunable: false
      }
    ])
  })

  it('detects a remote default branch without assuming main', () => {
    expect(detectDefaultBranch('refs/remotes/origin/trunk\n', 'fallback')).toBe(
      'trunk'
    )
    expect(detectDefaultBranch('', 'develop')).toBe('develop')
  })

  it('counts staged, unstaged, and untracked changes', () => {
    const dirty = parseDirtyStatus(
      'M  staged.ts\0 M unstaged.ts\0MM both.ts\0?? untracked file.txt\0'
    )
    expect(dirty).toEqual({
      dirty: true,
      staged: 2,
      unstaged: 2,
      untracked: 1,
      conflicts: 0,
      total: 5
    })
    expect(parseDirtyStatus('UU conflicted.ts\0').conflicts).toBe(1)
    expect(parseDirtyStatus('R  renamed.ts\0original.ts\0')).toMatchObject({
      staged: 1,
      unstaged: 0,
      total: 1
    })
    expect(parseDirtyStatus('')).toEqual({
      dirty: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
      total: 0
    })
  })
})
