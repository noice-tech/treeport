import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inferWorktreeName,
  loadCreateWorktreeTasks,
  loadZedTerminalPresetDefinitions,
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

  it('discovers ordered repository tasks and resolves their launch context for a linked worktree', async () => {
    const { main } = await repository()
    const worktree = path.join(
      path.dirname(main),
      'worktrees',
      'example',
      'picker',
      'example'
    )
    await fs.mkdir(worktree, { recursive: true })
    await fs.writeFile(
      path.join(main, '.zed', 'tasks.json'),
      `{
        // Zed also accepts an object root.
        "tasks": [
          {
            "label": "Run $ZED_WORKTREE_ROOT",
            "command": "\${ZED_MAIN_GIT_WORKTREE}/bin/node",
            "args": ["$ZED_MAIN_GIT_WORKTREE/script.js", "a b", "$HOME", "雪"],
            "cwd": "nested dir",
            "env": { "CUSTOM": "\${ZED_MAIN_GIT_WORKTREE}:$ZED_WORKTREE_ROOT" },
            "hooks": ["create_worktree"],
            "reveal": "always",
          },
          { "label": "Duplicate", "command": "echo value | cat", "args": ["semi;colon", "quote'argument"] },
          { "label": "Duplicate", "command": "printf", "args": ["done"] },
        ],
      }`
    )

    const listing = await loadZedTerminalPresetDefinitions({
      projectId: 'project_1',
      shell: '/bin/zsh',
      mainWorktreePath: main,
      worktreePath: worktree
    })
    expect(listing).toEqual({
      definitions: [
        {
          id: 'repository:project_1:zed-task:0',
          name: `Run ${worktree}`,
          executable: path.join(main, 'bin', 'node'),
          args: [path.join(main, 'script.js'), 'a b', '$HOME', '雪'],
          cwd: path.join(worktree, 'nested dir'),
          env: {
            CUSTOM: `${main}:${worktree}`,
            ZED_WORKTREE_ROOT: worktree,
            ZED_MAIN_GIT_WORKTREE: main
          },
          closeOnSuccess: false,
          source: { type: 'repository', format: 'zed' }
        },
        {
          id: 'repository:project_1:zed-task:1',
          name: 'Duplicate',
          executable: '/bin/zsh',
          args: ['-lc', `echo value | cat 'semi;colon' 'quote'"'"'argument'`],
          cwd: worktree,
          env: {
            ZED_WORKTREE_ROOT: worktree,
            ZED_MAIN_GIT_WORKTREE: main
          },
          closeOnSuccess: false,
          source: { type: 'repository', format: 'zed' }
        },
        {
          id: 'repository:project_1:zed-task:2',
          name: 'Duplicate',
          executable: 'printf',
          args: ['done'],
          cwd: worktree,
          env: {
            ZED_WORKTREE_ROOT: worktree,
            ZED_MAIN_GIT_WORKTREE: main
          },
          closeOnSuccess: false,
          source: { type: 'repository', format: 'zed' }
        }
      ],
      diagnostics: []
    })
    expect(await loadCreateWorktreeTasks(main)).toHaveLength(1)
  })

  it('isolates malformed picker tasks, invalid files, and repository roots', async () => {
    const first = await repository('first')
    const second = await repository('second')
    await fs.writeFile(
      path.join(first.main, '.zed', 'tasks.json'),
      JSON.stringify([
        'not an object',
        { label: ' ', command: 'missing-label' },
        { label: 'Missing command' },
        { label: 'Valid', command: 'node' },
        { label: 'Bad args', command: 'node', args: 'one' },
        { label: 'Bad argument', command: 'node', args: [42] },
        { label: 'Bad cwd', command: 'node', cwd: 42 },
        { label: 'Bad env root', command: 'node', env: 'value' },
        { label: 'Bad env', command: 'node', env: { 'BAD=KEY': 'value' } },
        { label: 'Bad value', command: 'node', env: { GOOD: 42 } }
      ])
    )

    const listing = await loadZedTerminalPresetDefinitions({
      projectId: 'first',
      shell: '/bin/zsh',
      mainWorktreePath: first.main,
      worktreePath: first.main
    })
    expect(listing.definitions).toEqual([
      expect.objectContaining({
        id: 'repository:first:zed-task:3',
        name: 'Valid'
      })
    ])
    expect(listing.diagnostics.map((diagnostic) => diagnostic.itemId)).toEqual([
      '1',
      '2',
      '3',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10'
    ])
    expect(
      await loadZedTerminalPresetDefinitions({
        projectId: 'second',
        shell: '/bin/zsh',
        mainWorktreePath: second.main,
        worktreePath: second.main
      })
    ).toEqual({ definitions: [], diagnostics: [] })

    await fs.writeFile(
      path.join(first.main, '.zed', 'tasks.json'),
      JSON.stringify({ tasks: 'invalid' })
    )
    await expect(
      loadZedTerminalPresetDefinitions({
        projectId: 'first',
        shell: '/bin/zsh',
        mainWorktreePath: first.main,
        worktreePath: first.main
      })
    ).resolves.toMatchObject({
      definitions: [],
      diagnostics: [
        { itemId: null, message: expect.stringContaining('Invalid Zed tasks') }
      ]
    })

    await fs.writeFile(path.join(first.main, '.zed', 'tasks.json'), '{ bad')
    await expect(
      loadZedTerminalPresetDefinitions({
        projectId: 'first',
        shell: '/bin/zsh',
        mainWorktreePath: first.main,
        worktreePath: first.main
      })
    ).resolves.toMatchObject({
      definitions: [],
      diagnostics: [
        {
          itemId: null,
          message: expect.stringContaining('Could not load Zed tasks')
        }
      ]
    })
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
