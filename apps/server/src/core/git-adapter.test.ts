import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandRequest, CommandResult, CommandRunner } from './command'
import { GitAdapter } from './git'

const temporary: string[] = []
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
)

class FakeRunner implements CommandRunner {
  readonly calls: CommandRequest[] = []
  constructor(
    private readonly handler: (request: CommandRequest) => CommandResult
  ) {}
  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request)
    return this.handler(request)
  }
}

describe('GitAdapter', () => {
  it('canonicalizes a repository path through realpath and rev-parse', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty repo '))
    temporary.push(directory)
    const nested = path.join(directory, 'nested')
    await fs.mkdir(nested)
    const runner = new FakeRunner(() => ({
      stdout: `${directory}\n`,
      stderr: '',
      exitCode: 0
    }))
    const adapter = new GitAdapter(runner)
    await expect(adapter.canonicalizeRepositoryPath(nested)).resolves.toBe(
      await fs.realpath(directory)
    )
    expect(runner.calls[0]?.args).toEqual(['rev-parse', '--show-toplevel'])
    expect(runner.calls[0]?.cwd).toBe(await fs.realpath(nested))
  })

  it('uses the first porcelain worktree as the main checkout', async () => {
    const main = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty main '))
    const linked = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty linked '))
    temporary.push(main, linked)
    const runner = new FakeRunner(() => ({
      stdout: `worktree ${main}\nHEAD a\nbranch refs/heads/trunk\n\nworktree ${linked}\nHEAD b\nbranch refs/heads/topic\n`,
      stderr: '',
      exitCode: 0
    }))
    await expect(
      new GitAdapter(runner).resolveMainCheckout(linked)
    ).resolves.toBe(await fs.realpath(main))
  })

  it('uses the live remote HEAD instead of a stale local origin/HEAD for merge safety', async () => {
    const runner = new FakeRunner((request) => {
      if (request.args[0] === 'ls-remote') {
        return {
          stdout: 'ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n',
          stderr: '',
          exitCode: 0
        }
      }

      if (request.args[0] === 'fetch') {
        return { stdout: '', stderr: '', exitCode: 0 }
      }

      if (request.args[0] === 'merge-base') {
        return { stdout: '', stderr: '', exitCode: 0 }
      }

      throw new Error(`Unexpected command ${request.args.join(' ')}`)
    })
    await expect(
      new GitAdapter(runner).isMerged('/repo', 'topic')
    ).resolves.toBe(true)
    expect(runner.calls.find((call) => call.args[0] === 'fetch')?.args).toEqual(
      ['fetch', '--quiet', 'origin', 'trunk']
    )
  })

  it('fails merge ancestry closed when the remote default branch is unknown', async () => {
    const runner = new FakeRunner((request) => {
      if (
        request.args[0] === 'symbolic-ref' ||
        request.args[0] === 'ls-remote'
      ) {
        return { stdout: '', stderr: 'missing', exitCode: 1 }
      }

      throw new Error(`Unexpected command ${request.args.join(' ')}`)
    })
    await expect(
      new GitAdapter(runner).isMerged('/repo', 'topic')
    ).resolves.toBe(false)
    expect(runner.calls.some((call) => call.args[0] === 'fetch')).toBe(false)
  })

  it('checks detached reachability only against branches, tags, and remotes', async () => {
    const runner = new FakeRunner((request) => {
      expect(request.args).toEqual([
        'for-each-ref',
        '--contains',
        'abc123',
        '--format=%(refname)',
        'refs/heads',
        'refs/tags',
        'refs/remotes'
      ])
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    await expect(
      new GitAdapter(runner).isCommitReachable('/repo', 'abc123')
    ).resolves.toBe(false)
  })

  it('creates and removes detached worktrees with literal path argv', async () => {
    const runner = new FakeRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0
    }))
    const adapter = new GitAdapter(runner)
    await adapter.createDetachedWorktree(
      '/repo with spaces',
      '/worktrees/üñîçødé repo',
      'abc123'
    )
    await adapter.removeWorktree(
      '/repo with spaces',
      '/worktrees/üñîçødé repo',
      true
    )
    expect(runner.calls[0]).toMatchObject({
      cwd: '/repo with spaces',
      args: [
        'worktree',
        'add',
        '--detach',
        '--',
        '/worktrees/üñîçødé repo',
        'abc123'
      ]
    })
    expect(runner.calls[1]?.args).toEqual([
      'worktree',
      'remove',
      '--force',
      '--',
      '/worktrees/üñîçødé repo'
    ])
  })
})
