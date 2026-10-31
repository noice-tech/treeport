import { describe, expect, it } from 'vitest'
import { parseEventsSnapshot, parseProductEvent } from './socket.ts'
import {
  parseTerminalAuth,
  parseTerminalClientEvent,
  parseTerminalRuntimeMetadata,
  parseTerminalServerEvent,
  terminalAttentionAcknowledgementSchema as terminalAttentionAcknowledgementEffectSchema,
  terminalSizeSchema as terminalSizeEffectSchema
} from './terminal-session.ts'
import { testSchema } from './schema.test-support.ts'

const terminalAttentionAcknowledgementSchema = testSchema(
  terminalAttentionAcknowledgementEffectSchema
)

const terminalSizeSchema = testSchema(terminalSizeEffectSchema)

const IDLE = {
  state: 'idle',
  kind: null,
  progress: null,
  app: null,
  message: null,
  since: null
}

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
        snapshot: '\u001b[Hready'
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
      parseEventsSnapshot({
        presence: [],
        at: '2026-01-01T00:00:00.000Z',
        terminalMetadata: [
          { terminalId: 'term', title: null, activity: IDLE, attention: null }
        ],
        webApps: [
          {
            id: 'app',
            kind: 'web',
            worktreeId: 'worktree',
            definitionId: 'project:review',
            title: 'Application',
            launch: {
              input: { url: 'http://127.0.0.1:3000/' },
              cwd: '.'
            },
            permissions: ['tree-files'],
            sandbox: { enabled: true, allowSameOrigin: false },
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        browserApps: [
          {
            id: 'browser',
            kind: 'browser',
            worktreeId: 'worktree',
            title: 'Local preview',
            url: 'file:///tmp/preview.html',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    ).toMatchObject({
      terminalMetadata: [{ terminalId: 'term' }],
      webApps: [{ id: 'app' }],
      browserApps: [{ id: 'browser' }]
    })
    expect(
      parseEventsSnapshot({
        at: '2026-01-01T00:00:00.000Z',
        presence: [],
        terminalMetadata: [],
        webApps: [
          {
            id: 'app',
            kind: 'web',
            worktreeId: 'worktree',
            definitionId: 'project:review',
            renderer: 'unknown',
            title: 'Review',
            launch: { input: null, cwd: null },
            sandbox: { enabled: true, allowSameOrigin: false },
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        browserApps: []
      })
    ).toBeNull()
    expect(
      parseEventsSnapshot({
        presence: [],
        at: 'not-a-date',
        terminalMetadata: [],
        webApps: [],
        browserApps: []
      })
    ).toBeNull()
    expect(
      parseEventsSnapshot({
        at: '2026-01-01T00:00:00.000Z',
        presence: [],
        terminalMetadata: [],
        webApps: [],
        browserApps: [
          {
            id: 'browser',
            kind: 'browser',
            worktreeId: 'worktree',
            title: 'Unsafe',
            url: 'javascript:alert(1)',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    ).toBeNull()
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
  it('validates metadata snapshots and daemon attention sequences', () => {
    const working = { ...IDLE, state: 'working', progress: 42 }
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: 'pi · /repo',
        program: 'pi',
        hasForegroundProcess: true,
        activity: working,
        attention: null
      })
    ).toEqual({
      terminalId: 'term',
      title: 'pi · /repo',
      program: 'pi',
      hasForegroundProcess: true,
      activity: working,
      attention: null
    })
    expect(
      ['pi', 'claude', 'codex'].map(
        (program) =>
          parseTerminalRuntimeMetadata({
            terminalId: 'term',
            title: null,
            program,
            activity: IDLE,
            attention: null
          })?.program
      )
    ).toEqual(['pi', 'claude', 'codex'])
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: null,
        activity: { ...IDLE, since: '2026-01-01T00:01:00.000Z' },
        attention: {
          sequence: 2,
          at: '2026-01-01T00:02:00.000Z',
          unread: true,
          reason: 'bell'
        }
      })
    ).toMatchObject({ attention: { sequence: 2, unread: true } })
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: null,
        activity: IDLE,
        attention: null,
        extra: true
      })
    ).toBeNull()
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: null,
        activity: IDLE,
        attention: {
          sequence: 0,
          at: '2026-01-01T00:02:00.000Z',
          unread: true,
          reason: 'bell'
        }
      })
    ).toBeNull()
    expect(
      terminalAttentionAcknowledgementSchema.safeParse({ sequence: 2 }).success
    ).toBe(true)
    expect(
      terminalAttentionAcknowledgementSchema.safeParse({ sequence: 0 }).success
    ).toBe(false)
  })
})
