import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalRuntimeMetadata } from '@tasktty/shared'
import {
  DomainError,
  ProductEventBus,
  type AppConfig,
  type TmuxAdapter,
  type TaskTTYService
} from './core/index.js'
import { createApp } from './app.js'
import type { TerminalMetadataManager } from './terminal-metadata.js'

function fixture(webDist = '/missing') {
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 4780,
    databasePath: '/tmp/tasktty-test.db',
    dataDir: '/tmp',
    runtimeDir: path.join('/tmp', `tasktty-test-${crypto.randomUUID()}`),
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
    listTerminalPresets: vi.fn(() => [
      {
        id: 'preset_existing',
        name: 'Existing',
        executable: 'pi',
        args: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]),
    createTerminalPreset: vi.fn(
      (input: { name: string; executable: string; args: string[] }) => ({
        id: 'preset_new',
        ...input,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      })
    ),
    updateTerminalPreset: vi.fn(
      (
        id: string,
        input: { name: string; executable: string; args: string[] },
        _expectedUpdatedAt: string
      ) => ({
        id,
        ...input,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      })
    ),
    deleteTerminalPreset: vi.fn(),
    getProjectSnapshot: vi.fn(async (id: string) => ({ id })),
    resolveProject: vi.fn(async () => ({ id: 'p' })),
    refreshTerminalStatus: vi.fn(async (id: string) => ({
      id,
      worktreeId: 'wt_1',
      name: 'Pi',
      tmuxSessionName: 'tasktty-term-1',
      argv: ['pi'],
      status: 'running',
      exitCode: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })),
    database: {
      worktree: vi.fn(() => ({ id: 'wt_1', path: '/repo' }))
    },
    createTerminal: vi.fn(),
    getTerminal: vi.fn(async (id: string) => ({ id, worktreeId: 'wt_1' })),
    createWorktree: vi.fn(async () => ({
      worktree: {},
      terminal: null,
      terminalError: null,
      setupError: null
    })),
    removePreview: vi.fn(async () => ({ worktreeId: 'wt_1' })),
    beginRemove: vi.fn(async () => ({ id: 'op_1' }))
  } as unknown as TaskTTYService
  const runtimeMetadata: TerminalRuntimeMetadata = {
    terminalId: 'term',
    title: 'pi · /repo',
    progress: null,
    progressStartedAt: null,
    progressClearedAt: null,
    bell: null
  }
  const metadataSnapshot = vi.fn<() => TerminalRuntimeMetadata[]>(() => [])
  const metadataGet = vi.fn((terminalId: string) => ({
    ...runtimeMetadata,
    terminalId
  }))
  const metadataTrack = vi.fn(async () => undefined)
  const metadataAcknowledgeBell = vi.fn()
  const terminalMetadata = {
    initialize: vi.fn(async () => undefined),
    snapshot: metadataSnapshot,
    get: metadataGet,
    trackTerminal: metadataTrack,
    acknowledgeBell: metadataAcknowledgeBell
  } as unknown as TerminalMetadataManager
  const app = createApp({
    service,
    config,
    tmux: {} as TmuxAdapter,
    terminalMetadata,
    webDist
  })
  return {
    app,
    config,
    metadataAcknowledgeBell,
    metadataGet,
    metadataSnapshot,
    metadataTrack,
    service
  }
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

  it('forwards return-to-shell terminal launches without changing argv', async () => {
    const { app, service } = fixture()
    const response = await app.request('/api/worktrees/wt_1/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Diff',
        argv: ['diff', 'main', '--mode', 'split'],
        returnToShell: true,
        initialSize: { cols: 132, rows: 47 }
      })
    })
    expect(response.status).toBe(201)
    expect(service.createTerminal).toHaveBeenCalledWith(
      'wt_1',
      'Diff',
      ['diff', 'main', '--mode', 'split'],
      { returnToShell: true, initialSize: { cols: 132, rows: 47 } }
    )
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

  it('routes validated terminal preset CRUD with literal arguments', async () => {
    const { app, service } = fixture()
    const listed = await app.request('/api/terminal-presets')
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      presets: [{ id: 'preset_existing', executable: 'pi', args: [] }]
    })
    expect(service.refreshTerminalStatus).not.toHaveBeenCalled()

    const input = {
      name: '  Hunk  ',
      executable: 'npx',
      args: [
        '--yes',
        'hunkdiff@0.17.3',
        'a b',
        'semi;colon',
        '$HOME',
        'Unicode 世界'
      ]
    }
    const created = await app.request('/api/terminal-presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    })
    expect(created.status).toBe(201)
    expect(service.createTerminalPreset).toHaveBeenCalledWith({
      ...input,
      name: 'Hunk'
    })

    const updated = await app.request('/api/terminal-presets/preset_new', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input,
        name: 'Review',
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
      })
    })
    expect(updated.status).toBe(200)
    expect(service.updateTerminalPreset).toHaveBeenCalledWith(
      'preset_new',
      {
        ...input,
        name: 'Review'
      },
      '2026-01-01T00:00:00.000Z'
    )

    const deleted = await app.request('/api/terminal-presets/preset_new', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: '2026-01-02T00:00:00.000Z'
      })
    })
    expect(deleted.status).toBe(200)
    expect(service.deleteTerminalPreset).toHaveBeenCalledWith(
      'preset_new',
      '2026-01-02T00:00:00.000Z'
    )

    const invalid = await app.request('/api/terminal-presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad',
        executable: 'npx --yes package',
        args: '--watch'
      })
    })
    expect(invalid.status).toBe(400)
    expect(service.createTerminalPreset).toHaveBeenCalledTimes(1)
  })

  it('returns preset domain failures in the standard error envelope', async () => {
    const { app, service } = fixture()
    vi.mocked(service.deleteTerminalPreset).mockImplementationOnce(() => {
      throw new DomainError(
        'TERMINAL_PRESET_NOT_FOUND',
        'Terminal preset not found',
        404
      )
    })
    const response = await app.request('/api/terminal-presets/preset_missing', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
      })
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        code: 'TERMINAL_PRESET_NOT_FOUND',
        message: 'Terminal preset not found'
      }
    })
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
          argv: ['tool', 'semi;colon', '$HOME'],
          returnToShell: true,
          initialSize: { cols: 144, rows: 48 }
        }
      })
    })
    expect(created.status).toBe(201)
    expect(service.createWorktree).toHaveBeenCalledWith(
      'p',
      'topic',
      'current',
      {
        name: 'Terminal',
        argv: ['tool', 'semi;colon', '$HOME'],
        returnToShell: true,
        initialSize: { cols: 144, rows: 48 }
      },
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

  it('uploads browser files to a private terminal-readable path', async () => {
    const { app, config, service } = fixture()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const uploadDirectory = path.join(config.runtimeDir, 'uploads')
    const stalePath = path.join(uploadDirectory, 'tasktty-upload-stale.png')
    try {
      await fs.mkdir(uploadDirectory, { recursive: true })
      await fs.writeFile(stalePath, 'stale')
      const staleTime = new Date(Date.now() - 25 * 60 * 60_000)
      await fs.utimes(stalePath, staleTime, staleTime)

      const response = await app.request('/api/terminals/term_1/files', {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-tasktty-file-extension': 'png'
        },
        body: bytes
      })

      expect(response.status).toBe(201)
      expect(service.getTerminal).toHaveBeenCalledWith('term_1')
      const result = (await response.json()) as { file: { path: string } }
      expect(path.dirname(result.file.path)).toBe(
        path.join(config.runtimeDir, 'uploads')
      )
      expect(path.extname(result.file.path)).toBe('.png')
      expect(await fs.readFile(result.file.path)).toEqual(Buffer.from(bytes))
      expect((await fs.stat(result.file.path)).mode & 0o777).toBe(0o600)
      await expect(fs.stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' })

      const invalid = await app.request('/api/terminals/term_1/files', {
        method: 'POST',
        headers: { 'x-tasktty-file-extension': '../png' },
        body: new Uint8Array()
      })
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR' }
      })
    } finally {
      await fs.rm(config.runtimeDir, { recursive: true, force: true })
    }
  })

  it('acknowledges an observed terminal bell through an exact sequence', async () => {
    const { app, metadataAcknowledgeBell, metadataTrack } = fixture()
    const response = await app.request('/api/terminals/term/bell/acknowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sequence: 4 })
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(metadataTrack).not.toHaveBeenCalled()
    expect(metadataAcknowledgeBell).toHaveBeenCalledWith('term', 4)

    const invalid = await app.request('/api/terminals/term/bell/acknowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sequence: 0 })
    })
    expect(invalid.status).toBe(400)
  })

  it('inspects a refreshed terminal with daemon runtime metadata', async () => {
    const { app, metadataGet, metadataTrack, service } = fixture()
    const response = await app.request('/api/terminals/term')

    expect(response.status).toBe(200)
    expect(service.refreshTerminalStatus).toHaveBeenCalledWith('term')
    expect(metadataTrack).toHaveBeenCalledOnce()
    expect(metadataGet).toHaveBeenCalledWith('term')
    expect(await response.json()).toMatchObject({
      terminal: { id: 'term', status: 'running' },
      metadata: {
        terminalId: 'term',
        title: 'pi · /repo',
        progress: null,
        bell: null
      }
    })
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

  it('does not retain the legacy SSE or raw terminal attachment routes', async () => {
    const { app } = fixture()
    expect((await app.request('/api/events')).status).toBe(404)
    expect((await app.request('/api/terminals/term/attach')).status).toBe(404)
  })

  it('serves the web entry point for deep links without masking API 404s', async () => {
    const webDist = path.join('/tmp', `tasktty-web-dist-${crypto.randomUUID()}`)
    await fs.mkdir(webDist, { recursive: true })
    await fs.writeFile(
      path.join(webDist, 'index.html'),
      '<!doctype html><title>TaskTTY route fallback</title>'
    )

    try {
      const { app } = fixture(webDist)
      const deepLink = await app.request(
        '/projects/project/worktrees/worktree/terminals/terminal'
      )
      expect(deepLink.status).toBe(200)
      expect(await deepLink.text()).toContain('TaskTTY route fallback')

      const missingApi = await app.request('/api/missing')
      expect(missingApi.status).toBe(404)
      expect(missingApi.headers.get('content-type')).toContain(
        'application/json'
      )
    } finally {
      await fs.rm(webDist, { recursive: true, force: true })
    }
  })
})
