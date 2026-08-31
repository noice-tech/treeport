import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import xtermHeadless from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import {
  TerminalHostSessionManager,
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
  private dataListener: ((data: string) => void) | null = null
  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | null = null

  onData(listener: (data: string) => void) {
    this.dataListener = listener
    return { dispose: () => (this.dataListener = null) }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener
    return { dispose: () => (this.exitListener = null) }
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
afterEach(async () => {
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
    const spawn = vi.fn(() => testAccess<IPty>(pty))
    const terminate = vi.fn(async (child: IPty) => child.kill())
    const manager = new TerminalHostSessionManager(
      runtimeDir,
      '/treeport/launcher.js',
      // SAFETY: The fake implements the IPty methods used by this boundary.
      spawn as never,
      terminate,
      50
    )

    await manager.createTerminal({
      terminalId: 'term',
      worktreeId: 'worktree',
      name: 'Shell',
      createdAt: '2026-01-01T00:00:00.000Z',
      cwd: runtimeDir,
      argv: ['/bin/sh'],
      shellCommand: null,
      interactiveShell: true,
      initialSize: { cols: 80, rows: 24 },
      env: {}
    })

    const firstOutput: string[] = []
    const secondOutput: string[] = []
    const runtimeEvents: TerminalHostRuntimeEvent[] = []
    manager.subscribeOutput('term', (data) => firstOutput.push(data))
    manager.subscribeOutput('term', (data) => secondOutput.push(data))
    manager.subscribeRuntime('term', (event) => runtimeEvents.push(event))
    pty.emit(
      '\u001b]2;Terminal title\u0007\u001b]777;command;pnpm test\u001b\\\u001b]9;4;1;50\u001b\\\u0007before attach\r\n'
    )
    const snapshot = await manager.snapshot('term')
    expect(manager.runtimeState('term')).toMatchObject({
      progress: { state: 'normal', value: 50 },
      bell: { sequence: 1 }
    })
    await vi.waitFor(() =>
      expect(manager.runtimeState('term')?.progress).toBeNull()
    )
    expect(runtimeEvents).toContainEqual({ progress: null })
    pty.emit('after attach\r\n')

    expect(spawn).toHaveBeenCalledOnce()
    expect(snapshot?.data).toContain('before attach')
    await vi.waitFor(() => expect(firstOutput).toHaveLength(2))
    expect(firstOutput).toEqual([
      '\u001b]2;Terminal title\u0007\u001b]777;command;pnpm test\u001b\\\u001b]9;4;1;50\u001b\\\u0007before attach\r\n',
      'after attach\r\n'
    ])
    expect(secondOutput).toEqual(firstOutput)

    pty.emit('normal Unicode: λ🙂\r\n')
    pty.emit('\u001b[?1049halternate Unicode: 雪\r\n')
    const alternateSnapshot = await manager.snapshot('term')
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
    await manager.resize('term', 40, 12)
    const reflowedSnapshot = await manager.snapshot('term')
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
    await expect(manager.captureTerminal('term', 10)).resolves.toContain(
      'history-1999-🙂'
    )

    // The canonical headless terminal answers while detached.
    pty.emit('\u001b[6n')
    await manager.snapshot('term')
    expect(pty.writes).toHaveLength(1)
    expect(pty.writes[0]).toMatch(
      new RegExp(String.raw`^\u001b\[\d+;\d+R$`, 'u')
    )

    // A paused parser fence hands query authority to one browser. The
    // historical snapshot cannot answer the old query again.
    const transition = await manager.prepareQueryAuthority('term')
    await manager.activateQueryAuthority(
      'term',
      transition.transitionId,
      'viewer',
      2
    )
    pty.emit('\u001b[6n')
    await manager.snapshot('term')
    expect(pty.writes).toHaveLength(1)

    const pausesBeforeFlood = pty.pauses
    for (let index = 0; index < 18; index += 1) {
      pty.emit('x'.repeat(64 * 1024))
    }
    manager.write('term', 'responsive-input', {
      attachmentId: 'viewer',
      generation: 2
    })
    expect(pty.writes.at(-1)).toBe('responsive-input')
    expect(pty.pauses).toBeGreaterThan(pausesBeforeFlood)
    await manager.snapshot('term')
    expect(pty.resumes).toBeGreaterThan(0)

    manager.write('term', 'ignored', {
      attachmentId: 'other-viewer',
      generation: 2
    })
    manager.write('term', 'input', {
      attachmentId: 'viewer',
      generation: 2
    })
    expect(pty.writes.at(-1)).toBe('input')

    // Handoff to the detached responder happens behind another parser fence.
    await manager.useHostQueryAuthority('term')
    pty.emit('\u001b[6n')
    await manager.snapshot('term')
    expect(
      pty.writes.filter(
        (value) => value !== 'input' && value !== 'responsive-input'
      )
    ).toHaveLength(2)

    await manager.resize('term', 100, 30)
    expect(pty.resizes).toEqual([
      [40, 12],
      [100, 30]
    ])

    pty.exit(7)
    await expect(manager.terminalState('term')).resolves.toEqual({
      status: 'exited',
      exitCode: 7
    })
    await manager.shutdown()
    expect(terminate).toHaveBeenCalledOnce()
    expect(pty.kills).toBe(1)
  })
})
