import { describe, expect, it } from 'vitest'
import {
  parseTerminalClientMessage,
  parseTerminalProgress,
  parseTerminalRuntimeMetadata,
  parseTerminalServerMessage,
  TERMINAL_PROTOCOL_VERSION
} from './terminal-protocol.js'

describe('terminal protocol', () => {
  it('accepts versioned hello and binary frames', () => {
    expect(
      parseTerminalClientMessage({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'hello',
        clientId: 'tab-1',
        cols: 120,
        rows: 40
      })
    ).toMatchObject({ type: 'hello', clientId: 'tab-1' })
    expect(
      parseTerminalClientMessage({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'binary',
        data: '\0\xff'
      })
    ).toMatchObject({ type: 'binary' })
  })

  it('rejects wrong versions, extra keys, and invalid dimensions', () => {
    expect(
      parseTerminalClientMessage({ version: 2, type: 'take_control' })
    ).toBeNull()
    expect(
      parseTerminalClientMessage({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'resize',
        cols: 1,
        rows: 40
      })
    ).toBeNull()
    expect(
      parseTerminalClientMessage({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'take_control',
        extra: true
      })
    ).toBeNull()
  })

  it('accepts ready/output and rejects malformed server frames', () => {
    expect(
      parseTerminalServerMessage({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'ready',
        connectionId: 'connection',
        streamId: 'stream',
        controller: true,
        reset: 'full',
        heartbeatMs: 15_000
      })
    ).toMatchObject({ type: 'ready', reset: 'full' })
    expect(
      parseTerminalServerMessage({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'output',
        streamId: 'stream',
        sequence: 0,
        data: 'bad'
      })
    ).toBeNull()
  })

  it('validates runtime metadata snapshots', () => {
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: 'pi · /repo',
        progress: { state: 'normal', value: 42 }
      })
    ).toEqual({
      terminalId: 'term',
      title: 'pi · /repo',
      progress: { state: 'normal', value: 42 }
    })
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: null,
        progress: null
      })
    ).toEqual({ terminalId: 'term', title: null, progress: null })
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: null,
        progress: null,
        extra: true
      })
    ).toBeNull()
  })

  it('accepts validated progress frames and explicit clears', () => {
    expect(
      parseTerminalServerMessage({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'progress',
        progress: { state: 'indeterminate', value: null }
      })
    ).toMatchObject({ type: 'progress', progress: { state: 'indeterminate' } })
    expect(
      parseTerminalServerMessage({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'progress',
        progress: null
      })
    ).toMatchObject({ type: 'progress', progress: null })
    expect(
      parseTerminalServerMessage({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'progress',
        progress: { state: 'normal', value: 101 }
      })
    ).toBeNull()
  })

  it('parses OSC 9;4 payloads', () => {
    expect(parseTerminalProgress('4;3')).toEqual({
      state: 'indeterminate',
      value: null
    })
    expect(parseTerminalProgress('4;1;42')).toEqual({
      state: 'normal',
      value: 42
    })
    expect(parseTerminalProgress('4;0')).toBeNull()
    expect(parseTerminalProgress('4;1;101')).toBeUndefined()
    expect(parseTerminalProgress('4;1;1e2')).toBeUndefined()
    expect(parseTerminalProgress('1;notice')).toBeUndefined()
  })
})
