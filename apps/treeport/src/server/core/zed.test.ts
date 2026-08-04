import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inferWorktreeName,
  loadCreateWorktreeTasks,
  normalizeWorktreeName,
  resolveZedCreateWorktreeSetupTasks,
  resolveZedWorktreePath
} from './zed'

const temporary: string[] = []
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
)

async function repository(name = 'example') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-zed-'))
  temporary.push(root)
  const main = path.join(root, name)
  await fs.mkdir(path.join(main, '.zed'), { recursive: true })
  return { root, main }
}

describe('Zed worktree compatibility', () => {
  it('normalizes names and infers Zed and legacy layouts', () => {
    expect(normalizeWorktreeName(' feature cache ')).toBe('feature-cache')
    expect(() => normalizeWorktreeName('feature/cache')).toThrow(
      /path separators/
    )
    expect(
      inferWorktreeName(
        '/Projects/remotion-main',
        '/Projects/worktrees/remotion-main/kimi-plugin/remotion-main',
        'linked'
      )
    ).toBe('kimi-plugin')
    expect(
      inferWorktreeName(
        '/Projects/banger.show',
        '/Projects/banger.show__worktrees/test',
        'linked'
      )
    ).toBe('test')
    expect(inferWorktreeName('/Projects/repo', '/Projects/repo', 'main')).toBe(
      'main worktree'
    )
  })

  it('resolves the default Zed layout and project-local JSONC settings', async () => {
    const { root, main } = await repository('repo')
    const canonicalRoot = await fs.realpath(root)
    await expect(resolveZedWorktreePath(main, 'topic')).resolves.toMatchObject({
      path: path.join(canonicalRoot, 'worktrees', 'repo', 'topic', 'repo'),
      wrapperPath: path.join(canonicalRoot, 'worktrees', 'repo', 'topic')
    })
    await fs.writeFile(
      path.join(main, '.zed', 'settings.json'),
      `{ // project override\n "git": { "worktree_directory": "../zed-trees", },\n}`
    )
    await expect(resolveZedWorktreePath(main, 'other')).resolves.toMatchObject({
      path: path.join(canonicalRoot, 'zed-trees', 'repo', 'other', 'repo')
    })
  })

  it('rejects unsafe directory settings', async () => {
    const { main } = await repository()
    await fs.writeFile(
      path.join(main, '.zed', 'settings.json'),
      JSON.stringify({ git: { worktree_directory: '../../outside' } })
    )
    await expect(resolveZedWorktreePath(main, 'topic')).rejects.toThrow(
      /must stay inside/
    )
  })

  it('rejects a configured worktree root that escapes through a symbolic link', async () => {
    if (process.platform === 'win32') {
      return
    }

    const { root, main } = await repository()
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-zed-outside-')
    )
    temporary.push(outside)
    await fs.symlink(outside, path.join(root, 'linked-trees'), 'dir')
    await fs.writeFile(
      path.join(main, '.zed', 'settings.json'),
      JSON.stringify({ git: { worktree_directory: '../linked-trees' } })
    )
    await expect(resolveZedWorktreePath(main, 'topic')).rejects.toThrow(
      /symbolic link/i
    )
  })

  it('loads create_worktree tasks with Zed variables', async () => {
    const { main } = await repository()
    const worktree = path.join(
      path.dirname(main),
      'worktrees',
      'example',
      'topic',
      'example'
    )
    await fs.mkdir(worktree, { recursive: true })
    await fs.writeFile(
      path.join(main, '.zed', 'tasks.json'),
      `[
        {"label":"setup","command":"bash","args":["$ZED_MAIN_GIT_WORKTREE/.zed/setup.sh"],"hooks":["create_worktree"]},
        {"label":"build","command":"bun install && bun run build","cwd":"$ZED_WORKTREE_ROOT","hooks":["create_worktree"]},
      ]`
    )
    expect(await loadCreateWorktreeTasks(main)).toHaveLength(2)
    await expect(
      resolveZedCreateWorktreeSetupTasks({
        shell: '/bin/zsh',
        mainWorktreePath: main,
        worktreePath: worktree
      })
    ).resolves.toEqual([
      {
        label: 'setup',
        argv: ['bash', path.join(main, '.zed', 'setup.sh')],
        cwd: worktree,
        env: {
          ZED_WORKTREE_ROOT: worktree,
          ZED_MAIN_GIT_WORKTREE: main
        },
        timeoutMs: 30 * 60_000
      },
      {
        label: 'build',
        argv: ['/bin/zsh', '-lc', 'bun install && bun run build'],
        cwd: worktree,
        env: {
          ZED_WORKTREE_ROOT: worktree,
          ZED_MAIN_GIT_WORKTREE: main
        },
        timeoutMs: 30 * 60_000
      }
    ])
  })

  it('preserves hostile direct arguments and safely quotes explicit-shell arguments', async () => {
    const { main } = await repository()
    const worktree = path.join(
      path.dirname(main),
      'worktrees',
      'example',
      'hostile',
      'example'
    )
    await fs.mkdir(worktree, { recursive: true })
    await fs.writeFile(
      path.join(main, '.zed', 'tasks.json'),
      JSON.stringify([
        {
          label: 'direct',
          command: 'node',
          args: ['a b', 'semi;colon', '$cash', "quote'argument", '雪'],
          cwd: 'nested dir',
          env: { CUSTOM: 'value $ZED_WORKTREE_ROOT 雪' },
          hooks: ['create_worktree']
        },
        {
          label: 'shell',
          command: 'echo value | cat',
          args: ['a b', 'semi;colon', '$cash', "quote'argument", '雪'],
          hooks: ['create_worktree']
        }
      ])
    )

    const tasks = await resolveZedCreateWorktreeSetupTasks({
      shell: '/bin/zsh',
      mainWorktreePath: main,
      worktreePath: worktree
    })
    expect(tasks[0]).toMatchObject({
      argv: ['node', 'a b', 'semi;colon', '$cash', "quote'argument", '雪'],
      cwd: path.join(worktree, 'nested dir'),
      env: {
        ZED_WORKTREE_ROOT: worktree,
        ZED_MAIN_GIT_WORKTREE: main,
        CUSTOM: `value ${worktree} 雪`
      }
    })
    expect(tasks[1]?.argv).toEqual([
      '/bin/zsh',
      '-lc',
      `echo value | cat 'a b' 'semi;colon' '$cash' 'quote'"'"'argument' '雪'`
    ])
  })
})
