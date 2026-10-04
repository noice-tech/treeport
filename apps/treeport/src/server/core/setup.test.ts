import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandRequest, CommandResult, CommandRunner } from './command'
import {
  resolveWorktreeCleanupTasks,
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
  it('resolves native JSON commands as direct setup tasks', async () => {
    const { main, worktree } = await repository()
    await fs.writeFile(
      path.join(main, '.treeport', 'settings.json'),
      `{
        "packages": [],
        "setup": {
        "commands": [
          {
            "name": "  Generate code  ",
            "argv": ["node", "a b", "semi;colon", "$HOME", "\${UNKNOWN}", "\${TREEPORT_WORKTREE_PATH}/input"],
            "cwd": "\${TREEPORT_WORKTREE_PATH}/packages/api",
            "env": {
              "CACHE": "\${TREEPORT_MAIN_WORKTREE_PATH}/.cache",
              "UNCHANGED": "\${OTHER}"
            }
          },
          {
            "name": "Copy environment",
            "argv": ["cp", "\${TREEPORT_MAIN_WORKTREE_PATH}/.env", ".env"],
            "cwd": "config",
            "timeout": "500ms"
          }
        ]
        }
      }`
    )

    await expect(
      Effect.runPromise(
        resolveWorktreeSetupTasks({
          shell: '/bin/zsh',
          mainWorktreePath: main,
          worktreePath: worktree
        })
      )
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

  it('resolves ordered cleanup commands and hashes their execution definition', async () => {
    const { main, worktree } = await repository()
    const filePath = path.join(main, '.treeport', 'settings.json')
    await fs.mkdir(path.join(worktree, 'apps', 'api'), { recursive: true })
    await fs.writeFile(
      filePath,
      JSON.stringify({
        setup: {
          commands: [],
          cleanup: [
            {
              name: '  Drop database  ',
              argv: ['node', '${TREEPORT_WORKTREE_PATH}/drop.mjs'],
              cwd: 'apps/api',
              env: { ADMIN: '${TREEPORT_MAIN_WORKTREE_PATH}/admin' },
              timeout: '2m'
            },
            { name: 'Remove cache', argv: ['rm', '-rf', '.cache'] }
          ]
        }
      })
    )

    const first = await Effect.runPromise(
      resolveWorktreeCleanupTasks({
        mainWorktreePath: main,
        worktreePath: worktree
      })
    )
    expect(first.tasks).toEqual([
      {
        label: 'Drop database',
        argv: ['node', `${worktree}/drop.mjs`],
        cwd: path.join(worktree, 'apps', 'api'),
        env: {
          ADMIN: `${main}/admin`,
          TREEPORT_WORKTREE_PATH: worktree,
          TREEPORT_MAIN_WORKTREE_PATH: main
        },
        timeoutMs: 120_000
      },
      expect.objectContaining({
        label: 'Remove cache',
        argv: ['rm', '-rf', '.cache'],
        cwd: worktree,
        timeoutMs: 30 * 60_000
      })
    ])
    expect(first.definitionHash).toMatch(/^[a-f0-9]{64}$/)
    await expect(
      Effect.runPromise(
        resolveWorktreeCleanupTasks({
          mainWorktreePath: main,
          worktreePath: worktree
        })
      )
    ).resolves.toEqual(first)

    await fs.writeFile(
      filePath,
      JSON.stringify({
        setup: {
          commands: [],
          cleanup: [
            { name: 'Remove cache', argv: ['rm', '-rf', '.cache'] },
            {
              name: 'Drop database',
              argv: ['node', '${TREEPORT_WORKTREE_PATH}/drop.mjs'],
              cwd: 'apps/api',
              env: { ADMIN: '${TREEPORT_MAIN_WORKTREE_PATH}/admin' },
              timeout: '2m'
            }
          ]
        }
      })
    )
    expect(
      (
        await Effect.runPromise(
          resolveWorktreeCleanupTasks({
            mainWorktreePath: main,
            worktreePath: worktree
          })
        )
      ).definitionHash
    ).not.toBe(first.definitionHash)
  })

  it('does not use Zed as a cleanup fallback', async () => {
    const { main, worktree } = await repository()
    await fs.mkdir(path.join(main, '.zed'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.zed', 'tasks.json'),
      JSON.stringify([
        {
          label: 'Zed setup',
          command: 'setup',
          hooks: ['create_worktree']
        }
      ])
    )

    await expect(
      Effect.runPromise(
        resolveWorktreeCleanupTasks({
          mainWorktreePath: main,
          worktreePath: worktree
        })
      )
    ).resolves.toEqual({ tasks: [], definitionHash: null })
  })

  it('rejects invalid native setup and command fields', async () => {
    const { main, worktree } = await repository()
    const invalidFiles: unknown[] = [
      null,
      [],
      { commands: 'invalid' },
      { commands: [], typo: true },
      {
        commands: [{ name: 'unknown field', argv: ['echo'], typo: true }]
      },
      { commands: [{ name: ' ', argv: ['echo'] }] },
      { commands: [{ name: 'empty', argv: [] }] },
      { commands: [{ name: 'empty', argv: ['  '] }] },
      {
        commands: [
          {
            name: 'reserved',
            argv: ['echo'],
            env: { TREEPORT_WORKTREE_PATH: 'other' }
          }
        ]
      },
      {
        commands: [
          { name: 'bad env', argv: ['echo'], env: { 'BAD=NAME': 'value' } }
        ]
      },
      {
        commands: [{ name: 'timeout', argv: ['echo'], timeout: '0s' }]
      },
      {
        commands: [{ name: 'timeout', argv: ['echo'], timeout: '25d' }]
      },
      {
        commands: [{ name: 'timeout', argv: ['echo'], timeout: '2147483648ms' }]
      },
      {
        commands: [{ name: 'escape', argv: ['echo'], cwd: '../outside' }]
      },
      {
        commands: [],
        cleanup: [{ name: 'unknown field', argv: ['echo'], typo: true }]
      },
      {
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
        path.join(main, '.treeport', 'settings.json'),
        JSON.stringify({ setup: value })
      )
      await expect(
        Effect.runPromise(
          resolveWorktreeSetupTasks({
            shell: '/bin/sh',
            mainWorktreePath: main,
            worktreePath: worktree
          })
        )
      ).rejects.toThrow(/Invalid Treeport setup/)
    }

    await fs.writeFile(
      path.join(main, '.treeport', 'settings.json'),
      JSON.stringify({
        setup: {
          commands: [],
          cleanup: [{ name: 'escape', argv: ['echo'], cwd: '../outside' }]
        }
      })
    )
    await expect(
      Effect.runPromise(
        resolveWorktreeCleanupTasks({
          mainWorktreePath: main,
          worktreePath: worktree
        })
      )
    ).rejects.toThrow(/cleanup\[0\]\.cwd must stay inside the tree/)
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
      path.join(worktree, '.treeport', 'settings.json'),
      JSON.stringify({
        setup: {
          commands: [{ name: 'Linked copy', argv: ['linked-command'] }]
        }
      })
    )
    await fs.writeFile(
      path.join(main, '.treeport', 'settings.json'),
      JSON.stringify({
        setup: {
          commands: [{ name: 'Native', argv: ['native-command'] }]
        }
      })
    )

    const input = {
      shell: '/bin/sh',
      mainWorktreePath: main,
      worktreePath: worktree
    }
    await expect(
      Effect.runPromise(resolveWorktreeSetupTasks(input))
    ).resolves.toEqual([
      expect.objectContaining({
        label: 'Native',
        argv: ['native-command']
      })
    ])

    await fs.writeFile(
      path.join(main, '.treeport', 'settings.json'),
      JSON.stringify({ setup: { commands: [] } })
    )
    await expect(
      Effect.runPromise(resolveWorktreeSetupTasks(input))
    ).resolves.toEqual([])

    await fs.writeFile(path.join(main, '.treeport', 'settings.json'), 'null')
    await expect(
      Effect.runPromise(resolveWorktreeSetupTasks(input))
    ).rejects.toThrow(/Invalid Treeport setup/)

    await fs.writeFile(
      path.join(main, '.treeport', 'settings.json'),
      JSON.stringify({
        packages: [],
        terminalPresets: {},
        treeContext: { fields: [] }
      })
    )
    await expect(
      Effect.runPromise(resolveWorktreeSetupTasks(input))
    ).resolves.toEqual([
      expect.objectContaining({ label: 'Zed fallback', argv: ['zed-command'] })
    ])

    await fs.writeFile(
      path.join(main, '.treeport', 'settings.json'),
      JSON.stringify({
        setup: { cleanup: [{ name: 'Cleanup only', argv: ['cleanup'] }] }
      })
    )
    await expect(
      Effect.runPromise(resolveWorktreeSetupTasks(input))
    ).resolves.toEqual([])
    await expect(
      Effect.runPromise(resolveWorktreeCleanupTasks(input))
    ).resolves.toMatchObject({ tasks: [{ label: 'Cleanup only' }] })

    await fs.rm(path.join(main, '.treeport', 'settings.json'))
    await expect(
      Effect.runPromise(resolveWorktreeSetupTasks(input))
    ).resolves.toEqual([
      expect.objectContaining({
        label: 'Zed fallback',
        argv: ['zed-command']
      })
    ])
  })

  it.each([
    '{ "setup": { "commands": [] }, }',
    '{ /* comment */ "setup": { "commands": [] } }'
  ])('rejects non-JSON settings: %s', async (content) => {
    const { main, worktree } = await repository()
    await fs.writeFile(path.join(main, '.treeport', 'settings.json'), content)
    await expect(
      Effect.runPromise(
        resolveWorktreeSetupTasks({
          shell: '/bin/sh',
          mainWorktreePath: main,
          worktreePath: worktree
        })
      )
    ).rejects.toThrow(/Could not parse .*settings\.json/)
  })

  it('preserves interruption while a setup command is running', async () => {
    let started = false
    let cancelled = false
    const runner: CommandRunner = {
      run: () => new Promise<CommandResult>(() => undefined),
      runEffect: () =>
        Effect.sync(() => {
          started = true
        }).pipe(
          Effect.zipRight(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              cancelled = true
            })
          )
        )
    }
    const fiber = Effect.runFork(
      runWorktreeSetupTasks({
        runner,
        tasks: [
          {
            label: 'Wait',
            argv: ['wait'],
            cwd: '/worktree',
            env: {},
            timeoutMs: 1_000
          }
        ]
      })
    )

    await vi.waitFor(() => expect(started).toBe(true))
    const exit = await Effect.runPromise(Fiber.interrupt(fiber))

    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(
      true
    )
    expect(cancelled).toBe(true)
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

    const results = await Effect.runPromise(
      runWorktreeSetupTasks({ runner, tasks })
    )
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
