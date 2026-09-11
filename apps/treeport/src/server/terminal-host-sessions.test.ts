import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import xtermHeadless from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import {
  makeTerminalHostSessions,
  type TerminalHostRuntimeEvent
} from './terminal-host-sessions'
import { testAccess } from './test-access'

const { Terminal } = xtermHeadless

class FakePty {
  readonly pid = 42
  readonly cols = 80
  readonly rows = 24
  readonly process = 'shell'
  handleFlowControl = false
  writes: Array<string | Buffer> = []
  resizes: Array<[number, number]> = []
  kills = 0
  pauses = 0
  resumes = 0
  dataDisposals = 0
  exitDisposals = 0
  private dataListener: ((data: string) => void) | null = null
  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | null = null

  onData(listener: (data: string) => void) {
    this.dataListener = listener
    return {
      dispose: () => {
        this.dataDisposals += 1
        this.dataListener = null
      }
    }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener
    return {
      dispose: () => {
        this.exitDisposals += 1
        this.exitListener = null
      }
    }
  }

  emit(data: string) {
    this.dataListener?.(data)
  }

  exit(exitCode: number) {
    this.exitListener?.({ exitCode })
  }

  write(data: string | Buffer) {
    this.writes.push(data)
  }

  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows])
  }

  kill() {
    this.kills += 1
  }

  pause() {
    this.pauses += 1
  }
  resume() {
    this.resumes += 1
  }
  clear() {}
}

const directories: string[] = []
const scopes: Scope.CloseableScope[] = []
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Scope.extend(effect, scopes.at(-1)!))
const acquire = async (
  options: Parameters<typeof makeTerminalHostSessions>[0]
) => {
  const scope = await Effect.runPromise(Scope.make())
  scopes.push(scope)
  return Effect.runPromise(
    Scope.extend(makeTerminalHostSessions(options), scope)
  )
}
afterEach(async () => {
  await Promise.all(
    scopes
      .splice(0)
      .map((scope) => Effect.runPromise(Scope.close(scope, Exit.void)))
  )
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('TerminalHostSessionManager', () => {
  it('owns one child PTY while viewers share fenced canonical history and live output', async () => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-')
    )
    directories.push(runtimeDir)
    const pty = new FakePty()
    const spawn = vi.fn(() => {
      queueMicrotask(() => pty.emit('immediate startup output\r\n'))
      return testAccess<IPty>(pty)
    })
    const terminate = vi.fn(async (child: IPty) => child.kill())
    const manager = await acquire({
      runtimeDir,
      launcherPath: '/treeport/launcher.js',
      // SAFETY: The fake implements the IPty methods used by this boundary.
      spawnPty: spawn as never,
      terminateProcessTree: (child) =>
        Effect.tryPromise({
          try: () => terminate(child),
          catch: (cause) => cause
        }),
      progressStaleMs: 50
    })

    await run(
      manager.createTerminal({
        terminalId: 'term',
        worktreeId: 'worktree',
        name: 'Shell',
        createdAt: '2026-01-01T00:00:00.000Z',
        cwd: runtimeDir,
        argv: ['/bin/bash', '-l'],
        shellCommand: null,
        interactiveShell: true,
        initialSize: { cols: 80, rows: 24 },
        env: { HOME: '/home/test', TREEPORT_TERMINAL_ID: 'term' }
      })
    )

    expect(spawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-l'],
      expect.objectContaining({
        cwd: runtimeDir,
        cols: 80,
        rows: 24,
        env: expect.objectContaining({
          TERM: 'xterm-256color',
          TREEPORT_TERMINAL_ID: 'term',
          TREEPORT_SHELL_INTEGRATION: '1',
          TREEPORT_USER_HOME: '/home/test',
          HOME: path.join(runtimeDir, 'terminal-shell-integration/bash/home')
        })
      })
    )
    await expect(
      fs.readdir(path.join(runtimeDir, 'terminal-specs'))
    ).resolves.toEqual([])

    const firstOutput: string[] = []
    const secondOutput: string[] = []
    const runtimeEvents: TerminalHostRuntimeEvent[] = []
    const firstAttachment = await run(manager.attach('term'))
    const secondAttachment = await run(manager.attach('term'))
    await run(
      Effect.forkScoped(
        Stream.runForEach(firstAttachment!.output, ({ data }) =>
          Effect.sync(() => firstOutput.push(data))
        )
      )
    )
    await run(
      Effect.forkScoped(
        Stream.runForEach(secondAttachment!.output, ({ data }) =>
          Effect.sync(() => secondOutput.push(data))
        )
      )
    )
    await run(
      Effect.forkScoped(
        Stream.runForEach(manager.runtimeEvents('term'), (event) =>
          Effect.sync(() => runtimeEvents.push(event))
        )
      )
    )
    pty.emit(
      '\u001b]2;Terminal title\u0007\u001b]777;command;pnpm test\u001b\\\u001b]9;4;1;50\u001b\\\u0007before attach \u001b]8;;https://example.test/issue/42\u001b\\#42\u001b]8;;\u001b\\\r\n'
    )
    const snapshot = await run(manager.snapshot('term'))
    expect(await run(manager.runtimeState('term'))).toMatchObject({
      progress: { state: 'normal', value: 50 },
      bell: { sequence: 1 }
    })
    await vi.waitFor(async () =>
      expect((await run(manager.runtimeState('term')))?.progress).toBeNull()
    )
    expect(runtimeEvents).toContainEqual({ progress: null })
    pty.emit('after attach\r\n')

    expect(spawn).toHaveBeenCalledOnce()
    expect(snapshot?.data).toContain('immediate startup output')
    expect(snapshot?.data).toContain('before attach')
    expect(snapshot?.links).toEqual([
      expect.objectContaining({
        buffer: 'normal',
        uri: 'https://example.test/issue/42'
      })
    ])
    await vi.waitFor(() => expect(firstOutput).toHaveLength(2))
    expect(firstOutput).toEqual([
      '\u001b]2;Terminal title\u0007\u001b]777;command;pnpm test\u001b\\\u001b]9;4;1;50\u001b\\\u0007before attach \u001b]8;;https://example.test/issue/42\u001b\\#42\u001b]8;;\u001b\\\r\n',
      'after attach\r\n'
    ])
    expect(secondOutput).toEqual(firstOutput)

    pty.emit('normal Unicode: λ🙂\r\n')
    pty.emit('\u001b[?1049halternate Unicode: 雪\r\n')
    const alternateSnapshot = await run(manager.snapshot('term'))
    const browser = new Terminal({
      cols: alternateSnapshot!.cols,
      rows: alternateSnapshot!.rows,
      scrollback: 50_000,
      allowProposedApi: true,
      disableStdin: true
    })
    const historicalResponses: string[] = []
    browser.onData((data) => historicalResponses.push(data))
    await new Promise<void>((resolve) =>
      browser.write(alternateSnapshot!.data, resolve)
    )
    const activeContent = Array.from(
      { length: browser.buffer.active.length },
      (_, index) =>
        browser.buffer.active.getLine(index)?.translateToString(true) ?? ''
    ).join('\n')
    const normalContent = Array.from(
      { length: browser.buffer.normal.length },
      (_, index) =>
        browser.buffer.normal.getLine(index)?.translateToString(true) ?? ''
    ).join('\n')
    expect(activeContent).toContain('alternate Unicode: 雪')
    expect(normalContent).toContain('normal Unicode: λ🙂')
    expect(historicalResponses).toEqual([])
    browser.dispose()

    pty.emit('\u001b[?1049l')
    pty.emit(
      Array.from(
        { length: 2_000 },
        (_, index) => `history-${index.toString().padStart(4, '0')}-🙂\r\n`
      ).join('')
    )
    await run(manager.resize('term', 40, 12))
    const reflowedSnapshot = await run(manager.snapshot('term'))
    const reconnected = new Terminal({
      cols: reflowedSnapshot!.cols,
      rows: reflowedSnapshot!.rows,
      scrollback: 50_000,
      allowProposedApi: true,
      disableStdin: true
    })
    await new Promise<void>((resolve) =>
      reconnected.write(reflowedSnapshot!.data, resolve)
    )
    const reconnectedContent = Array.from(
      { length: reconnected.buffer.active.length },
      (_, index) =>
        reconnected.buffer.active.getLine(index)?.translateToString(true) ?? ''
    ).join('\n')
    expect(reconnectedContent).toContain('history-0000-🙂')
    expect(reconnectedContent).toContain('history-1999-🙂')
    reconnected.dispose()

    expect(runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Terminal title' }),
        expect.objectContaining({
          titleState: expect.objectContaining({ commandLine: 'pnpm test' })
        }),
        { progress: { state: 'normal', value: 50 } },
        {
          bell: expect.objectContaining({
            sequence: 1,
            at: expect.any(String)
          })
        }
      ])
    )
    await expect(run(manager.captureTerminal('term', 10))).resolves.toContain(
      'history-1999-🙂'
    )

    // The canonical headless terminal answers while detached.
    pty.emit('\u001b[6n')
    await run(manager.snapshot('term'))
    expect(pty.writes).toHaveLength(1)
    expect(pty.writes[0]).toMatch(
      new RegExp(String.raw`^\u001b\[\d+;\d+R$`, 'u')
    )

    // A paused parser fence hands query authority to one browser. The
    // historical snapshot cannot answer the old query again.
    const transition = await run(manager.prepareQueryAuthority('term'))
    await run(
      manager.activateQueryAuthority(
        'term',
        transition.transitionId,
        'viewer',
        2
      )
    )
    pty.emit('\u001b[6n')
    await run(manager.snapshot('term'))
    expect(pty.writes).toHaveLength(1)

    const pausesBeforeFlood = pty.pauses
    for (let index = 0; index < 18; index += 1) {
      pty.emit('x'.repeat(64 * 1024))
    }
    await run(
      manager.write('term', 'responsive-input', {
        attachmentId: 'viewer',
        generation: 2
      })
    )
    expect(pty.writes.at(-1)).toBe('responsive-input')
    expect(pty.pauses).toBeGreaterThan(pausesBeforeFlood)
    await run(manager.snapshot('term'))
    expect(pty.resumes).toBeGreaterThan(0)

    await run(
      manager.write('term', 'ignored', {
        attachmentId: 'other-viewer',
        generation: 2
      })
    )
    await run(
      manager.write('term', 'input', {
        attachmentId: 'viewer',
        generation: 2
      })
    )
    expect(pty.writes.at(-1)).toBe('input')

    // Handoff to the detached responder happens behind another parser fence.
    await run(manager.useHostQueryAuthority('term'))
    pty.emit('\u001b[6n')
    await run(manager.snapshot('term'))
    expect(
      pty.writes.filter(
        (value) => value !== 'input' && value !== 'responsive-input'
      )
    ).toHaveLength(2)

    await run(manager.resize('term', 100, 30))
    expect(pty.resizes).toEqual([
      [40, 12],
      [100, 30]
    ])

    pty.exit(7)
    await expect(run(manager.terminalState('term'))).resolves.toEqual({
      status: 'exited',
      exitCode: 7
    })
    await run(manager.shutdown())
    expect(terminate).toHaveBeenCalledOnce()
    expect(pty.kills).toBe(1)
  })

  it('releases scoped pauses and authority transitions during teardown', async () => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-')
    )
    directories.push(runtimeDir)
    const pty = new FakePty()
    const manager = await acquire({
      runtimeDir,
      launcherPath: '/treeport/launcher.js',
      // SAFETY: The fake implements the IPty methods used by this boundary.
      spawnPty: (() => testAccess<IPty>(pty)) as never,
      terminateProcessTree: (child) => Effect.sync(() => child.kill())
    })
    await run(
      manager.createTerminal({
        terminalId: 'term',
        worktreeId: 'worktree',
        name: 'Shell',
        createdAt: '2026-01-01T00:00:00.000Z',
        cwd: runtimeDir,
        argv: ['/bin/sh', '-l'],
        shellCommand: null,
        interactiveShell: true,
        env: {}
      })
    )

    const pauseScope = await Effect.runPromise(Scope.make())
    expect(
      await Effect.runPromise(
        Scope.extend(manager.pauseOutput('term'), pauseScope)
      )
    ).toBe(true)
    expect(pty.pauses).toBe(1)
    await Effect.runPromise(Scope.close(pauseScope, Exit.void))
    expect(pty.resumes).toBe(1)

    await run(manager.prepareQueryAuthority('term'))
    expect(pty.pauses).toBe(2)
    await run(manager.killTerminal('term'))
    expect(pty.resumes).toBe(2)
    expect(pty.dataDisposals).toBe(1)
    expect(pty.exitDisposals).toBe(1)

    await run(manager.shutdown())
    expect(pty.dataDisposals).toBe(1)
    expect(pty.exitDisposals).toBe(1)
  })

  it('keeps fallback sessions on the launcher path until exit', async () => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-')
    )
    directories.push(runtimeDir)
    const pty = new FakePty()
    const spawn = vi.fn(() => testAccess<IPty>(pty))
    const manager = await acquire({
      runtimeDir,
      launcherPath: '/treeport/launcher.js',
      // SAFETY: The fake implements the IPty methods used by this boundary.
      spawnPty: spawn as never,
      terminateProcessTree: (child) => Effect.sync(() => child.kill())
    })

    await run(
      manager.createTerminal({
        terminalId: 'term',
        worktreeId: 'worktree',
        name: 'Command',
        createdAt: '2026-01-01T00:00:00.000Z',
        cwd: runtimeDir,
        argv: ['/bin/sh'],
        shellCommand: null,
        interactiveShell: true,
        fallbackArgv: ['/bin/sh', '-l'],
        env: {}
      })
    )

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/treeport/launcher.js', expect.stringContaining('terminal-specs')],
      expect.objectContaining({ cwd: runtimeDir })
    )
    await expect(
      fs.readdir(path.join(runtimeDir, 'terminal-specs'))
    ).resolves.toHaveLength(1)
    pty.exit(0)
    await vi.waitFor(async () =>
      expect(
        await fs.readdir(path.join(runtimeDir, 'terminal-specs'))
      ).toHaveLength(0)
    )
    await run(manager.shutdown())
  })

  it('keeps physical cleanup owned after the requesting fiber is interrupted', async () => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-')
    )
    directories.push(runtimeDir)
    const pty = new FakePty()
    const cleanupStarted = await Effect.runPromise(Deferred.make<void>())
    const releaseCleanup = await Effect.runPromise(Deferred.make<void>())
    let cleanupFinished = false
    const manager = await acquire({
      runtimeDir,
      launcherPath: '/treeport/launcher.js',
      // SAFETY: The fake implements the IPty methods used by this boundary.
      spawnPty: (() => testAccess<IPty>(pty)) as never,
      terminateProcessTree: () =>
        Deferred.succeed(cleanupStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(releaseCleanup)),
          Effect.tap(() =>
            Effect.sync(() => {
              cleanupFinished = true
            })
          )
        )
    })
    await run(
      manager.createTerminal({
        terminalId: 'term',
        worktreeId: 'worktree',
        name: 'Shell',
        createdAt: '2026-01-01T00:00:00.000Z',
        cwd: runtimeDir,
        argv: ['/bin/sh', '-l'],
        shellCommand: null,
        interactiveShell: true,
        env: {}
      })
    )

    const requestingFiber = Effect.runFork(manager.killTerminal('term'))
    await Effect.runPromise(Deferred.await(cleanupStarted))
    await Effect.runPromise(Fiber.interrupt(requestingFiber))
    expect(await run(manager.terminalState('term'))).toEqual({
      status: 'missing',
      exitCode: null
    })
    expect(cleanupFinished).toBe(false)

    await Effect.runPromise(Deferred.succeed(releaseCleanup, undefined))
    await run(manager.shutdown())
    expect(cleanupFinished).toBe(true)
  })

  it('reports cleanup failure without retaining or poisoning the terminal ID', async () => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-')
    )
    directories.push(runtimeDir)
    const ptys = [new FakePty(), new FakePty()]
    const spawn = vi.fn(() => testAccess<IPty>(ptys.shift()!))
    const terminate = vi
      .fn<(child: IPty) => Promise<void>>()
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValue(undefined)
    const manager = await acquire({
      runtimeDir,
      launcherPath: '/treeport/launcher.js',
      // SAFETY: The fake implements the IPty methods used by this boundary.
      spawnPty: spawn as never,
      terminateProcessTree: (child) =>
        Effect.tryPromise({
          try: () => terminate(child),
          catch: (cause) => cause
        })
    })
    const input = (name: string) => ({
      terminalId: 'term',
      worktreeId: 'worktree',
      name,
      createdAt: '2026-01-01T00:00:00.000Z',
      cwd: runtimeDir,
      argv: ['/bin/sh', '-l'],
      shellCommand: null,
      interactiveShell: true,
      env: {}
    })

    await run(manager.createTerminal(input('First')))
    await expect(run(manager.killTerminal('term'))).rejects.toThrow(
      'cleanup failed'
    )
    await expect(run(manager.terminalState('term'))).resolves.toEqual({
      status: 'missing',
      exitCode: null
    })

    await expect(
      run(manager.createTerminal(input('Replacement')))
    ).resolves.toBeUndefined()
    await expect(run(manager.shutdown())).resolves.toBeUndefined()
    expect(terminate).toHaveBeenCalledTimes(2)
  })
})
