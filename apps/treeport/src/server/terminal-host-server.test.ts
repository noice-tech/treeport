import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalHostClient } from './terminal-host-client'
import { startTerminalHostServer } from './terminal-host-server'
import type { TerminalHostSessionManager } from './terminal-host-sessions'
import { testAccess } from './test-access'
import type { TreeportSpanAttributes } from './tracing'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('terminal host request scheduling', () => {
  it('creates a terminal while an unrelated kill is pending', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-terminal-host-server-')
    )
    directories.push(root)
    let releaseKill!: () => void
    let markKillStarted!: () => void
    const killGate = new Promise<void>((resolve) => {
      releaseKill = resolve
    })
    const killStarted = new Promise<void>((resolve) => {
      markKillStarted = resolve
    })
    const createTerminal = vi.fn(async () => undefined)
    const traced: Array<{
      name: string
      parent: { traceId: string; spanId: string; sampled: boolean }
      attributes: TreeportSpanAttributes
    }> = []
    const sessions = testAccess<TerminalHostSessionManager>({
      sessionCount: 0,
      initialize: async () => undefined,
      createTerminal,
      killTerminal: async () => {
        markKillStarted()
        await killGate
      },
      restoreHostQueryAuthority: async () => undefined
    })
    const host = await startTerminalHostServer({
      hostId: 'host',
      hostKey: 'key',
      token: 'token',
      socketPath: path.join(root, 'host.sock'),
      recordPath: path.join(root, 'host.json'),
      sessions,
      trace: async (name, parent, attributes, evaluate) => {
        traced.push({ name, parent, attributes })
        return evaluate()
      }
    })
    const client = await TerminalHostClient.connect(
      host.record.socketPath,
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

    const trace = {
      traceId: '1234567890abcdef1234567890abcdef',
      spanId: '1234567890abcdef',
      sampled: true
    }

    try {
      await client.createTerminal(input('old'))
      const killing = client.killTerminal('old', trace)
      await killStarted
      await expect(
        client.createTerminal(input('new'), trace)
      ).resolves.toBeUndefined()
      expect(createTerminal).toHaveBeenCalledTimes(2)
      expect(traced).toEqual([
        {
          name: 'treeport.terminal_host.pty.remove',
          parent: trace,
          attributes: {
            'treeport.terminal_host.method': 'kill',
            'treeport.terminal_host.queue_wait_ms': expect.any(Number)
          }
        },
        {
          name: 'treeport.terminal_host.pty.create',
          parent: trace,
          attributes: {
            'treeport.terminal_host.method': 'create',
            'treeport.terminal_host.queue_wait_ms': expect.any(Number)
          }
        }
      ])
      releaseKill()
      await killing
    } finally {
      releaseKill()
      client.dispose()
      await host.close()
    }
  })
})
