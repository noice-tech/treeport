import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandRequest, CommandResult, CommandRunner } from './command'
import {
  generateTmuxSessionName,
  generateTmuxSocketName,
  TmuxAdapter
} from './tmux'

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
  launchctlResponse: CommandResult = {
    stdout: '',
    stderr: 'SSH_AUTH_SOCK is unavailable',
    exitCode: 1
  }
  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request)
    if (request.executable === '/bin/launchctl') {
      return this.launchctlResponse
    }

    return this.responses.shift() ?? { stdout: '', stderr: '', exitCode: 0 }
  }
}

describe('TmuxAdapter', () => {
  it('generates application-owned identifiers independent of branch names', () => {
    expect(generateTmuxSocketName()).toMatch(/^treeport-wt-[a-f0-9]{16}$/)
    expect(generateTmuxSessionName()).toMatch(/^treeport-term-[a-f0-9]{16}$/)
    expect(generateTmuxSocketName()).not.toBe(generateTmuxSocketName())
  })

  it('configures manual window sizing without changing the global default', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const adapter = new TmuxAdapter(runner, runtime)

    await adapter.useManualWindowSize('socket', 'session')

    expect(runner.calls.at(-1)?.args).toEqual([
      '-L',
      'socket',
      '-f',
      adapter.configPath,
      'set-option',
      '-w',
      '-t',
      'session',
      'window-size',
      'manual'
    ])
  })

  it('resizes a window explicitly at the canonical dimensions', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const adapter = new TmuxAdapter(runner, runtime)

    await adapter.resizeWindow('socket', 'session', 132, 47)

    expect(runner.calls.at(-1)?.args).toEqual([
      '-L',
      'socket',
      '-f',
      adapter.configPath,
      'resize-window',
      '-t',
      'session',
      '-x',
      '132',
      '-y',
      '47'
    ])
  })

  it('starts a new session at the requested initial dimensions', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const adapter = new TmuxAdapter(runner, runtime, 'tmux', '/launcher.js')

    await adapter.createSession({
      socketName: 'socket',
      sessionName: 'session',
      terminalId: 'term',
      worktreeId: 'wt',
      name: 'Hunk',
      createdAt: '2026-01-02T03:04:05.000Z',
      cwd: '/repo',
      argv: ['hunk', 'diff', 'HEAD'],
      initialSize: { cols: 132, rows: 47 },
      env: {}
    })

    const create = runner.calls.find((call) =>
      call.args.includes('new-session')
    )!
    expect(
      create.args.slice(create.args.indexOf('-s'), create.args.indexOf('-c'))
    ).toEqual(['-s', 'session', '-x', '132', '-y', '47'])
    expect(create.args.indexOf('-x')).toBeLessThan(create.args.indexOf('--'))
  })

  it('stores hostile and Unicode argv losslessly in the launch spec', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport runtime ')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const launcher = '/application owned/path with spaces/launcher.js'
    const adapter = new TmuxAdapter(
      runner,
      runtime,
      '/tmux path/tmux',
      launcher,
      { environment: {}, platform: 'linux' }
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
      socketName: 'treeport-wt-safe',
      sessionName: 'treeport-term-safe',
      terminalId: 'term_safe',
      worktreeId: 'wt_safe',
      name: 'Pi ☃',
      createdAt: '2026-01-02T03:04:05.000Z',
      cwd: '/repo with spaces',
      argv,
      fallbackArgv: ['/bin/zsh', '-l'],
      env: { TREEPORT_TERMINAL_ID: 'term_safe' },
      setupTasks: [setupTask]
    })

    await expect(
      fs
        .readFile(path.join(adapter.specsDir, 'term_safe.json'), 'utf8')
        .then(JSON.parse)
    ).resolves.toEqual({
      argv,
      fallbackArgv: ['/bin/zsh', '-l'],
      cwd: '/repo with spaces',
      env: { TREEPORT_TERMINAL_ID: 'term_safe' },
      setupTasks: [setupTask]
    })
    expect(
      runner.calls
        .filter((call) => call.args.includes('set-option'))
        .map((call) => call.args[call.args.indexOf('-t') + 2])
        .sort()
    ).toEqual(
      [
        'window-size',
        '@treeport-name',
        '@treeport-argv',
        '@treeport-created-at',
        '@treeport-updated-at',
        '@treeport-worktree-id',
        '@treeport-terminal-id'
      ].sort()
    )
  })

  it('recovers the macOS SSH agent socket for terminal commands', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    runner.launchctlResponse = {
      stdout: '/private/tmp/com.apple.launchd.test/Listeners\n',
      stderr: '',
      exitCode: 0
    }
    const adapter = new TmuxAdapter(runner, runtime, 'tmux', '/launcher.js', {
      environment: {},
      platform: 'darwin',
      uid: 501
    })

    await adapter.createSession({
      socketName: 'socket',
      sessionName: 'session',
      terminalId: 'term',
      worktreeId: 'wt',
      name: 'Terminal',
      createdAt: '2026-01-02T03:04:05.000Z',
      cwd: '/tmp',
      argv: ['pi'],
      env: { TREEPORT_TERMINAL_ID: 'term' }
    })

    expect(runner.calls[0]).toMatchObject({
      executable: '/bin/launchctl',
      args: ['asuser', '501', '/bin/launchctl', 'getenv', 'SSH_AUTH_SOCK']
    })
    await expect(
      fs
        .readFile(path.join(adapter.specsDir, 'term.json'), 'utf8')
        .then(JSON.parse)
    ).resolves.toMatchObject({
      env: {
        SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.test/Listeners',
        TREEPORT_TERMINAL_ID: 'term'
      }
    })
  })

  it('preserves an inherited SSH agent socket without consulting launchd', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const adapter = new TmuxAdapter(runner, runtime, 'tmux', '/launcher.js', {
      environment: { SSH_AUTH_SOCK: '/agent/socket' },
      platform: 'darwin',
      uid: 501
    })

    await adapter.createSession({
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

    expect(
      runner.calls.some((call) => call.executable === '/bin/launchctl')
    ).toBe(false)
    await expect(
      fs
        .readFile(path.join(adapter.specsDir, 'term.json'), 'utf8')
        .then(JSON.parse)
    ).resolves.toMatchObject({ env: { SSH_AUTH_SOCK: '/agent/socket' } })
  })

  it('creates the terminal when the macOS SSH agent socket is unavailable', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    runner.launchctlResponse = {
      stdout: '',
      stderr: 'No such process',
      exitCode: 1
    }
    const adapter = new TmuxAdapter(runner, runtime, 'tmux', '/launcher.js', {
      environment: {},
      platform: 'darwin',
      uid: 501
    })

    await adapter.createSession({
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

    await expect(
      fs
        .readFile(path.join(adapter.specsDir, 'term.json'), 'utf8')
        .then(JSON.parse)
    ).resolves.toMatchObject({ env: {} })
  })

  it('removes the launch spec when post-creation setup fails', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    runner.responses.push(
      { stdout: 'off\n', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
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
    expect(
      runner.calls.some((call) => call.args.includes('kill-session'))
    ).toBe(true)
  })

  it('stops a newly started empty server when setup fails before session creation', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    runner.responses.push(
      { stdout: '', stderr: 'no server running', exitCode: 1 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'invalid config', exitCode: 1 },
      { stdout: '', stderr: '', exitCode: 0 }
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
    ).rejects.toThrow('invalid config')

    expect(runner.calls.at(-1)?.args).toContain('if-shell')
    expect(runner.calls.at(-1)?.args).toContain('kill-server')
  })

  it('reads the live pane title, foreground command, and remembered shell title from tmux', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const shellTitle = 'zsh · /repo'
    const encode = (value: string) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    runner.responses.push({
      stdout: `${encode(shellTitle)}\tnano\t${shellTitle}\n`,
      stderr: '',
      exitCode: 0
    })
    const adapter = new TmuxAdapter(runner, runtime)

    await expect(
      adapter.sessionTitleState('socket', 'session')
    ).resolves.toEqual({
      paneTitle: shellTitle,
      currentCommand: 'nano',
      shellTitle
    })
    expect(runner.calls[0]!.args).toContain(
      '#{@treeport-shell-title}\t#{pane_current_command}\t#{pane_title}'
    )
  })

  it('stores remembered shell titles as encoded tmux session metadata', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const adapter = new TmuxAdapter(runner, runtime)
    const shellTitle = 'π\t/repo'

    await adapter.setSessionShellTitle('socket', 'session', shellTitle)

    expect(
      runner.calls.map((call) => call.args[call.args.indexOf('-t') + 2])
    ).toEqual(['@treeport-shell-title'])
  })

  it('discovers live tmux terminals from encoded session metadata', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    runner.responses.push({
      stdout: [
        [
          'treeport-term-one',
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
          'treeport-term-two',
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
        [
          'opaque-persisted-session-7f31',
          'term_persisted',
          'wt_one',
          encode('Persisted'),
          encode(['bash']),
          encode('2025-12-01T00:00:00.000Z'),
          encode('2025-12-02T00:00:00.000Z'),
          '1764547200',
          '0',
          ''
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
        sessionName: 'treeport-term-one',
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
        sessionName: 'treeport-term-two',
        argv: ['sh'],
        status: 'exited',
        exitCode: 17,
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z'
      },
      {
        id: 'term_persisted',
        worktreeId: 'wt_one',
        name: 'Persisted',
        sessionName: 'opaque-persisted-session-7f31',
        argv: ['bash'],
        status: 'running',
        exitCode: null,
        createdAt: '2025-12-01T00:00:00.000Z',
        updatedAt: '2025-12-02T00:00:00.000Z'
      }
    ])
  })

  it.each(['no server running on socket', 'no current target'])(
    'treats an absent or empty tmux server as an empty terminal inventory: %s',
    async (stderr) => {
      const runtime = await fs.mkdtemp(
        path.join(os.tmpdir(), 'treeport-runtime-')
      )
      temporary.push(runtime)
      const runner = new RecordingRunner()
      runner.responses.push({
        stdout: '',
        stderr,
        exitCode: 1
      })
      const adapter = new TmuxAdapter(runner, runtime)
      await expect(adapter.listSessions('socket')).resolves.toEqual([])
    }
  )

  it('removes discovered launch specs when killing a worktree server', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    runner.responses.push(
      {
        stdout: [
          'treeport-term-one',
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

    await expect(adapter.killServer('socket')).resolves.toEqual(['term_one'])

    await expect(fs.access(specPath)).rejects.toThrow()
  })

  it('treats a missing worktree server as already stopped', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    runner.responses.push(
      {
        stdout: '',
        stderr: 'error connecting to /tmp/treeport (No such file or directory)',
        exitCode: 1
      },
      {
        stdout: '',
        stderr: 'error connecting to /tmp/treeport (No such file or directory)',
        exitCode: 1
      }
    )
    const adapter = new TmuxAdapter(runner, runtime)

    await expect(adapter.killServer('socket')).resolves.toEqual([])
  })

  it('does not treat tmux connection permission errors as an absent server', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
    temporary.push(runtime)
    const runner = new RecordingRunner()
    runner.responses.push({
      stdout: '',
      stderr: 'error connecting to /tmp/treeport (Permission denied)',
      exitCode: 1
    })
    const adapter = new TmuxAdapter(runner, runtime)

    await expect(adapter.killServer('socket')).rejects.toThrow(
      'Permission denied'
    )
  })

  it('maps a live, exited, or absent pane to product terminal state', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-runtime-')
    )
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
