import { describe, expect, it } from 'vitest'
import { sessionOwnershipViolations } from './check-terminal-runtime.mjs'

describe('session lifecycle ownership boundary', () => {
  it('rejects the PID-based recovery and cleanup paths that caused startup failures', () => {
    expect(
      sessionOwnershipViolations(
        'src/terminal-runtime/session-client.ts',
        `
      if (processExists(status.ownerPid)) { throw error }
    `
      )
    ).toEqual([expect.stringContaining('withSessionRecovery')])
    expect(
      sessionOwnershipViolations(
        'scripts/cleanup-development-runtime.mjs',
        `
      if (status !== null && processExists(status.pid)) { throw error }
    `
      )
    ).toEqual([expect.stringContaining('closeSession')])
    expect(
      sessionOwnershipViolations(
        'src/terminal-runtime/preflight.ts',
        `
      if (!processExists(status.ownerPid)) { continue }
    `
      )
    ).toEqual([expect.stringContaining('PersistentSession.inspect')])
  })

  it('rejects the timestamp workaround and direct deletion but permits the lifecycle API', () => {
    const file = 'src/terminal-runtime/session-client.ts'
    expect(
      sessionOwnershipViolations(file, `execFile('ps', ['-o', 'lstart='])`)
    ).not.toEqual([])
    expect(
      sessionOwnershipViolations(
        file,
        `await fs.rm(this.directory, { recursive: true })`
      )
    ).not.toEqual([])
    expect(
      sessionOwnershipViolations(file, `await closeSession(session)`)
    ).toEqual([])
    expect(
      sessionOwnershipViolations(
        file,
        `await withSessionRecovery(directory, replay)`
      )
    ).toEqual([])
  })
})
