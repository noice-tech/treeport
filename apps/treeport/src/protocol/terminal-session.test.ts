import { describe, expect, it } from 'vitest'
import { parseProductEvent } from './socket.ts'
import {
  parseTerminalAuth,
  parseTerminalClientEvent,
  parseTerminalServerEvent,
  terminalAttentionAcknowledgementSchema as terminalAttentionAcknowledgementEffectSchema,
  terminalSizeSchema as terminalSizeEffectSchema
} from './terminal-session.ts'
import { testSchema } from './schema.test-support.ts'

const terminalAttentionAcknowledgementSchema = testSchema(
  terminalAttentionAcknowledgementEffectSchema
)

const terminalSizeSchema = testSchema(terminalSizeEffectSchema)

describe('WebSocket contracts', () => {
  it('strictly validates terminal auth and controller generations', () => {
    expect(
      parseTerminalAuth({
        terminalId: 'term-1',
        clientId: 'tab-1',
        cols: 120,
        rows: 40
      })
    ).toMatchObject({ terminalId: 'term-1', clientId: 'tab-1' })
    expect(
      parseTerminalAuth({
        terminalId: 'term-1',
        clientId: 'tab-1',
        cols: 1,
        rows: 40
      })
    ).toBeNull()
    expect(
      parseTerminalAuth({
        terminalId: 'term-1',
        clientId: 'tab-1',
        cols: 120,
        rows: 40,
        extra: true
      })
    ).toBeNull()

    expect(
      parseTerminalClientEvent('input', { generation: 2, data: 'hello' })
    ).toEqual({ generation: 2, data: 'hello' })
    expect(
      parseTerminalClientEvent('binary', {
        generation: 2,
        data: '\0\xff'
      })
    ).toMatchObject({ data: '\0\xff' })
    expect(
      parseTerminalClientEvent('resize', {
        generation: -1,
        cols: 80,
        rows: 24
      })
    ).toBeNull()
    expect(
      parseTerminalClientEvent('take_control', {
        generation: 2,
        cols: 120,
        rows: 40
      })
    ).toEqual({ generation: 2, cols: 120, rows: 40 })
    expect(
      parseTerminalClientEvent('take_control', {
        generation: 2,
        cols: 120,
        rows: 40,
        extra: true
      })
    ).toBeNull()
    expect(
      parseTerminalClientEvent('take_control', { generation: 2 })
    ).toBeNull()
  })

  it('validates fresh stream ready, output, consumption, and control payloads', () => {
    expect(
      parseTerminalServerEvent('ready', {
        connectionId: 'connection',
        streamId: 'stream',
        generation: 3,
        controller: true,
        reset: 'full',
        cols: 120,
        rows: 40,
        revision: 1,
        snapshot: '\u001b[Hready',
        historyBytes: 0
      })
    ).toMatchObject({
      streamId: 'stream',
      generation: 3,
      reset: 'full',
      cols: 120,
      rows: 40,
      revision: 1,
      snapshot: '\u001b[Hready'
    })
    expect(
      parseTerminalServerEvent('ready', {
        connectionId: 'incomplete-connection',
        streamId: 'incomplete-stream',
        generation: 2,
        controller: false,
        reset: 'full'
      })
    ).toBeNull()
    expect(
      parseTerminalServerEvent('ready', {
        connectionId: 'hybrid',
        streamId: 'hybrid-stream',
        generation: 2,
        controller: false,
        reset: 'full',
        cols: 80
      })
    ).toBeNull()
    expect(
      parseTerminalServerEvent('ready', {
        connectionId: 'hybrid',
        streamId: 'hybrid-stream',
        generation: 2,
        controller: false,
        reset: 'full',
        cols: 80,
        rows: 24
      })
    ).toBeNull()
    expect(
      terminalSizeSchema.safeParse({ cols: 1_000, rows: 500 }).success
    ).toBe(true)
    expect(
      terminalSizeSchema.safeParse({ cols: 1_001, rows: 500 }).success
    ).toBe(false)
    expect(
      parseTerminalServerEvent('dimensions', {
        cols: 80,
        rows: 24,
        revision: 2
      })
    ).toEqual({ cols: 80, rows: 24, revision: 2 })
    expect(
      parseTerminalServerEvent('output', {
        streamId: 'stream',
        sequence: 0,
        data: 'bad'
      })
    ).toBeNull()
    expect(
      parseTerminalClientEvent('output_ack', {
        streamId: 'stream',
        sequence: 4
      })
    ).toEqual({ streamId: 'stream', sequence: 4 })
    expect(
      parseTerminalServerEvent('control', {
        generation: Number.NaN,
        controller: false
      })
    ).toBeNull()
  })

  it('validates snapshot-first product event payloads', () => {
    expect(
      parseProductEvent({
        id: 'event-created',
        type: 'terminal.created',
        at: '2026-01-01T00:00:00.000Z',
        data: {
          projectId: 'project',
          worktreeId: 'worktree',
          terminalId: 'term',
          terminal: {
            id: 'term',
            worktreeId: 'worktree',
            name: 'Shell',
            command: null,
            status: 'running',
            exitCode: null,
            parentTerminalId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        }
      })
    ).toMatchObject({
      type: 'terminal.created',
      data: { terminal: { id: 'term', status: 'running' } }
    })
    expect(
      parseProductEvent({
        id: 'event-1',
        type: 'terminal.updated',
        at: '2026-01-01T00:00:00.000Z',
        data: { terminalId: 'term', worktreeId: 'worktree' }
      })
    ).toMatchObject({ type: 'terminal.updated' })
    expect(
      parseProductEvent({
        id: 'event-app',
        type: 'app.open_requested',
        at: '2026-01-01T00:00:00.000Z',
        data: {
          worktreeId: 'worktree',
          appId: 'app-popup',
          app: {
            id: 'app-popup',
            kind: 'browser',
            worktreeId: 'worktree',
            title: 'Popup',
            url: 'https://example.com/popup',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          },
          sourceTerminalId: null,
          sourceAppId: 'app-browser'
        }
      })
    ).toMatchObject({
      type: 'app.open_requested',
      data: { sourceAppId: 'app-browser' }
    })
    expect(
      parseProductEvent({
        id: 'event-2',
        type: 'workspace.open_requested',
        at: '2026-01-01T00:00:00.000Z',
        data: {
          worktreeId: 'worktree',
          sourceTerminalId: 'term'
        }
      })
    ).toMatchObject({ type: 'workspace.open_requested' })
    expect(
      parseProductEvent({
        id: 'event-1',
        type: 'unknown',
        at: '2026-01-01T00:00:00.000Z',
        data: {}
      })
    ).toBeNull()
  })
})

describe('terminal runtime metadata', () => {
  it('validates daemon attention acknowledgements', () => {
    expect(
      terminalAttentionAcknowledgementSchema.safeParse({ sequence: 2 }).success
    ).toBe(true)
    expect(
      terminalAttentionAcknowledgementSchema.safeParse({ sequence: 0 }).success
    ).toBe(false)
  })
})
