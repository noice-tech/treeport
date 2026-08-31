import { describe, expect, it } from 'vitest'
import {
  parseEventsSnapshot,
  parseProductEvent,
  parseTerminalAuth,
  parseTerminalClientEvent,
  parseTerminalProgress,
  parseTerminalRuntimeMetadata,
  parseTerminalServerEvent,
  terminalBellAcknowledgementSchema,
  terminalSizeSchema
} from './index.js'

describe('Socket.IO contracts', () => {
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
    expect(parseTerminalClientEvent('take_control', { generation: 2 })).toEqual(
      { generation: 2 }
    )
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
        backend: 'direct-pty',
        snapshot: '\u001b[Hready'
      })
    ).toMatchObject({
      streamId: 'stream',
      generation: 3,
      reset: 'full',
      cols: 120,
      rows: 40,
      revision: 1,
      backend: 'direct-pty',
      snapshot: '\u001b[Hready'
    })
    expect(
      parseTerminalServerEvent('ready', {
        connectionId: 'legacy-connection',
        streamId: 'legacy-stream',
        generation: 2,
        controller: false,
        reset: 'full'
      })
    ).toMatchObject({ streamId: 'legacy-stream', reset: 'full' })
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
    expect(parseTerminalServerEvent('history', { viewing: true })).toEqual({
      viewing: true
    })
    expect(parseTerminalServerEvent('history', { viewing: 'yes' })).toBeNull()
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
        at: '2026-01-01T00:00:00.000Z',
        terminalMetadata: [{ terminalId: 'term', title: null, progress: null }],
        webPanels: [
          {
            id: 'panel',
            kind: 'web',
            worktreeId: 'worktree',
            definitionId: 'project:review',
            title: 'Application',
            launch: {
              input: { url: 'http://127.0.0.1:3000/' },
              cwd: '.'
            },
            permissions: ['tree-files'],
            sandbox: { allowSameOrigin: false },
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        browserPanels: [
          {
            id: 'browser',
            kind: 'browser',
            worktreeId: 'worktree',
            title: 'Example',
            url: 'https://example.com/',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    ).toMatchObject({
      terminalMetadata: [{ terminalId: 'term' }],
      webPanels: [{ id: 'panel' }],
      browserPanels: [{ id: 'browser' }]
    })
    expect(
      parseEventsSnapshot({
        at: '2026-01-01T00:00:00.000Z',
        terminalMetadata: [],
        webPanels: [
          {
            id: 'panel',
            kind: 'web',
            worktreeId: 'worktree',
            definitionId: 'project:review',
            renderer: 'unknown',
            title: 'Review',
            launch: { input: null, cwd: null },
            sandbox: { allowSameOrigin: false },
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        browserPanels: []
      })
    ).toBeNull()
    expect(
      parseEventsSnapshot({
        at: 'not-a-date',
        terminalMetadata: [],
        webPanels: [],
        browserPanels: []
      })
    ).toBeNull()
    expect(
      parseEventsSnapshot({
        at: '2026-01-01T00:00:00.000Z',
        terminalMetadata: [],
        webPanels: [],
        browserPanels: [
          {
            id: 'browser',
            kind: 'browser',
            worktreeId: 'worktree',
            title: 'Unsafe',
            url: 'file:///etc/passwd',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    ).toBeNull()
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
        id: 'event-panel',
        type: 'panel.open_requested',
        at: '2026-01-01T00:00:00.000Z',
        data: {
          worktreeId: 'worktree',
          panelId: 'panel-popup',
          panel: {
            id: 'panel-popup',
            kind: 'browser',
            worktreeId: 'worktree',
            title: 'Popup',
            url: 'https://example.com/popup',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          },
          sourceTerminalId: null,
          sourcePanelId: 'panel-browser'
        }
      })
    ).toMatchObject({
      type: 'panel.open_requested',
      data: { sourcePanelId: 'panel-browser' }
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
  it('validates metadata snapshots and daemon BEL sequences', () => {
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: 'pi · /repo',
        program: 'pi',
        hasForegroundProcess: true,
        progress: { state: 'normal', value: 42 }
      })
    ).toEqual({
      terminalId: 'term',
      title: 'pi · /repo',
      program: 'pi',
      hasForegroundProcess: true,
      progress: { state: 'normal', value: 42 },
      progressStartedAt: null,
      progressClearedAt: null,
      bell: null
    })
    expect(
      ['pi', 'claude', 'codex'].map(
        (program) =>
          parseTerminalRuntimeMetadata({
            terminalId: 'term',
            title: null,
            program,
            progress: null
          })?.program
      )
    ).toEqual(['pi', 'claude', 'codex'])
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: null,
        progress: null,
        progressStartedAt: '2026-01-01T00:00:00.000Z',
        progressClearedAt: '2026-01-01T00:01:00.000Z',
        bell: {
          sequence: 2,
          at: '2026-01-01T00:02:00.000Z',
          unread: true
        }
      })
    ).toMatchObject({ bell: { sequence: 2, unread: true } })
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: null,
        progress: null,
        extra: true
      })
    ).toBeNull()
    expect(
      parseTerminalRuntimeMetadata({
        terminalId: 'term',
        title: null,
        progress: null,
        bell: {
          sequence: 0,
          at: '2026-01-01T00:02:00.000Z',
          unread: true
        }
      })
    ).toBeNull()
    expect(
      terminalBellAcknowledgementSchema.safeParse({ sequence: 2 }).success
    ).toBe(true)
    expect(
      terminalBellAcknowledgementSchema.safeParse({ sequence: 0 }).success
    ).toBe(false)
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
