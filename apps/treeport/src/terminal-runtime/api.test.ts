import { describe, expect, it } from 'vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import {
  decodeTerminalHostInput,
  decodeTerminalHostRecord,
  decodeTerminalHostResult,
  encodeTerminalHostFrame,
  makeTerminalHostFrameDecoder
} from './api'

describe('stable terminal host API', () => {
  it('discards additive unknown fields while validating known fields', async () => {
    await expect(
      Effect.runPromise(
        decodeTerminalHostRecord({
          hostId: 'host',
          hostKey: 'key',
          pid: 123,
          socketPath: '/tmp/host.sock',
          startedAt: '2026-01-01T00:00:00.000Z',
          futureRecordField: { enabled: true }
        })
      )
    ).resolves.toEqual({
      hostId: 'host',
      hostKey: 'key',
      pid: 123,
      socketPath: '/tmp/host.sock',
      startedAt: '2026-01-01T00:00:00.000Z'
    })

    await expect(
      Effect.runPromise(
        decodeTerminalHostInput('resize', {
          terminalId: 'terminal',
          cols: 80,
          rows: 24,
          futureInputField: true
        })
      )
    ).resolves.toEqual({ terminalId: 'terminal', cols: 80, rows: 24 })

    await expect(
      Effect.runPromise(
        decodeTerminalHostResult('attach', {
          data: 'history',
          fence: 0,
          cols: 80,
          rows: 24,
          futureSnapshotField: 'ignored'
        })
      )
    ).resolves.toEqual({ data: 'history', fence: 0, cols: 80, rows: 24 })

    const invalid = await Effect.runPromise(
      Effect.exit(
        decodeTerminalHostInput('resize', {
          terminalId: 'terminal',
          cols: '80',
          rows: 24
        })
      )
    )
    expect(Exit.isFailure(invalid)).toBe(true)
  })

  it('accepts additive frame fields and unknown methods without relaxing known fields', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        type: 'request',
        id: 'future-request',
        method: 'futureMethod',
        input: { futureInput: true },
        futureFrameField: true
      })
    )
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.byteLength)
    const frames = await Effect.runPromise(
      makeTerminalHostFrameDecoder()(Buffer.concat([header, payload]))
    )
    expect(frames).toEqual([
      {
        type: 'request',
        id: 'future-request',
        method: 'futureMethod',
        input: { futureInput: true }
      }
    ])

    // SAFETY: The invalid known value deliberately exercises runtime validation.
    const invalid = await Effect.runPromise(
      Effect.exit(
        encodeTerminalHostFrame({
          type: 'event',
          event: 'output',
          data: {
            terminalId: 'terminal',
            output: 'hello',
            sequence: '1' as never
          }
        })
      )
    )
    expect(Exit.isFailure(invalid)).toBe(true)
  })
})
