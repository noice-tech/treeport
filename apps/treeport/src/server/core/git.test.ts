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
  it('shares review scans, bounds subprocesses, and caches only immutable patches', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-diff-load-'))
    const runner = new SpawnCommandRunner()
    const run = async (...args: string[]) => {
      const result = await runner.run({ executable: 'git', args, cwd })
      expect(result.exitCode, result.stderr).toBe(0)
    }
    try {
      await run('init', '-b', 'main')
      await run('config', 'user.name', 'Test')
      await run('config', 'user.email', 'test@example.test')
      const files = Array.from(
        { length: 20 },
        (_, index) => `file-${index}.txt`
      )
      await Promise.all(
        files.map((file) => fs.writeFile(path.join(cwd, file), 'base\n'))
      )
      await run('add', '.')
      await run('commit', '-m', 'base')
      await run('switch', '-c', 'feature')
      await Promise.all(
        files.map((file) => fs.appendFile(path.join(cwd, file), 'changed\n'))
      )
      let active = 0
      let peak = 0
      const recorded: string[][] = []
      const git = new GitAdapter({
        run: async (request) => {
          active++
          peak = Math.max(peak, active)
          recorded.push([...request.args])
          return runner.run(request).finally(() => {
            active--
          })
        }
      })
      const patches = await Promise.all(
        files.map((file) =>
          Effect.runPromise(
            git.worktreeFileDiff(cwd, 'main', file, 'uncommitted')
          )
        )
      )
      expect(
        patches.every((patch) => patch.unified?.includes('+changed'))
      ).toBe(true)
      // Six shared context commands (including the missing origin fallback),
      // then one patch per file, instead of ten commands per file.
      expect(recorded.length).toBe(26)
      expect(peak).toBeLessThanOrEqual(4)
      expect(recorded.filter((args) => args.includes('--cached'))).toHaveLength(
        0
      )
      recorded.length = 0
      const summaries = await Promise.all(
        Array.from({ length: 8 }, () =>
          Effect.runPromise(git.worktreeDiff(cwd, 'main', 'uncommitted'))
        )
      )
      expect(summaries.every((summary) => summary.files.length === 20)).toBe(
        true
      )
      expect(recorded).toHaveLength(10)
      await fs.appendFile(path.join(cwd, files[0]!), 'fresh\n')
      expect(
        (
          await Effect.runPromise(
            git.worktreeFileDiff(cwd, 'main', files[0]!, 'uncommitted')
          )
        ).unified
      ).toContain('+fresh')
      await run('add', '.')
      await run('commit', '-m', 'changes')
      const first = await Effect.runPromise(
        git.worktreeFileDiff(cwd, 'main', files[0]!, 'committed')
      )
      recorded.length = 0
      expect(
        await Effect.runPromise(
          git.worktreeFileDiff(cwd, 'main', files[0]!, 'committed')
        )
      ).toEqual(first)
      expect(recorded.some((args) => args.includes('--binary'))).toBe(false)
      await fs.appendFile(path.join(cwd, files[0]!), 'new commit\n')
      await run('add', '.')
      await run('commit', '-m', 'new head')
      expect(
        (
          await Effect.runPromise(
            git.worktreeFileDiff(cwd, 'main', files[0]!, 'committed')
          )
        ).unified
      ).toContain('+new commit')
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

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
      await fs.writeFile(path.join(cwd, 'reverted.txt'), 'base version\n')
      await run('add', 'old.txt', 'reverted.txt')
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
      expect(diff.lineCounts).toEqual({ additions: 2, deletions: 0 })
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

      await fs.writeFile(path.join(cwd, 'reverted.txt'), 'committed version\n')
      await run('add', 'reverted.txt')
      await run('commit', '-m', 'branch changes')
      await fs.writeFile(
        path.join(cwd, 'renamed.txt'),
        'rename me\nstaged only\n'
      )
      await run('add', 'renamed.txt')
      await fs.appendFile(path.join(cwd, 'renamed.txt'), 'unstaged only\n')
      await fs.writeFile(path.join(cwd, 'reverted.txt'), 'base version\n')

      const committed = await Effect.runPromise(
        git.worktreeDiff(cwd, 'main', 'committed')
      )
      const uncommitted = await Effect.runPromise(
        git.worktreeDiff(cwd, 'main', 'uncommitted')
      )
      const combined = await Effect.runPromise(git.worktreeDiff(cwd, 'main'))
      expect(committed.files.map((file) => file.path)).toEqual([
        'huge.txt',
        'renamed.txt',
        'reverted.txt'
      ])
      expect(uncommitted.files.map((file) => file.path)).toEqual([
        'renamed.txt',
        'reverted.txt',
        'untracked.txt'
      ])
      expect(combined.files.map((file) => file.path)).not.toContain(
        'reverted.txt'
      )
      expect(committed.lineCounts).toEqual({ additions: 2, deletions: 1 })
      expect(uncommitted.lineCounts).toEqual({ additions: 4, deletions: 1 })
      expect(combined.lineCounts).toEqual({ additions: 5, deletions: 1 })
      expect(uncommitted.baseCommit).toBe(committed.headCommit)
      expect(
        committed.files.find((file) => file.path === 'renamed.txt')
      ).toMatchObject({ previousPath: 'old.txt', status: 'renamed' })
      expect(
        uncommitted.files.find((file) => file.path === 'renamed.txt')
      ).toMatchObject({ previousPath: null, status: 'modified' })
      const committedPatch = await Effect.runPromise(
        git.worktreeFileDiff(cwd, 'main', 'renamed.txt', 'committed')
      )
      const localPatch = await Effect.runPromise(
        git.worktreeFileDiff(cwd, 'main', 'renamed.txt', 'uncommitted')
      )
      expect(committedPatch.unified).toContain('rename from old.txt')
      expect(committedPatch.unified).not.toContain('staged only')
      expect(localPatch.unified).toContain('+staged only')
      expect(localPatch.unified).toContain('+unstaged only')
      const revertedPatch = await Effect.runPromise(
        git.worktreeFileDiff(cwd, 'main', 'reverted.txt', 'committed')
      )
      expect(revertedPatch.unified).toContain('+committed version')
      const localRevertedPatch = await Effect.runPromise(
        git.worktreeFileDiff(cwd, 'main', 'reverted.txt', 'uncommitted')
      )
      expect(localRevertedPatch.unified).toContain('-committed version')
      expect(localRevertedPatch.unified).toContain('+base version')
      const untrackedPatch = await Effect.runPromise(
        git.worktreeFileDiff(cwd, 'main', 'untracked.txt', 'uncommitted')
      )
      expect(untrackedPatch.unified).toContain('+untracked')
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)
})
