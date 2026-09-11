/* eslint-disable anti-slop/no-chained-type-assertions -- The test uses a deliberately partial service double. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalHostClient } from './terminal-host-client'
import { makeTerminalHostServer } from './terminal-host-server'
import type { TerminalHostSessions } from './terminal-host-sessions'

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
    const createTerminal = vi.fn(() => Effect.void)
    // SAFETY: This test exercises only the explicitly mocked server session methods.
    const sessions = {
      sessionCount: Effect.succeed(0),
      initialize: () => Effect.succeed(true),
      createTerminal,
      killTerminal: () =>
        Effect.promise(() => {
          markKillStarted()
          return killGate
        }),
      restoreHostQueryAuthority: () => Effect.void,
      shutdown: () => Effect.void
    } as unknown as TerminalHostSessions
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

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeTerminalHostServer({
            hostId: 'host',
            hostKey: 'key',
            token: 'token',
            socketPath: path.join(root, 'host.sock'),
            recordPath: path.join(root, 'host.json'),
            sessions
          })
          const client = yield* TerminalHostClient.connect(
            host.record.socketPath,
            'token',
            'key',
            'host'
          )
          yield* client.createTerminal(input('old'))
          const killing = yield* Effect.fork(
            client.killTerminal('old', {
              traceId: '1234567890abcdef1234567890abcdef',
              spanId: '1234567890abcdef',
              sampled: true
            })
          )
          yield* Effect.promise(() => killStarted)
          yield* client.createTerminal(input('new'))
          expect(createTerminal).toHaveBeenCalledTimes(2)
          releaseKill()
          yield* Fiber.join(killing)
        })
      )
    )
  })
})
