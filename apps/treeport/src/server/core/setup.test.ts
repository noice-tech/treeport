import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandRequest, CommandResult, CommandRunner } from './command'
import {
  resolveWorktreeSetupTasks,
  runWorktreeSetupTasks,
  type WorktreeSetupTask
} from './setup'

const temporary: string[] = []
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
)

async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-setup-'))
  temporary.push(root)
  const main = path.join(root, 'main checkout')
  const worktree = path.join(root, 'worktrees', 'topic', 'main checkout')
  await fs.mkdir(path.join(main, '.treeport'), { recursive: true })
  await fs.mkdir(worktree, { recursive: true })
  return {
    main: await fs.realpath(main),
    worktree: await fs.realpath(worktree)
  }
}

class Runner implements CommandRunner {
  calls: CommandRequest[] = []
  results: CommandResult[] = []

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request)
    return this.results.shift() ?? { stdout: '', stderr: '', exitCode: 0 }
  }
}

describe('worktree setup', () => {
  it('resolves native JSONC commands as direct setup tasks', async () => {
    const { main, worktree } = await repository()
    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      `{
        // Commands are direct argv, not shell snippets.
        "version": 1,
        "commands": [
          {
            "name": "  Generate code  ",
            "argv": ["node", "a b", "semi;colon", "$HOME", "\${UNKNOWN}", "\${TREEPORT_WORKTREE_PATH}/input"],
            "cwd": "\${TREEPORT_WORKTREE_PATH}/packages/api",
            "env": {
              "CACHE": "\${TREEPORT_MAIN_WORKTREE_PATH}/.cache",
              "UNCHANGED": "\${OTHER}"
            },
          },
          {
            "name": "Copy environment",
            "argv": ["cp", "\${TREEPORT_MAIN_WORKTREE_PATH}/.env", ".env"],
            "cwd": "config",
            "timeout": "500ms"
          },
        ]
      }`
    )

    await expect(
      resolveWorktreeSetupTasks({
        shell: '/bin/zsh',
        mainWorktreePath: main,
        worktreePath: worktree
      })
    ).resolves.toEqual([
      {
        label: 'Generate code',
        argv: [
          'node',
          'a b',
          'semi;colon',
          '$HOME',
          '${UNKNOWN}',
          `${worktree}/input`
        ],
        cwd: path.join(worktree, 'packages', 'api'),
        env: {
          CACHE: `${main}/.cache`,
          UNCHANGED: '${OTHER}',
          TREEPORT_WORKTREE_PATH: worktree,
          TREEPORT_MAIN_WORKTREE_PATH: main
        },
        timeoutMs: 30 * 60_000
      },
      {
        label: 'Copy environment',
        argv: ['cp', `${main}/.env`, '.env'],
        cwd: path.join(worktree, 'config'),
        env: {
          TREEPORT_WORKTREE_PATH: worktree,
          TREEPORT_MAIN_WORKTREE_PATH: main
        },
        timeoutMs: 500
      }
    ])
  })

  it('rejects invalid native setup without weakening the versioned contract', async () => {
    const { main, worktree } = await repository()
    const invalidFiles: unknown[] = [
      null,
      { commands: [] },
      { version: 2, commands: [] },
      { version: 1 },
      { version: 1, commands: [], typo: true },
      {
        version: 1,
        commands: [{ name: 'unknown field', argv: ['echo'], typo: true }]
      },
      { version: 1, commands: [{ name: ' ', argv: ['echo'] }] },
      { version: 1, commands: [{ name: 'empty', argv: [] }] },
      { version: 1, commands: [{ name: 'empty', argv: ['  '] }] },
      {
        version: 1,
        commands: [
          {
            name: 'reserved',
            argv: ['echo'],
            env: { TREEPORT_WORKTREE_PATH: 'other' }
          }
        ]
      },
      {
        version: 1,
        commands: [
          { name: 'bad env', argv: ['echo'], env: { 'BAD=NAME': 'value' } }
        ]
      },
      {
        version: 1,
        commands: [{ name: 'timeout', argv: ['echo'], timeout: '0s' }]
      },
      {
        version: 1,
        commands: [{ name: 'timeout', argv: ['echo'], timeout: '25d' }]
      },
      {
        version: 1,
        commands: [{ name: 'timeout', argv: ['echo'], timeout: '2147483648ms' }]
      },
      {
        version: 1,
        commands: [{ name: 'escape', argv: ['echo'], cwd: '../outside' }]
      },
      {
        version: 1,
        commands: [
          {
            name: 'main cwd',
            argv: ['echo'],
            cwd: '${TREEPORT_MAIN_WORKTREE_PATH}'
          }
        ]
      }
    ]

    for (const value of invalidFiles) {
      await fs.writeFile(
        path.join(main, '.treeport', 'setup.json'),
        JSON.stringify(value)
      )
      await expect(
        resolveWorktreeSetupTasks({
          shell: '/bin/sh',
          mainWorktreePath: main,
          worktreePath: worktree
        })
      ).rejects.toThrow(/Invalid Treeport setup/)
    }
  })

  it('uses only main-worktree native setup and falls back to Zed only when it is absent', async () => {
    const { main, worktree } = await repository()
    await fs.mkdir(path.join(main, '.zed'), { recursive: true })
    await fs.mkdir(path.join(worktree, '.treeport'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.zed', 'tasks.json'),
      JSON.stringify([
        {
          label: 'Zed fallback',
          command: 'zed-command',
          hooks: ['create_worktree']
        }
      ])
    )
    await fs.writeFile(
      path.join(worktree, '.treeport', 'setup.json'),
      JSON.stringify({
        version: 1,
        commands: [{ name: 'Linked copy', argv: ['linked-command'] }]
      })
    )
    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      JSON.stringify({
        version: 1,
        commands: [{ name: 'Native', argv: ['native-command'] }]
      })
    )

    const input = {
      shell: '/bin/sh',
      mainWorktreePath: main,
      worktreePath: worktree
    }
    await expect(resolveWorktreeSetupTasks(input)).resolves.toEqual([
      expect.objectContaining({
        label: 'Native',
        argv: ['native-command']
      })
    ])

    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      JSON.stringify({ version: 1, commands: [] })
    )
    await expect(resolveWorktreeSetupTasks(input)).resolves.toEqual([])

    await fs.writeFile(path.join(main, '.treeport', 'setup.json'), 'null')
    await expect(resolveWorktreeSetupTasks(input)).rejects.toThrow(
      /Invalid Treeport setup/
    )

    await fs.rm(path.join(main, '.treeport', 'setup.json'))
    await expect(resolveWorktreeSetupTasks(input)).resolves.toEqual([
      expect.objectContaining({
        label: 'Zed fallback',
        argv: ['zed-command']
      })
    ])
  })

  it('runs generic tasks sequentially and stops with bounded failure output', async () => {
    const runner = new Runner()
    runner.results.push(
      { stdout: 'done', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'failed'.repeat(2_000), exitCode: 17 }
    )
    const tasks: WorktreeSetupTask[] = [
      {
        label: 'First',
        argv: ['first', 'literal argument'],
        cwd: '/worktree/first',
        env: { FIRST: 'one' },
        timeoutMs: 1_000
      },
      {
        label: 'Second',
        argv: ['second'],
        cwd: '/worktree/second',
        env: { SECOND: 'two' },
        timeoutMs: 2_000
      },
      {
        label: 'Skipped',
        argv: ['third'],
        cwd: '/worktree',
        env: {},
        timeoutMs: 3_000
      }
    ]

    const results = await runWorktreeSetupTasks({ runner, tasks })
    expect(results).toEqual([
      { label: 'First', error: null },
      { label: 'Second', error: expect.any(String) }
    ])
    expect(results[1]?.error).toHaveLength(4_000)
    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[0]).toMatchObject({
      executable: 'first',
      args: ['literal argument'],
      cwd: '/worktree/first',
      env: { FIRST: 'one' },
      timeoutMs: 1_000
    })
    expect(runner.calls[1]).toMatchObject({
      executable: 'second',
      args: [],
      cwd: '/worktree/second',
      env: { SECOND: 'two' },
      timeoutMs: 2_000
    })
  })
})
