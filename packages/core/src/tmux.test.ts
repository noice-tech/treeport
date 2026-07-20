import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandRequest, CommandResult, CommandRunner } from './command.js'
import {
  generateTmuxSessionName,
  generateTmuxSocketName,
  TmuxAdapter
} from './tmux.js'

const temporary: string[] = []
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
)

class RecordingRunner implements CommandRunner {
  readonly calls: CommandRequest[] = []
  responses: CommandResult[] = []
  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request)
    return this.responses.shift() ?? { stdout: '', stderr: '', exitCode: 0 }
  }
}

describe('TmuxAdapter', () => {
  it('generates application-owned identifiers independent of branch names', () => {
    expect(generateTmuxSocketName()).toMatch(/^tasktty-wt-[a-f0-9]{16}$/)
    expect(generateTmuxSessionName()).toMatch(/^tasktty-term-[a-f0-9]{16}$/)
    expect(generateTmuxSocketName()).not.toBe(generateTmuxSocketName())
  })

  it('stores hostile and Unicode argv losslessly in the launch spec', async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty runtime '))
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const launcher = '/application owned/path with spaces/launcher.js'
    const adapter = new TmuxAdapter(
      runner,
      runtime,
      '/tmux path/tmux',
      launcher
    )
    const argv = [
      'tool with spaces',
      'a "quote"',
      'semi;colon',
      '$HOME',
      'snowman ☃',
      "single'quote"
    ]
    const setupTask = {
      label: 'install ☃',
      argv: ['tool with spaces', 'semi;colon', '$HOME', "single'quote"],
      cwd: '/repo with spaces/setup',
      env: { HOSTILE: 'a "quote"' },
      timeoutMs: 1234
    }
    await adapter.createSession({
      socketName: 'tasktty-wt-safe',
      sessionName: 'tasktty-term-safe',
      terminalId: 'term_safe',
      worktreeId: 'wt_safe',
      name: 'Pi ☃',
      createdAt: '2026-01-02T03:04:05.000Z',
      cwd: '/repo with spaces',
      argv,
      env: { TASKTTY_TERMINAL_ID: 'term_safe' },
      setupTasks: [setupTask]
    })

    await expect(
      fs
        .readFile(path.join(adapter.specsDir, 'term_safe.json'), 'utf8')
        .then(JSON.parse)
    ).resolves.toEqual({
      argv,
      cwd: '/repo with spaces',
      env: { TASKTTY_TERMINAL_ID: 'term_safe' },
      setupTasks: [setupTask]
    })
    expect(
      runner.calls
        .filter((call) => call.args.includes('set-option'))
        .map((call) => call.args[call.args.indexOf('-t') + 2])
    ).toEqual([
      '@tasktty-name',
      '@tasktty-argv',
      '@tasktty-created-at',
      '@tasktty-updated-at',
      '@tasktty-worktree-id',
      '@tasktty-terminal-id'
    ])
  })

  it('removes the launch spec when post-creation setup fails', async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty-runtime-'))
    temporary.push(runtime)
    const runner = new RecordingRunner()
    runner.responses.push(
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'setup failed', exitCode: 1 }
    )
    const adapter = new TmuxAdapter(runner, runtime, 'tmux', '/launcher.js')
    await expect(
      adapter.createSession({
        socketName: 'socket',
        sessionName: 'session',
        terminalId: 'term',
        worktreeId: 'wt',
        name: 'Terminal',
        createdAt: '2026-01-02T03:04:05.000Z',
        cwd: '/tmp',
        argv: ['pi'],
        env: {}
      })
    ).rejects.toThrow()
    await expect(
      fs.access(path.join(adapter.specsDir, 'term.json'))
    ).rejects.toThrow()
  })

  it('reads the live pane title from tmux', async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty-runtime-'))
    temporary.push(runtime)
    const runner = new RecordingRunner()
    runner.responses.push({ stdout: 'zsh · /repo\n', stderr: '', exitCode: 0 })
    const adapter = new TmuxAdapter(runner, runtime)

    await expect(adapter.sessionTitle('socket', 'session')).resolves.toBe(
      'zsh · /repo'
    )
  })

  it('discovers live tmux terminals from encoded session metadata', async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty-runtime-'))
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    runner.responses.push({
      stdout: [
        [
          'tasktty-term-one',
          'term_one',
          'wt_one',
          encode('Pi\t☃'),
          encode(['pi', 'a b', '☃']),
          encode('2026-01-01T00:00:00.000Z'),
          encode('2026-01-02T00:00:00.000Z'),
          '1767225600',
          '0',
          ''
        ].join('\t'),
        [
          'tasktty-term-two',
          'term_two',
          'wt_one',
          encode('Done'),
          encode(['sh']),
          encode('2026-01-03T00:00:00.000Z'),
          encode('2026-01-03T00:00:00.000Z'),
          '1767398400',
          '1',
          '17'
        ].join('\t'),
        'unrelated\t\t\t\t\t\t\t1767398400\t0\t'
      ].join('\n'),
      stderr: '',
      exitCode: 0
    })
    const adapter = new TmuxAdapter(runner, runtime)

    await expect(adapter.listSessions('socket')).resolves.toEqual([
      {
        id: 'term_one',
        worktreeId: 'wt_one',
        name: 'Pi\t☃',
        sessionName: 'tasktty-term-one',
        argv: ['pi', 'a b', '☃'],
        status: 'running',
        exitCode: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      },
      {
        id: 'term_two',
        worktreeId: 'wt_one',
        name: 'Done',
        sessionName: 'tasktty-term-two',
        argv: ['sh'],
        status: 'exited',
        exitCode: 17,
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z'
      }
    ])
  })

  it('treats an absent tmux server as an empty terminal inventory', async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty-runtime-'))
    temporary.push(runtime)
    const runner = new RecordingRunner()
    runner.responses.push({
      stdout: '',
      stderr: 'no server running on socket',
      exitCode: 1
    })
    const adapter = new TmuxAdapter(runner, runtime)
    await expect(adapter.listSessions('socket')).resolves.toEqual([])
  })

  it('removes discovered launch specs when killing a worktree server', async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty-runtime-'))
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    runner.responses.push(
      {
        stdout: [
          'tasktty-term-one',
          'term_one',
          'wt_one',
          encode('Terminal'),
          encode(['sh']),
          encode('2026-01-01T00:00:00.000Z'),
          encode('2026-01-01T00:00:00.000Z'),
          '1767225600',
          '0',
          ''
        ].join('\t'),
        stderr: '',
        exitCode: 0
      },
      { stdout: '', stderr: '', exitCode: 0 }
    )
    const adapter = new TmuxAdapter(runner, runtime)
    await adapter.initialize()
    const specPath = path.join(adapter.specsDir, 'term_one.json')
    await fs.writeFile(specPath, '{}')

    await adapter.killServer('socket')

    await expect(fs.access(specPath)).rejects.toThrow()
  })

  it('maps a live, exited, or absent pane to product terminal state', async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty-runtime-'))
    temporary.push(runtime)
    const runner = new RecordingRunner()
    runner.responses.push(
      { stdout: '0\t\n', stderr: '', exitCode: 0 },
      { stdout: '1\t17\n', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'no server running', exitCode: 1 }
    )
    const adapter = new TmuxAdapter(runner, runtime)
    await expect(adapter.sessionState('socket', 'one')).resolves.toEqual({
      status: 'running',
      exitCode: null
    })
    await expect(adapter.sessionState('socket', 'two')).resolves.toEqual({
      status: 'exited',
      exitCode: 17
    })
    await expect(adapter.sessionState('socket', 'three')).resolves.toEqual({
      status: 'missing',
      exitCode: null
    })
  })
})
