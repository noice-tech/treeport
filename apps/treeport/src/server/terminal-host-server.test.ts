import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { TerminalHostClient } from './terminal-host-client'
import { startTerminalHostServer } from './terminal-host-server'
import { TerminalHostSessionManager } from './terminal-host-sessions'
import { testAccess } from './test-access'

class FakePty {
  readonly pid: number
  readonly cols = 80
  readonly rows = 24
  readonly process = 'shell'
  handleFlowControl = false
  private dataListener: ((data: string) => void) | null = null
  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | null = null

  constructor(pid: number) {
    this.pid = pid
  }

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

  write() {}
  resize() {}
  kill() {}
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

describe('terminal host request scheduling', () => {
  it('serves a new terminal while unrelated kills clean up and drains cleanup before shutdown', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-server-')
    )
    directories.push(root)
    const socketPath = path.join(root, 'host.sock')
    const ptys: FakePty[] = []
    const spawn = vi.fn(() => {
      const pty = new FakePty(100 + ptys.length)
      ptys.push(pty)
      queueMicrotask(() => pty.emit(`READY_${ptys.indexOf(pty)}\r\n`))
      return testAccess<IPty>(pty)
    })
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    let cleanupEntries = 0
    const terminate = vi.fn(async (child: IPty) => {
      cleanupEntries += 1
      if (child.pid === 101) {
        throw new Error('cleanup failed')
      }

      await cleanupGate
    })
    const sessions = new TerminalHostSessionManager(
      root,
      path.join(root, 'launcher.mjs'),
      // SAFETY: The fake implements the IPty methods used by this boundary.
      spawn as never,
      terminate
    )
    const host = await startTerminalHostServer({
      hostId: 'host',
      hostKey: 'key',
      token: 'token',
      socketPath,
      recordPath: path.join(root, 'host.json'),
      sessions
    })
    const client = await TerminalHostClient.connect(
      socketPath,
      'token',
      'key',
      'host'
    )
    const input = (terminalId: string) => ({
      terminalId,
      worktreeId: 'worktree',
      name: terminalId,
      createdAt: '2026-01-01T00:00:00.000Z',
      cwd: root,
      argv: ['/bin/sh', '-l'],
      shellCommand: null,
      interactiveShell: true,
      env: {}
    })

    try {
      await client.createTerminal(input('old'))
      await vi.waitFor(async () =>
        expect(await client.captureTerminal('old', 10)).toContain('READY_0')
      )

      let firstKillSettled = false
      const firstKill = client.killTerminal('old').finally(() => {
        firstKillSettled = true
      })
      await vi.waitFor(() => expect(cleanupEntries).toBe(1))
      const repeatedKill = client.killTerminal('old')
      await expect(client.terminalState('old')).resolves.toEqual({
        status: 'missing',
        exitCode: null
      })

      await client.createTerminal(input('old'))
      const attachment = await client.attach('old', () => undefined)
      expect(attachment?.data).toContain('READY_1')
      expect(firstKillSettled).toBe(false)

      await expect(client.killTerminal('old')).rejects.toThrow('cleanup failed')
      await vi.waitFor(() => expect(cleanupEntries).toBe(2))
      await client.createTerminal(input('final'))
      const finalKill = client.killTerminal('final')
      await vi.waitFor(() => expect(cleanupEntries).toBe(3))
      let shutdownSettled = false
      const shutdown = client.shutdownIfEmpty().finally(() => {
        shutdownSettled = true
      })
      const lateCreate = client.createTerminal(input('too-late'))
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(shutdownSettled).toBe(false)

      releaseCleanup()
      await expect(
        Promise.all([firstKill, repeatedKill, finalKill, shutdown])
      ).resolves.toBeDefined()
      await expect(lateCreate).rejects.toMatchObject({
        code: 'HOST_SHUTTING_DOWN'
      })
      expect(firstKillSettled).toBe(true)
      expect(spawn).toHaveBeenCalledTimes(3)
      expect(terminate).toHaveBeenCalledTimes(3)
    } finally {
      releaseCleanup()
      client.dispose()
      await sessions.shutdown()
      await host.close()
    }
  })
})
