/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- The test uses a deliberately partial terminal session double. */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Effect from 'effect/Effect'
import { probeTerminalHostCompatibility } from './preflight'
import { makeTerminalHostServer } from './server'
import type { TerminalHostSessions } from './sessions'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

async function paths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-host-probe-'))
  roots.push(root)
  const dataDir = path.join(root, 'data')
  const runtimeDir = path.join(root, 'runtime')
  await Promise.all([
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(runtimeDir, { recursive: true })
  ])
  const hostKey = crypto
    .createHash('sha256')
    .update(path.resolve(dataDir))
    .digest('hex')
    .slice(0, 20)
  return {
    root,
    dataDir,
    runtimeDir,
    hostKey,
    recordPath: path.join(runtimeDir, `terminal-host-${hostKey}.json`),
    socketPath: path.join(
      os.tmpdir(),
      `treeport-${process.getuid?.() ?? 'user'}`,
      `terminal-${hostKey}.sock`
    )
  }
}

describe('staged terminal host compatibility probe', () => {
  it('proves the baseline API with an authenticated side-effect-free connection', async () => {
    const value = await paths()
    const restoreHostQueryAuthority = vi.fn(() => Effect.void)
    const createTerminal = vi.fn(() => Effect.void)
    await fs.writeFile(
      path.join(value.dataDir, 'terminal-host.token'),
      'token\n'
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeTerminalHostServer({
            hostId: 'host',
            hostKey: value.hostKey,
            token: 'token',
            socketPath: value.socketPath,
            recordPath: value.recordPath,
            sessions: {
              sessionCount: Effect.succeed(2),
              initialize: () => Effect.succeed(true),
              createTerminal,
              restoreHostQueryAuthority,
              shutdown: () => Effect.void
            } as unknown as TerminalHostSessions
          })
          const source = yield* Effect.promise(() =>
            fs.readFile(value.recordPath, 'utf8')
          )
          const result = yield* Effect.promise(() =>
            probeTerminalHostCompatibility(value.dataDir, value.runtimeDir)
          )
          expect(result).toMatchObject({
            compatible: true,
            running: true,
            record: { hostId: host.record.hostId, hostKey: value.hostKey }
          })
          expect(
            yield* Effect.promise(() => fs.readFile(value.recordPath, 'utf8'))
          ).toBe(source)
        })
      )
    )

    expect(createTerminal).not.toHaveBeenCalled()
    expect(restoreHostQueryAuthority).not.toHaveBeenCalled()
  })

  it('refuses a live historical host with actionable manual-cutover guidance', async () => {
    const value = await paths()
    const source = `${JSON.stringify({
      protocolVersion: 4,
      hostId: 'legacy-host',
      hostKey: value.hostKey,
      pid: process.pid,
      socketPath: value.socketPath,
      startedAt: '2026-01-01T00:00:00.000Z'
    })}\n`
    await fs.writeFile(value.recordPath, source)

    const result = await probeTerminalHostCompatibility(
      value.dataDir,
      value.runtimeDir
    )
    expect(result).toMatchObject({
      compatible: false,
      running: true,
      record: { hostId: 'legacy-host' },
      reason: expect.stringContaining('retired protocol 4'),
      next: expect.stringContaining('explicitly close terminals')
    })
    expect(await fs.readFile(value.recordPath, 'utf8')).toBe(source)
  })

  it('does not treat a missing record as permission to unlink a socket', async () => {
    const value = await paths()
    await fs.mkdir(path.dirname(value.socketPath), { recursive: true })
    await fs.writeFile(value.socketPath, 'unidentified')

    await expect(
      probeTerminalHostCompatibility(value.dataDir, value.runtimeDir)
    ).resolves.toMatchObject({
      compatible: false,
      reason: expect.stringContaining('without a valid discovery record'),
      next: expect.stringContaining('will not unlink')
    })
    await expect(fs.readFile(value.socketPath, 'utf8')).resolves.toBe(
      'unidentified'
    )
    await fs.rm(value.socketPath, { force: true })
  })
})
