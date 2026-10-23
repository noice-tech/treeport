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
  it('decodes fragmented compact output mixed with JSON without changing fences', async () => {
    const output = {
      type: 'event' as const,
      event: 'output' as const,
      data: {
        terminalId: 'term-🌲',
        sequence: 123,
        output: '\u001b[32m🌲\r\n'.repeat(100)
      }
    }
    const runtime = {
      type: 'event' as const,
      event: 'runtime' as const,
      data: { terminalId: 'term-🌲', value: { commandExitCode: 0 } }
    }
    const compact = await Effect.runPromise(
      encodeTerminalHostFrame(output, true)
    )
    const json = await Effect.runPromise(encodeTerminalHostFrame(output))
    expect(compact.length).toBeLessThan(json.length)
    const wire = Buffer.concat([
      compact,
      await Effect.runPromise(encodeTerminalHostFrame(runtime)),
      json
    ])
    const decode = makeTerminalHostFrameDecoder()
    const frames = []
    for (let offset = 0; offset < wire.length; offset += 7) {
      frames.push(
        ...(await Effect.runPromise(decode(wire.subarray(offset, offset + 7))))
      )
    }
    expect(frames).toEqual([output, runtime, output])
    const invalid = Buffer.from(compact)
    invalid.writeUInt32BE(0xffffffff, 5)
    await expect(
      Effect.runPromise(makeTerminalHostFrameDecoder()(invalid))
    ).rejects.toThrow()
    const unsafeSequence = Buffer.from(compact)
    unsafeSequence.writeBigUInt64BE(2n ** 63n, 9)
    await expect(
      Effect.runPromise(makeTerminalHostFrameDecoder()(unsafeSequence))
    ).rejects.toThrow()
  })

  it('retains independent command completion in state and runtime event frames', async () => {
    const state = { status: 'running', exitCode: null, commandExitCode: 7 }
    expect(
      await Effect.runPromise(decodeTerminalHostResult('state', state))
    ).toEqual(state)
    const frame = {
      type: 'event' as const,
      event: 'runtime' as const,
      data: { terminalId: 'term', value: { commandExitCode: 0 } }
    }
    const encoded = await Effect.runPromise(encodeTerminalHostFrame(frame))
    expect(
      await Effect.runPromise(makeTerminalHostFrameDecoder()(encoded))
    ).toEqual([frame])
  })

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
          format: 'ghostty',
          fence: 0,
          cols: 80,
          rows: 24,
          futureSnapshotField: 'ignored'
        })
      )
    ).resolves.toEqual({
      data: 'history',
      format: 'ghostty',
      fence: 0,
      cols: 80,
      rows: 24
    })

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
