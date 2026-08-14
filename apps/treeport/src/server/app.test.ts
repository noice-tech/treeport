import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_PROTOCOL_VERSION,
  type TerminalRuntimeMetadata
} from '@treeport/shared'
import {
  DomainError,
  ProductEventBus,
  type AppConfig,
  type TmuxAdapter,
  type TreeportService
} from './core/index'
import { createApp } from './app'
import type { TerminalMetadataManager } from './terminal-metadata'

function fixture(webDist = '/missing') {
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 8733,
    databasePath: '/tmp/treeport-test.db',
    dataDir: '/tmp',
    cacheDir: path.join('/tmp', `treeport-cache-${crypto.randomUUID()}`),
    runtimeDir: path.join('/tmp', `treeport-test-${crypto.randomUUID()}`),
    shell: '/bin/zsh',
    tmuxPath: 'tmux',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1:8733',
    daemonLifecycle: 'treeport',
    webDevelopment: false
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
    browseDirectory: vi.fn(async (input: string, _hidden: boolean) => ({
      input,
      exact: true,
      directory: {
        path: input,
        parentPath: '/',
        homePath: '/home/test',
        rootPath: '/',
        breadcrumbs: [{ name: '/', path: '/' }],
        entries: [],
        truncated: false
      },
      repository: { state: 'not-repository' as const, message: 'Not a repo' }
    })),
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
        closeOnSuccess: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]),
    listTerminalPresetDefinitions: vi.fn(() => ({
      definitions: [
        {
          id: 'package:npm:@acme/tools:terminal-preset:dev',
          name: 'Package dev',
          executable: 'pnpm',
          args: ['dev'],
          cwd: null,
          env: {},
          closeOnSuccess: false,
          source: {
            type: 'package',
            packageId: 'npm:@acme/tools',
            source: 'npm:@acme/tools',
            scope: 'global'
          }
        }
      ],
      diagnostics: []
    })),
    listPackages: vi.fn(() => ({ packages: [], diagnostics: [] })),
    resolveRegisteredProject: vi.fn((inputPath: string) => ({
      id: 'project_1',
      repositoryPath: inputPath
    })),
    installPackage: vi.fn((source: string, projectId?: string) => ({
      action: 'install',
      source,
      scope: projectId ? 'project' : 'global',
      projectId: projectId ?? null,
      status: 'installed'
    })),
    removePackage: vi.fn((source: string, projectId?: string) => ({
      action: 'remove',
      source,
      scope: projectId ? 'project' : 'global',
      projectId: projectId ?? null,
      status: 'removed'
    })),
    updatePackages: vi.fn(() => []),
    reloadPackages: vi.fn(() => ({ results: [], diagnostics: [] })),
    createTerminalPreset: vi.fn(
      (input: {
        name: string
        executable: string
        args: string[]
        closeOnSuccess: boolean
      }) => ({
        id: 'preset_new',
        ...input,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      })
    ),
    updateTerminalPreset: vi.fn(
      (
        id: string,
        input: {
          name: string
          executable: string
          args: string[]
          closeOnSuccess: boolean
        },
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
      tmuxSessionName: 'treeport-term-1',
      argv: ['pi'],
      status: 'running',
      exitCode: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })),
    database: {
      worktree: vi.fn(() => ({ id: 'wt_1', path: '/repo' }))
    },
    getWorktree: vi.fn(() => ({
      id: 'wt_1',
      tmuxSocketName: 'treeport-wt-1'
    })),
    listWebPanelDefinitions: vi.fn(async () => [
      {
        id: 'project:review',
        title: 'Review',
        source: { type: 'project' }
      }
    ]),
    createWebPanel: vi.fn(async (worktreeId: string) => ({
      id: 'panel_review',
      kind: 'web',
      worktreeId,
      definitionId: 'project:review',
      title: 'Review',
      launch: { input: null, cwd: null },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })),
    openWebPanel: vi.fn(async (worktreeId: string) => ({
      panel: {
        id: 'panel_review',
        kind: 'web',
        worktreeId,
        definitionId: 'project:review',
        title: 'Review',
        launch: {
          input: { path: 'output/demo.mp4' },
          cwd: 'packages/preview'
        },
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02'
      },
      created: false,
      reused: true
    })),
    deleteWebPanel: vi.fn(async () => undefined),
    getWebPanelContext: vi.fn(async () => ({
      apiVersion: 1,
      panel: { id: 'panel_review' },
      launch: { input: null, cwd: null }
    })),
    getWebPanelDiff: vi.fn(async () => ({
      baseRef: 'origin/trunk',
      unified: 'diff --git a/a b/a'
    })),
    getWebPanelListeners: vi.fn(async () => ({
      supported: true,
      message: null,
      listeners: [
        {
          pid: 42,
          command: 'vite',
          host: '127.0.0.1',
          port: 5173,
          terminalId: 'term_1'
        }
      ]
    })),
    hasWebPanelStorage: vi.fn(async () => true),
    getWebPanelStorage: vi.fn(async () => [{ file: 'src/app.ts', line: 12 }]),
    setWebPanelStorage: vi.fn(async () => undefined),
    deleteWebPanelStorage: vi.fn(async () => undefined),
    resolveWebPanelAsset: vi.fn(async () => '/missing'),
    createTerminal: vi.fn(),
    getTerminal: vi.fn(async (id: string) => ({
      id,
      worktreeId: 'wt_1',
      tmuxSessionName: 'treeport-term-1'
    })),
    beginCreateWorktree: vi.fn(async () => ({
      id: 'op_create',
      kind: 'create',
      status: 'pending'
    })),
    listActiveOperations: vi.fn(async () => [
      { id: 'op_create', kind: 'create', status: 'running' }
    ]),
    getOperation: vi.fn(async (id: string) => ({ id, status: 'running' })),
    removePreview: vi.fn(async () => ({ worktreeId: 'wt_1' })),
    beginRemove: vi.fn(async () => ({ id: 'op_1' }))
  } as unknown as TreeportService
  const runtimeMetadata: TerminalRuntimeMetadata = {
    terminalId: 'term',
    title: 'pi · /repo',
    program: 'pi',
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
  const metadataAcknowledgeBell = vi.fn(async () => undefined)
  const terminalMetadata = {
    initialize: vi.fn(async () => undefined),
    snapshot: metadataSnapshot,
    get: metadataGet,
    trackTerminal: metadataTrack,
    acknowledgeBell: metadataAcknowledgeBell
  } as unknown as TerminalMetadataManager
  const capturePane = vi.fn(
    async (): Promise<string | null> => 'Preparing changes\nRunning tests'
  )
  const app = createApp({
    service,
    config,
    tmux: { capturePane } as unknown as TmuxAdapter,
    terminalMetadata,
    webDist
  })
  return {
    app,
    capturePane,
    config,
    metadataAcknowledgeBell,
    metadataGet,
    metadataSnapshot,
    metadataTrack,
    service
  }
}

describe('HTTP API validation', () => {
  it('advertises the desktop compatibility and computer identity contract', async () => {
    const { app } = fixture()
    const response = await app.request('/api/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      hostname: os.hostname(),
      daemonLifecycle: 'treeport'
    })
  })

  it('routes persistent web-panel lifecycle and scoped runtime reads', async () => {
    const { app, service } = fixture()
    const definitions = await app.request(
      '/api/worktrees/wt_1/web-panel-definitions'
    )
    expect(await definitions.json()).toMatchObject({
      definitions: [{ id: 'project:review', source: { type: 'project' } }]
    })

    const created = await app.request('/api/worktrees/wt_1/panels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definitionId: 'project:review',
        input: { path: 'output/demo.mp4' },
        launchCwd: 'packages/preview'
      })
    })
    expect(created.status).toBe(201)
    expect(service.createWebPanel).toHaveBeenCalledWith(
      'wt_1',
      'project:review',
      {
        input: { path: 'output/demo.mp4' },
        cwd: 'packages/preview'
      }
    )

    const opened = await app.request('/api/worktrees/wt_1/panels/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definitionId: 'project:review',
        input: { path: 'output/demo.mp4' },
        launchCwd: 'packages/preview',
        newInstance: false,
        sourceTerminalId: 'term_1'
      })
    })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toMatchObject({ reused: true, created: false })
    expect(service.openWebPanel).toHaveBeenCalledWith(
      'wt_1',
      'project:review',
      {
        input: { path: 'output/demo.mp4' },
        cwd: 'packages/preview'
      },
      false,
      'term_1'
    )

    expect((await app.request('/api/panels/panel_review/context')).status).toBe(
      200
    )
    expect((await app.request('/api/panels/panel_review/diff')).status).toBe(
      200
    )
    expect(service.getWebPanelDiff).toHaveBeenCalledWith('panel_review')

    expect(
      await (
        await app.request('/api/panels/panel_review/network/listeners')
      ).json()
    ).toEqual({
      discovery: {
        supported: true,
        message: null,
        listeners: [
          {
            pid: 42,
            command: 'vite',
            host: '127.0.0.1',
            port: 5173,
            terminalId: 'term_1'
          }
        ]
      }
    })
    expect(service.getWebPanelListeners).toHaveBeenCalledWith('panel_review')

    expect(
      await (await app.request('/api/panels/panel_review/storage')).json()
    ).toEqual({ hasData: true })
    expect(service.hasWebPanelStorage).toHaveBeenCalledWith('panel_review')

    const stored = await app.request('/api/panels/panel_review/storage', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'comments', value: [{ line: 12 }] })
    })
    expect(stored.status).toBe(200)
    expect(service.setWebPanelStorage).toHaveBeenCalledWith(
      'panel_review',
      'comments',
      [{ line: 12 }]
    )

    const restored = await app.request('/api/panels/panel_review/storage/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'comments' })
    })
    expect(await restored.json()).toEqual({
      value: [{ file: 'src/app.ts', line: 12 }]
    })

    const removedStorage = await app.request(
      '/api/panels/panel_review/storage',
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'comments' })
      }
    )
    expect(removedStorage.status).toBe(200)
    expect(service.deleteWebPanelStorage).toHaveBeenCalledWith(
      'panel_review',
      'comments'
    )

    const closed = await app.request('/api/panels/panel_review', {
      method: 'DELETE'
    })
    expect(closed.status).toBe(200)
    expect(service.deleteWebPanel).toHaveBeenCalledWith('panel_review', false)

    await app.request('/api/panels/panel_review?discardStoredData=true', {
      method: 'DELETE'
    })
    expect(service.deleteWebPanel).toHaveBeenLastCalledWith(
      'panel_review',
      true
    )
  })

  it('uses the panel SDK to broker scoped panel requests', async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const panelParent = { postMessage: vi.fn() }
    vi.stubGlobal('parent', panelParent)
    vi.stubGlobal('self', globalThis)
    vi.stubGlobal('addEventListener', (type: string, listener: unknown) =>
      listeners.set(type, listener as (...args: unknown[]) => unknown)
    )
    const intervalHandlers: Array<() => void> = []
    vi.stubGlobal('setInterval', (handler: () => void) => {
      intervalHandlers.push(handler)
      return 1
    })
    const targetLocation = { href: 'http://browser-app.test/start' }
    vi.stubGlobal('location', targetLocation)

    try {
      const sdk = (await import('@treeport/panel-sdk')) as {
        treeport: {
          version: number
          panel: { setTitle: (title: string | null) => void }
          context: () => Promise<unknown>
          network: { listeners: () => Promise<unknown> }
          storage: {
            set: (key: string, value: unknown) => Promise<void>
          }
          shortcuts: {
            onFind: (handler: () => void) => () => void
          }
        }
      }
      const context = sdk.treeport.context()
      const message = panelParent.postMessage.mock.calls[0]![0]
      listeners.get('message')!({
        source: panelParent,
        data: {
          source: 'treeport-host-v1',
          id: message.id,
          ok: true,
          value: { apiVersion: 1, panel: { id: 'panel_review' } }
        }
      })

      await expect(context).resolves.toMatchObject({
        apiVersion: 1,
        panel: { id: 'panel_review' }
      })
      expect(sdk.treeport.version).toBe(1)
      expect(panelParent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'treeport-panel-v1',
          method: 'context'
        }),
        '*'
      )

      const discovery = sdk.treeport.network.listeners()
      const discoveryMessage = panelParent.postMessage.mock.calls[1]![0]
      expect(discoveryMessage).toMatchObject({
        source: 'treeport-panel-v1',
        method: 'network.listeners'
      })
      listeners.get('message')!({
        source: panelParent,
        data: {
          source: 'treeport-host-v1',
          id: discoveryMessage.id,
          ok: true,
          value: { supported: true, message: null, listeners: [] }
        }
      })
      await expect(discovery).resolves.toEqual({
        supported: true,
        message: null,
        listeners: []
      })

      const stored = sdk.treeport.storage.set('comments', [{ line: 12 }])
      const storageMessage = panelParent.postMessage.mock.calls[2]![0]
      expect(storageMessage).toMatchObject({
        source: 'treeport-panel-v1',
        method: 'storage.set',
        key: 'comments',
        value: [{ line: 12 }]
      })
      listeners.get('message')!({
        source: panelParent,
        data: {
          source: 'treeport-host-v1',
          id: storageMessage.id,
          ok: true
        }
      })
      await expect(stored).resolves.toBeUndefined()

      sdk.treeport.panel.setTitle('Review route')
      expect(panelParent.postMessage).toHaveBeenLastCalledWith(
        {
          source: 'treeport-panel-v1',
          method: 'panel.title.set',
          title: 'Review route'
        },
        '*'
      )

      listeners.get('message')!({
        source: panelParent,
        data: {
          source: 'treeport-browser-v1',
          method: 'location.subscribe',
          subscription: 'browser-frame-1'
        }
      })
      expect(panelParent.postMessage).toHaveBeenLastCalledWith(
        {
          source: 'treeport-panel-v1',
          method: 'browser.location.set',
          subscription: 'browser-frame-1',
          url: 'http://browser-app.test/start'
        },
        '*'
      )

      targetLocation.href = 'http://browser-app.test/next'
      intervalHandlers[0]!()
      expect(panelParent.postMessage).toHaveBeenLastCalledWith(
        {
          source: 'treeport-panel-v1',
          method: 'browser.location.set',
          subscription: 'browser-frame-1',
          url: 'http://browser-app.test/next'
        },
        '*'
      )

      const findHandler = vi.fn()
      const unsubscribeFind = sdk.treeport.shortcuts.onFind(findHandler)
      const preventFindDefault = vi.fn()
      const stopFindPropagation = vi.fn()
      listeners.get('keydown')!({
        key: 'f',
        metaKey: true,
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        preventDefault: preventFindDefault,
        stopPropagation: stopFindPropagation
      })
      expect(findHandler).toHaveBeenCalledOnce()
      expect(preventFindDefault).toHaveBeenCalledOnce()
      expect(stopFindPropagation).toHaveBeenCalledOnce()

      listeners.get('message')!({
        source: panelParent,
        data: {
          source: 'treeport-host-v1',
          method: 'shortcut',
          shortcut: 'find'
        }
      })
      expect(findHandler).toHaveBeenCalledTimes(2)

      unsubscribeFind()
      listeners.get('message')!({
        source: panelParent,
        data: {
          source: 'treeport-host-v1',
          method: 'shortcut',
          shortcut: 'find'
        }
      })
      expect(findHandler).toHaveBeenCalledTimes(2)

      const preventDefault = vi.fn()
      const stopPropagation = vi.fn()
      listeners.get('keydown')!({
        key: '2',
        metaKey: true,
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        preventDefault,
        stopPropagation
      })
      expect(panelParent.postMessage).toHaveBeenLastCalledWith(
        {
          source: 'treeport-panel-v1',
          method: 'workspace.select',
          index: 1
        },
        '*'
      )
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(stopPropagation).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('serves immutable Vite output with restrictive browser headers', async () => {
    const { app, config, service } = fixture()
    const panelRoot = path.join(config.runtimeDir, 'typed-panel')
    const indexPath = path.join(panelRoot, 'index.html')
    const modulePath = path.join(panelRoot, 'panel.js')
    const indexSource =
      '<!doctype html><html><body><script type="module" src="panel.js"></script></body></html>'
    await fs.mkdir(panelRoot, { recursive: true })
    await fs.writeFile(indexPath, indexSource)
    await fs.writeFile(modulePath, 'export const answer = 42')
    vi.mocked(service.resolveWebPanelAsset).mockImplementation(
      async (_panelId, requestedPath) => ({
        kind: 'asset',
        path: requestedPath ? path.join(panelRoot, requestedPath) : indexPath,
        immutable: true,
        development: false,
        allowNetworkRequests: false
      })
    )

    try {
      const browserOrigin = 'https://treeport.example.ts.net:5173'
      const documentResponse = await app.request(
        '/api/web-panels/panel_review/assets/',
        {
          headers: {
            referer: `${browserOrigin}/projects/project_1/panels/panel_review`,
            'x-forwarded-host': 'treeport.example.ts.net:5173',
            'x-forwarded-proto': 'https'
          }
        }
      )
      expect(documentResponse.status).toBe(200)
      await expect(documentResponse.text()).resolves.toBe(indexSource)
      expect(
        documentResponse.headers
          .get('content-security-policy')
          ?.split(';')
          .map((directive) => directive.trim())
      ).toEqual(
        expect.arrayContaining([
          `default-src 'self' ${browserOrigin}`,
          `script-src 'self' ${browserOrigin}`,
          `style-src 'self' ${browserOrigin} 'unsafe-inline'`,
          `img-src 'self' ${browserOrigin} data:`,
          "connect-src 'none'",
          'frame-src http: https:',
          `frame-ancestors 'self' ${browserOrigin}`
        ])
      )

      const moduleResponse = await app.request(
        '/api/web-panels/panel_review/assets/panel.js'
      )
      expect(moduleResponse.status).toBe(200)
      expect(moduleResponse.headers.get('content-type')).toBe(
        'text/javascript; charset=utf-8'
      )
      const moduleSource = await moduleResponse.text()
      const compiled = (await import(
        /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`
      )) as { answer: number }
      expect(compiled.answer).toBe(42)
    } finally {
      await fs.rm(config.runtimeDir, { recursive: true, force: true })
    }
  })

  it('serves nested panel modules with their browser MIME type', async () => {
    const { app, config, service } = fixture()
    const modulePath = path.join(config.runtimeDir, 'nested', 'review.js')
    await fs.mkdir(path.dirname(modulePath), { recursive: true })
    await fs.writeFile(modulePath, 'export const loaded = true')
    vi.mocked(service.resolveWebPanelAsset).mockResolvedValue({
      kind: 'asset',
      path: modulePath,
      immutable: true,
      development: false,
      allowNetworkRequests: true
    })

    try {
      const response = await app.request(
        '/api/web-panels/panel_review/assets/nested/review.js'
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(
        'text/javascript; charset=utf-8'
      )
      expect(response.headers.get('content-security-policy')).toContain(
        'connect-src http: https:'
      )
      expect(await response.text()).toBe('export const loaded = true')
      expect(service.resolveWebPanelAsset).toHaveBeenCalledWith(
        'panel_review',
        'nested/review.js'
      )
    } finally {
      await fs.rm(config.runtimeDir, { recursive: true, force: true })
    }
  })

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
    const invalidEnvironment = await app.request(
      '/api/worktrees/wt_1/terminals',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'bad environment',
          env: { 'BAD=KEY': 'value' }
        })
      }
    )
    expect(invalidEnvironment.status).toBe(400)
    expect(service.createTerminal).not.toHaveBeenCalled()
  })

  it('forwards terminal completion behavior without changing argv', async () => {
    const { app, service } = fixture()
    const response = await app.request('/api/worktrees/wt_1/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Diff',
        argv: ['diff', 'main', '--mode', 'split'],
        cwd: '/repo/worktrees/topic',
        env: { CUSTOM: 'argument with spaces;$HOME' },
        returnToShell: true,
        initialSize: { cols: 132, rows: 47 }
      })
    })
    expect(response.status).toBe(201)
    expect(service.createTerminal).toHaveBeenCalledWith(
      'wt_1',
      'Diff',
      ['diff', 'main', '--mode', 'split'],
      {
        returnToShell: true,
        initialSize: { cols: 132, rows: 47 },
        cwd: '/repo/worktrees/topic',
        env: { CUSTOM: 'argument with spaces;$HOME' }
      }
    )

    const oneOff = await app.request('/api/worktrees/wt_1/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Open editor',
        argv: ['code', '.'],
        closeOnSuccess: true
      })
    })
    expect(oneOff.status).toBe(201)
    expect(service.createTerminal).toHaveBeenLastCalledWith(
      'wt_1',
      'Open editor',
      ['code', '.'],
      { closeOnSuccess: true }
    )
  })

  it('validates and forwards server directory browsing', async () => {
    const { app, service } = fixture()
    const browsed = await app.request(
      '/api/filesystem/directories?input=%2Frepos%2Fwith%20spaces&hidden=true'
    )
    expect(browsed.status).toBe(200)
    expect(service.browseDirectory).toHaveBeenCalledWith(
      '/repos/with spaces',
      true
    )

    const invalid = await app.request(
      '/api/filesystem/directories?input=&hidden=yes'
    )
    expect(invalid.status).toBe(400)
    expect(service.browseDirectory).toHaveBeenCalledTimes(1)
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

  it('sanitizes and correlates unexpected API errors', async () => {
    const { app, service } = fixture()
    vi.mocked(service.listProjects).mockRejectedValueOnce(
      new Error('Database connection failed at /internal/data')
    )
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    try {
      const response = await app.request('/api/projects?token=hidden', {
        headers: { 'x-request-id': 'request_test_123' }
      })
      const body = await response.json()

      expect(response.status).toBe(500)
      expect(response.headers.get('x-request-id')).toBe('request_test_123')
      expect(body).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unexpected server error',
          details: { requestId: 'request_test_123' }
        }
      })
      expect(JSON.stringify(body)).not.toContain('Database connection failed')
      expect(consoleError).toHaveBeenCalledWith(
        '[Treeport] API request failed',
        {
          requestId: 'request_test_123',
          method: 'GET',
          path: '/api/projects',
          status: 500,
          code: 'INTERNAL_ERROR',
          error: 'Database connection failed at /internal/data'
        }
      )
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        'token=hidden'
      )
    } finally {
      consoleError.mockRestore()
    }
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
      ],
      closeOnSuccess: true
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

  it('routes source-aware package definitions and package management operations', async () => {
    const { app, service } = fixture()
    const definitions = await app.request(
      '/api/terminal-preset-definitions?worktreeId=wt_1'
    )
    expect(definitions.status).toBe(200)
    expect(await definitions.json()).toMatchObject({
      definitions: [
        {
          name: 'Package dev',
          source: { type: 'package', scope: 'global' }
        }
      ],
      diagnostics: []
    })
    expect(service.listTerminalPresetDefinitions).toHaveBeenCalledWith({
      worktreeId: 'wt_1'
    })

    const resolved = await app.request(
      '/api/packages/project?path=%2Frepo%2Flinked'
    )
    expect(resolved.status).toBe(200)
    expect(service.resolveRegisteredProject).toHaveBeenCalledWith(
      '/repo/linked'
    )

    const installed = await app.request('/api/packages/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'npm:@acme/tools',
        projectId: 'project_1'
      })
    })
    expect(installed.status).toBe(200)
    expect(service.installPackage).toHaveBeenCalledWith(
      'npm:@acme/tools',
      'project_1'
    )

    const removed = await app.request('/api/packages/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'npm:@acme/tools' })
    })
    expect(removed.status).toBe(200)
    expect(service.removePackage).toHaveBeenCalledWith(
      'npm:@acme/tools',
      undefined
    )

    const updated = await app.request('/api/packages/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(updated.status).toBe(200)
    expect(service.updatePackages).toHaveBeenCalledWith(undefined)

    const reloaded = await app.request('/api/packages/reload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'project_1' })
    })
    expect(reloaded.status).toBe(200)
    expect(service.reloadPackages).toHaveBeenCalledWith('project_1')

    const invalid = await app.request('/api/packages/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: '' })
    })
    expect(invalid.status).toBe(400)
    expect(service.installPackage).toHaveBeenCalledTimes(1)
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

  it('accepts durable worktree creation and one remove endpoint', async () => {
    const { app, service } = fixture()
    const accepted = await app.request('/api/projects/p/worktree-operations', {
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
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toMatchObject({
      operation: { id: 'op_create', status: 'pending' }
    })
    expect(service.beginCreateWorktree).toHaveBeenCalledWith(
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
    const active = await app.request('/api/operations?projectId=p&kind=create')
    expect(await active.json()).toMatchObject({
      operations: [{ id: 'op_create', status: 'running' }]
    })
    expect(service.listActiveOperations).toHaveBeenCalledWith({
      projectId: 'p',
      kind: 'create'
    })

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

  it('uploads browser files to a private terminal-readable path', async () => {
    const { app, config, service } = fixture()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const uploadDirectory = path.join(config.runtimeDir, 'uploads')
    const stalePath = path.join(uploadDirectory, 'treeport-upload-stale.png')
    try {
      await fs.mkdir(uploadDirectory, { recursive: true })
      await fs.writeFile(stalePath, 'stale')
      const staleTime = new Date(Date.now() - 25 * 60 * 60_000)
      await fs.utimes(stalePath, staleTime, staleTime)

      const response = await app.request('/api/terminals/term_1/files', {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-treeport-file-extension': 'png'
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
      await expect(fs.stat(stalePath)).rejects.toMatchObject({
        code: 'ENOENT'
      })

      const legacyHeader = await app.request('/api/terminals/term_1/files', {
        method: 'POST',
        headers: { 'x-treeport-file-extension': 'txt' },
        body: new TextEncoder().encode('legacy')
      })
      expect(legacyHeader.status).toBe(201)
      expect(
        path.extname(
          ((await legacyHeader.json()) as { file: { path: string } }).file.path
        )
      ).toBe('.txt')

      const invalid = await app.request('/api/terminals/term_1/files', {
        method: 'POST',
        headers: { 'x-treeport-file-extension': '../png' },
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

  it('captures recent terminal output with a bounded line count', async () => {
    const { app, capturePane, service } = fixture()
    const response = await app.request('/api/terminals/term/capture?lines=12')

    expect(response.status).toBe(200)
    expect(service.getTerminal).toHaveBeenCalledWith('term')
    expect(service.getWorktree).toHaveBeenCalledWith('wt_1')
    expect(capturePane).toHaveBeenCalledWith(
      'treeport-wt-1',
      'treeport-term-1',
      12
    )
    expect(await response.json()).toMatchObject({
      terminalId: 'term',
      capturedAt: expect.any(String),
      lineLimit: 12,
      content: 'Preparing changes\nRunning tests'
    })

    const invalid = await app.request('/api/terminals/term/capture?lines=5001')
    expect(invalid.status).toBe(400)
    expect(service.getTerminal).toHaveBeenCalledTimes(1)

    capturePane.mockResolvedValueOnce(null)
    const unavailable = await app.request('/api/terminals/term/capture')
    expect(unavailable.status).toBe(409)
    expect(await unavailable.json()).toEqual({
      error: {
        code: 'TERMINAL_CAPTURE_UNAVAILABLE',
        message: 'Terminal pane is unavailable',
        details: { terminalId: 'term' }
      }
    })
    expect(capturePane).toHaveBeenLastCalledWith(
      'treeport-wt-1',
      'treeport-term-1',
      200
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

  it('does not retain the legacy SSE or raw terminal attachment routes', async () => {
    const { app } = fixture()
    expect((await app.request('/api/events')).status).toBe(404)
    expect((await app.request('/api/terminals/term/attach')).status).toBe(404)
  })

  it('serves the web entry point for deep links without masking API 404s', async () => {
    const webDist = path.join(
      '/tmp',
      `treeport-web-dist-${crypto.randomUUID()}`
    )
    await fs.mkdir(webDist, { recursive: true })
    await fs.writeFile(
      path.join(webDist, 'index.html'),
      '<!doctype html><title>Treeport route fallback</title>'
    )

    try {
      const { app } = fixture(webDist)
      const deepLink = await app.request(
        '/projects/project/worktrees/worktree/terminals/terminal'
      )
      expect(deepLink.status).toBe(200)
      expect(await deepLink.text()).toContain('Treeport route fallback')

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
