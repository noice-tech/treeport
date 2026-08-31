import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import {
  DirectPtySessionManager,
  type DirectPtyRuntimeEvent
} from './direct-pty-sessions'
import { testAccess } from './test-access'

class FakePty {
  readonly pid = 42
  readonly cols = 80
  readonly rows = 24
  readonly process = 'shell'
  handleFlowControl = false
  writes: Array<string | Buffer> = []
  resizes: Array<[number, number]> = []
  kills = 0
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

  pause() {}
  resume() {}
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

describe('DirectPtySessionManager', () => {
  it('owns one child PTY while viewers share fenced canonical history and live output', async () => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-direct-')
    )
    directories.push(runtimeDir)
    const pty = new FakePty()
    const spawn = vi.fn(() => testAccess<IPty>(pty))
    const manager = new DirectPtySessionManager(
      runtimeDir,
      '/treeport/launcher.js',
      // SAFETY: The fake implements the IPty methods used by this boundary.
      spawn as never
    )

    await manager.createSession({
      socketName: 'tree',
      sessionName: 'session',
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
    const runtimeEvents: DirectPtyRuntimeEvent[] = []
    manager.subscribeOutput('term', (data) => firstOutput.push(data))
    manager.subscribeOutput('term', (data) => secondOutput.push(data))
    manager.subscribeRuntime('term', (event) => runtimeEvents.push(event))
    pty.emit(
      '\u001b]2;Direct title\u0007\u001b]9;4;1;50\u001b\\\u0007before attach\r\n'
    )
    const snapshot = await manager.snapshot('term')
    pty.emit('after attach\r\n')

    expect(spawn).toHaveBeenCalledOnce()
    expect(snapshot?.data).toContain('before attach')
    await vi.waitFor(() => expect(firstOutput).toHaveLength(2))
    expect(firstOutput).toEqual([
      '\u001b]2;Direct title\u0007\u001b]9;4;1;50\u001b\\\u0007before attach\r\n',
      'after attach\r\n'
    ])
    expect(secondOutput).toEqual(firstOutput)
    expect(runtimeEvents).toEqual(
      expect.arrayContaining([
        { title: 'Direct title' },
        { progress: { state: 'normal', value: 50 } },
        { bell: true }
      ])
    )
    await expect(manager.capturePane('tree', 'session', 10)).resolves.toContain(
      'after attach'
    )

    // Headless history is replay-only and has stdin disabled. A terminal query
    // cannot answer the child; the single browser controller is the authority.
    pty.emit('\u001b[6n')
    await manager.snapshot('term')
    expect(pty.writes).toEqual([])

    manager.write('term', 'input')
    await manager.resize('term', 100, 30)
    expect(pty.writes).toEqual(['input'])
    expect(pty.resizes).toEqual([[100, 30]])

    pty.exit(7)
    await expect(manager.sessionState('tree', 'session')).resolves.toEqual({
      status: 'exited',
      exitCode: 7
    })
    manager.dispose()
    expect(pty.kills).toBe(1)
  })
})
