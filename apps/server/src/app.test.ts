import { describe, expect, it, vi } from 'vitest'
import type { TerminalRuntimeMetadata } from '@tasktty/shared'
import {
  DomainError,
  ProductEventBus,
  type AppConfig,
  type TmuxAdapter,
  type TaskTTYService
} from '@tasktty/core'
import { createApp } from './app.js'
import type { TerminalMetadataManager } from './terminal-metadata.js'

function fixture() {
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 4780,
    databasePath: '/tmp/tasktty-test.db',
    dataDir: '/tmp',
    runtimeDir: '/tmp',
    shell: '/bin/zsh',
    tmuxPath: 'tmux',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1:4780'
  }
  const service = {
    events: new ProductEventBus(),
    listProjects: vi.fn(async () => []),
    listRecentProjects: vi.fn(() => [
      {
        id: 'recent',
        name: 'Recent',
        repositoryPath: '/recent',
        lastOpenedAt: '2026-01-01T00:00:00.000Z'
      }
    ]),
    openProject: vi.fn(async (id: string) => ({ id })),
    closeProject: vi.fn(async () => undefined),
    deleteProject: vi.fn(async () => undefined),
    updateProjectColor: vi.fn((id: string, color: string | null) => ({
      id,
      color
    })),
    getProjectSnapshot: vi.fn(async (id: string) => ({ id })),
    resolveProject: vi.fn(async () => ({ id: 'p' })),
    createTerminal: vi.fn(),
    createWorktree: vi.fn(async () => ({
      worktree: {},
      terminal: null,
      terminalError: null,
      setupError: null
    })),
    removePreview: vi.fn(async () => ({ worktreeId: 'wt_1' })),
    beginRemove: vi.fn(async () => ({ id: 'op_1' }))
  } as unknown as TaskTTYService
  const metadataSnapshot = vi.fn<() => TerminalRuntimeMetadata[]>(() => [])
  const terminalMetadata = {
    initialize: vi.fn(async () => undefined),
    snapshot: metadataSnapshot
  } as unknown as TerminalMetadataManager
  const app = createApp({
    service,
    config,
    tmux: {} as TmuxAdapter,
    terminalMetadata,
    webDist: '/missing'
  })
  return { app, metadataSnapshot, service }
}

describe('HTTP API validation', () => {
  it('returns consistent validation errors without calling domain services', async () => {
    const { app, service } = fixture()
    const response = await app.request('/api/worktrees/wt_1/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad', argv: 'pnpm dev' })
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' }
    })
    expect(service.createTerminal).not.toHaveBeenCalled()
  })

  it('keeps recent, open, close, and destructive delete as distinct routes', async () => {
    const { app, service } = fixture()

    const recent = await app.request('/api/projects/recent')
    expect(recent.status).toBe(200)
    expect(await recent.json()).toMatchObject({
      projects: [{ id: 'recent', repositoryPath: '/recent' }]
    })
    expect(service.getProjectSnapshot).not.toHaveBeenCalledWith('recent')

    const opened = await app.request('/api/projects/p/open', {
      method: 'POST'
    })
    expect(opened.status).toBe(200)
    expect(service.openProject).toHaveBeenCalledWith('p')

    const closed = await app.request('/api/projects/p/close', {
      method: 'POST'
    })
    expect(closed.status).toBe(200)
    expect(service.closeProject).toHaveBeenCalledWith('p')

    const removed = await app.request('/api/projects/p', {
      method: 'DELETE'
    })
    expect(removed.status).toBe(200)
    expect(service.deleteProject).toHaveBeenCalledWith('p')
    expect(service.closeProject).toHaveBeenCalledTimes(1)
  })

  it('preserves close failure details in the standard error envelope', async () => {
    const { app, service } = fixture()
    vi.mocked(service.closeProject).mockRejectedValueOnce(
      new DomainError(
        'PROJECT_CLOSE_FAILED',
        'Some terminals may have stopped',
        500,
        { failedWorktreeIds: ['wt_1'], terminalsMayHaveStopped: true }
      )
    )

    const response = await app.request('/api/projects/p/close', {
      method: 'POST'
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        code: 'PROJECT_CLOSE_FAILED',
        message: 'Some terminals may have stopped',
        details: {
          failedWorktreeIds: ['wt_1'],
          terminalsMayHaveStopped: true
        }
      }
    })
  })

  it('updates projects with curated colors only', async () => {
    const { app, service } = fixture()
    const updated = await app.request('/api/projects/p', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ color: 'violet' })
    })
    expect(updated.status).toBe(200)
    expect(service.updateProjectColor).toHaveBeenCalledWith('p', 'violet')

    const invalid = await app.request('/api/projects/p', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ color: 'indigo' })
    })
    expect(invalid.status).toBe(400)
    expect(service.updateProjectColor).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed JSON with a machine-readable code', async () => {
    const { app } = fixture()
    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_JSON' }
    })
  })

  it('accepts detached worktree creation and one remove endpoint', async () => {
    const { app, service } = fixture()
    const created = await app.request('/api/projects/p/worktrees', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'topic',
        base: 'current',
        sourceWorktreeId: 'wt_main',
        initialTerminal: {
          name: 'Terminal',
          argv: ['tool', 'semi;colon', '$HOME']
        }
      })
    })
    expect(created.status).toBe(201)
    expect(service.createWorktree).toHaveBeenCalledWith(
      'p',
      'topic',
      'current',
      { name: 'Terminal', argv: ['tool', 'semi;colon', '$HOME'] },
      'wt_main'
    )

    expect(
      (await app.request('/api/worktrees/wt_1/remove-preview')).status
    ).toBe(200)
    const removed = await app.request('/api/worktrees/wt_1/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmationToken: 'a'.repeat(64),
        confirmDestructive: true
      })
    })
    expect(removed.status).toBe(202)
    expect(service.beginRemove).toHaveBeenCalledWith('wt_1', {
      confirmationToken: 'a'.repeat(64),
      confirmDestructive: true
    })
  })

  it('forwards spawn argv as a structured initial terminal', async () => {
    const { app, service } = fixture()
    const response = await app.request('/api/spawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project: '/repo',
        worktreeName: 'topic',
        name: 'Agent',
        base: 'default',
        argv: ['tool', 'semi;colon', '$HOME']
      })
    })
    expect(response.status).toBe(201)
    expect(service.resolveProject).toHaveBeenCalledWith('/repo')
    expect(service.createWorktree).toHaveBeenCalledWith(
      'p',
      'topic',
      'default',
      { name: 'Agent', argv: ['tool', 'semi;colon', '$HOME'] },
      undefined
    )
  })

  it('does not expose removed diagnostics and finish/discard routes', async () => {
    const { app } = fixture()
    expect((await app.request('/api/diagnostics')).status).toBe(404)
    expect((await app.request('/api/worktrees/w/finish-preview')).status).toBe(
      404
    )
    expect((await app.request('/api/worktrees/w/discard-preview')).status).toBe(
      404
    )
  })

  it('starts SSE with the complete terminal metadata snapshot', async () => {
    const { app, metadataSnapshot } = fixture()
    metadataSnapshot.mockReturnValue([
      {
        terminalId: 'term',
        title: 'pi · /repo',
        progress: { state: 'normal', value: 42 }
      }
    ])
    const abort = new AbortController()
    const response = await app.request('/api/events', { signal: abort.signal })
    const reader = response.body!.getReader()
    const first = await reader.read()
    const payload = new TextDecoder().decode(first.value)

    expect(payload).toContain('event: connected')
    expect(payload).toContain('"terminalId":"term"')
    expect(payload).toContain('"title":"pi · /repo"')
    expect(payload).toContain('"value":42')

    abort.abort()
    await reader.cancel()
  })
})
