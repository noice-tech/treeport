import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { SpawnCommandRunner } from './command'
import {
  detectDefaultBranch,
  GitAdapter,
  parseDirtyStatus,
  parseGitDiffFiles,
  parseWorktreePorcelain
} from './git'

describe('git parsing', () => {
  it('parses changed files and preserves rename origins', () => {
    expect(
      parseGitDiffFiles(
        'M\0src/a.ts\0R095\0old name.ts\0new name.ts\0A\0new.ts\0'
      )
    ).toEqual([
      { path: 'src/a.ts', previousPath: null, status: 'modified' },
      {
        path: 'new name.ts',
        previousPath: 'old name.ts',
        status: 'renamed'
      },
      { path: 'new.ts', previousPath: null, status: 'added' }
    ])
  })

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
        gitWorktreeKey: null,
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
        gitWorktreeKey: null,
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

describe('worktree review diff', () => {
  it('lists every changed file while returning an explicit bounded oversized patch', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-diff-'))
    const runner = new SpawnCommandRunner()
    const run = async (...args: string[]) => {
      const result = await runner.run({ executable: 'git', args, cwd })
      expect(result.exitCode, result.stderr).toBe(0)
    }

    try {
      await run('init', '-b', 'main')
      await run('config', 'user.name', 'Treeport Test')
      await run('config', 'user.email', 'treeport@example.test')
      await fs.writeFile(path.join(cwd, 'old.txt'), 'rename me\n')
      await run('add', 'old.txt')
      await run('commit', '-m', 'base')
      await run('switch', '-c', 'feature')
      await run('mv', 'old.txt', 'renamed.txt')
      await fs.writeFile(
        path.join(cwd, 'huge.txt'),
        `${'x'.repeat(3 * 1024 * 1024)}\n`
      )
      await run('add', 'huge.txt', 'renamed.txt')
      await fs.writeFile(path.join(cwd, 'untracked.txt'), 'untracked\n')

      const git = new GitAdapter(runner)
      const diff = await Effect.runPromise(git.worktreeDiff(cwd, 'main'))
      expect(diff.files).toEqual([
        { path: 'huge.txt', previousPath: null, status: 'added' },
        {
          path: 'renamed.txt',
          previousPath: 'old.txt',
          status: 'renamed'
        },
        {
          path: 'untracked.txt',
          previousPath: null,
          status: 'untracked'
        }
      ])
      expect(diff.changeSets.staged).toEqual(['huge.txt', 'renamed.txt'])
      expect(diff.changeSets.untracked).toEqual(['untracked.txt'])

      await expect(
        Effect.runPromise(git.worktreeFileDiff(cwd, 'main', 'huge.txt'))
      ).resolves.toMatchObject({
        path: 'huge.txt',
        status: 'oversized',
        unified: null
      })
      await expect(
        Effect.runPromise(git.worktreeFileDiff(cwd, 'main', 'renamed.txt'))
      ).resolves.toMatchObject({ status: 'ready' })
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)
})
