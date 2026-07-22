import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { runLaunchSpec } from './launcher.js'
import type { LaunchSpec } from './tmux.js'

class FakeChild extends EventEmitter {
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    queueMicrotask(() =>
      this.emit('exit', null, typeof signal === 'string' ? signal : 'SIGTERM')
    )
    return true
  })
}

function writable() {
  let value = ''
  return {
    stream: {
      write: (chunk: string | Uint8Array) => ((value += String(chunk)), true)
    },
    value: () => value
  }
}

function spec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    argv: ['final', 'hostile;argument'],
    cwd: '/worktree',
    env: { TASKTTY_TERMINAL_ID: 'term' },
    ...overrides
  }
}

describe('terminal launcher setup pipeline', () => {
  it('runs setup tasks sequentially before the exact final argv', async () => {
    const calls: Array<{
      executable: string
      args: readonly string[]
      options: unknown
    }> = []
    const results = [0, 0, 7]
    const spawnProcess = vi.fn(
      (executable: string, args: readonly string[], options: unknown) => {
        calls.push({ executable, args, options })
        const child = new FakeChild()
        queueMicrotask(() => child.emit('exit', results.shift(), null))
        return child as unknown as ChildProcess
      }
    ) as unknown as typeof spawn
    const output = writable()
    const error = writable()
    const code = await runLaunchSpec(
      spec({
        setupTasks: [
          {
            label: 'first',
            argv: ['one', 'a b'],
            cwd: '/one',
            env: { ONE: '1' },
            timeoutMs: 100
          },
          {
            label: 'second',
            argv: ['two', '$HOME'],
            cwd: '/two',
            env: { TWO: '2' },
            timeoutMs: 100
          }
        ]
      }),
      {
        spawnProcess,
        stdout: output.stream,
        stderr: error.stream,
        signalSource: new EventEmitter()
      }
    )

    expect(code).toBe(7)
    expect(calls.map(({ executable, args }) => [executable, ...args])).toEqual([
      ['one', 'a b'],
      ['two', '$HOME'],
      ['final', 'hostile;argument']
    ])
    expect(calls[0]?.options).toMatchObject({
      cwd: '/one',
      shell: false,
      stdio: 'inherit',
      env: expect.objectContaining({ TASKTTY_TERMINAL_ID: 'term', ONE: '1' })
    })
    expect(output.value()).toContain('[TaskTTY setup] first\n')
    expect(output.value()).toContain('[TaskTTY setup] second complete\n')
    expect(error.value()).toBe('')
  })

  it('starts a fallback shell after the final command exits', async () => {
    const calls: string[][] = []
    const results = [23, 0]
    const spawnProcess = vi.fn(
      (executable: string, args: readonly string[]) => {
        calls.push([executable, ...args])
        const child = new FakeChild()
        queueMicrotask(() => child.emit('exit', results.shift(), null))
        return child as unknown as ChildProcess
      }
    ) as unknown as typeof spawn

    await expect(
      runLaunchSpec(spec({ fallbackArgv: ['/bin/zsh', '-l'] }), {
        spawnProcess,
        signalSource: new EventEmitter()
      })
    ).resolves.toBe(0)
    expect(calls).toEqual([
      ['final', 'hostile;argument'],
      ['/bin/zsh', '-l']
    ])
  })

  it('starts a fallback shell after the final command cannot be spawned', async () => {
    const calls: string[][] = []
    const spawnProcess = vi.fn(
      (executable: string, args: readonly string[]) => {
        calls.push([executable, ...args])
        const child = new FakeChild()
        queueMicrotask(() =>
          executable === 'missing'
            ? child.emit('error', new Error('not found'))
            : child.emit('exit', 0, null)
        )
        return child as unknown as ChildProcess
      }
    ) as unknown as typeof spawn
    const error = writable()

    await expect(
      runLaunchSpec(
        spec({ argv: ['missing'], fallbackArgv: ['/bin/zsh', '-l'] }),
        {
          spawnProcess,
          stderr: error.stream,
          signalSource: new EventEmitter()
        }
      )
    ).resolves.toBe(0)
    expect(calls).toEqual([['missing'], ['/bin/zsh', '-l']])
    expect(error.value()).toContain('not found')
  })

  it('starts a fallback shell after Ctrl-C but not terminal teardown', async () => {
    const firstChild = new FakeChild()
    const shell = new FakeChild()
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild as unknown as ChildProcess)
      .mockImplementationOnce(() => {
        queueMicrotask(() => shell.emit('exit', 0, null))
        return shell as unknown as ChildProcess
      }) as unknown as typeof spawn
    const signalSource = new EventEmitter()
    const launch = runLaunchSpec(spec({ fallbackArgv: ['/bin/zsh', '-l'] }), {
      spawnProcess,
      signalSource
    })
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
    signalSource.emit('SIGINT')
    await expect(launch).resolves.toBe(0)
    expect(spawnProcess).toHaveBeenCalledTimes(2)

    const teardownChild = new FakeChild()
    const teardownSpawn = vi.fn(
      () => teardownChild as unknown as ChildProcess
    ) as unknown as typeof spawn
    const teardownSignals = new EventEmitter()
    const teardown = runLaunchSpec(spec({ fallbackArgv: ['/bin/zsh', '-l'] }), {
      spawnProcess: teardownSpawn,
      signalSource: teardownSignals
    })
    await vi.waitFor(() => expect(teardownSpawn).toHaveBeenCalledTimes(1))
    teardownSignals.emit('SIGHUP')
    await expect(teardown).resolves.toBe(1)
    expect(teardownSpawn).toHaveBeenCalledTimes(1)
  })

  it('stops on the first setup failure and does not start the final command', async () => {
    const spawnProcess = vi.fn(() => {
      const child = new FakeChild()
      queueMicrotask(() => child.emit('exit', 23, null))
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
    const error = writable()
    const code = await runLaunchSpec(
      spec({
        setupTasks: [
          {
            label: 'bad',
            argv: ['false'],
            cwd: '/worktree',
            env: {},
            timeoutMs: 100
          },
          {
            label: 'skipped',
            argv: ['echo'],
            cwd: '/worktree',
            env: {},
            timeoutMs: 100
          }
        ]
      }),
      {
        spawnProcess,
        stderr: error.stream,
        stdout: writable().stream,
        signalSource: new EventEmitter()
      }
    )

    expect(code).toBe(23)
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(error.value()).toContain('bad failed: exit 23')
  })

  it('forwards termination signals to the active child', async () => {
    const child = new FakeChild()
    const spawnProcess = vi.fn(
      () => child as unknown as ChildProcess
    ) as unknown as typeof spawn
    const signalSource = new EventEmitter()
    const launch = runLaunchSpec(spec(), { spawnProcess, signalSource })
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
    signalSource.emit('SIGINT')
    await expect(launch).resolves.toBe(1)
    expect(child.kill).toHaveBeenCalledWith('SIGINT')
  })

  it('does not continue when a setup child handles a forwarded signal and exits cleanly', async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>
    }
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0, null))
      return true
    })
    const spawnProcess = vi.fn(
      () => child as unknown as ChildProcess
    ) as unknown as typeof spawn
    const signalSource = new EventEmitter()
    const error = writable()
    const launch = runLaunchSpec(
      spec({
        setupTasks: [
          {
            label: 'traps signal',
            argv: ['setup'],
            cwd: '/worktree',
            env: {},
            timeoutMs: 100
          }
        ]
      }),
      {
        spawnProcess,
        signalSource,
        stderr: error.stream,
        stdout: writable().stream
      }
    )
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
    signalSource.emit('SIGTERM')
    await expect(launch).resolves.toBe(1)
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(error.value()).toContain('terminated by SIGTERM')
  })

  it('sanitizes setup diagnostics before writing terminal markers', async () => {
    const spawnProcess = vi.fn(() => {
      const child = new FakeChild()
      queueMicrotask(() => child.emit('exit', 2, null))
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
    const output = writable()
    const error = writable()
    await runLaunchSpec(
      spec({
        setupTasks: [
          {
            label: 'unsafe\u001b[31m\nlabel',
            argv: ['false'],
            cwd: '/worktree',
            env: {},
            timeoutMs: 100
          }
        ]
      }),
      {
        spawnProcess,
        stdout: output.stream,
        stderr: error.stream,
        signalSource: new EventEmitter()
      }
    )
    expect(`${output.value()}${error.value()}`).not.toContain('\u001b')
    expect(output.value()).toContain('unsafe [31m label')
  })

  it('prints a preparation error without spawning any command', async () => {
    const spawnProcess = vi.fn() as unknown as typeof spawn
    const error = writable()
    await expect(
      runLaunchSpec(spec({ setupError: 'invalid compatible task file' }), {
        spawnProcess,
        stderr: error.stream,
        signalSource: new EventEmitter()
      })
    ).resolves.toBe(1)
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(error.value()).toContain('invalid compatible task file')
  })

  it('times out a setup task and skips the final command', async () => {
    const child = new FakeChild()
    const spawnProcess = vi.fn(
      () => child as unknown as ChildProcess
    ) as unknown as typeof spawn
    const error = writable()
    const code = await runLaunchSpec(
      spec({
        setupTasks: [
          {
            label: 'slow',
            argv: ['sleep'],
            cwd: '/worktree',
            env: {},
            timeoutMs: 1
          }
        ]
      }),
      {
        spawnProcess,
        stderr: error.stream,
        stdout: writable().stream,
        signalSource: new EventEmitter()
      }
    )
    expect(code).toBe(124)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(error.value()).toContain('timed out')
  })
})
