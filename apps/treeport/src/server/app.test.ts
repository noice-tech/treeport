import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import {
  authenticatedPrincipals,
  authorizeRequest,
  rejectHttpRequest
} from './request-security'
import { WorkspacePresenceManager } from './workspace-presence'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_PROTOCOL_VERSION,
  type JsonValue,
  type TerminalRuntimeMetadata
} from '@treeport/shared'
import {
  DomainError,
  ProductEventBus,
  type AppConfig,
  type TerminalSessionBackend,
  type TreeportService
} from './core/index'
import { testAccess } from './test-access'
import { createApp } from './app'
import type { WebPanelAssetResolution } from './core/web-panel-vite-runtime'
import type {
  ApplicationUpdateManager,
  ApplicationUpdateStatus
} from './application-update'
import type { TerminalMetadataManager } from './terminal-metadata'
import type { BrowserSessionManager } from './browser-sessions'

function fixture(webDist = '/missing') {
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 8733,
    databasePath: '/tmp/treeport-test.db',
    dataDir: '/tmp',
    cacheDir: path.join('/tmp', `treeport-cache-${crypto.randomUUID()}`),
    runtimeDir: path.join('/tmp', `treeport-test-${crypto.randomUUID()}`),
    shell: '/bin/zsh',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1:8733',
    daemonLifecycle: 'treeport',
    webDevelopment: false
  }
  const projectRecord = {
    id: 'p',
    name: 'Project',
    kind: 'folder' as const,
    rootPath: '/repo',
    repositoryPath: '/repo',
    mainWorktreePath: '/repo',
    defaultBranch: '',
    color: null,
    availability: { state: 'available' as const, message: null },
    worktrees: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const terminalRecord = {
    id: 'term_1',
    worktreeId: 'wt_1',
    name: 'Pi',
    argv: ['pi'],
    shellCommand: null,
    interactiveShell: true,
    status: 'running' as const,
    exitCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const createOperationRecord = {
    id: 'op_create',
    projectId: 'p',
    worktreeId: null,
    kind: 'create' as const,
    status: 'pending' as const,
    error: null,
    request: { name: 'feature', base: 'default' as const },
    result: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const removePreviewRecord = {
    worktreeId: 'wt_1',
    name: 'feature',
    path: '/repo/feature',
    head: 'abc123',
    branch: 'feature',
    detached: false,
    locked: false,
    lockReason: null,
    dirty: {
      dirty: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
      total: 0
    },
    detachedHeadReachable: null,
    forceRequired: false,
    eligible: true,
    reasons: [],
    warnings: [],
    cleanup: { commands: [], available: true, unavailableReason: null },
    terminals: [],
    confirmationToken: 'a'.repeat(64)
  }
  const removeOperationRecord = {
    id: 'op_1',
    projectId: 'p',
    worktreeId: 'wt_1',
    kind: 'remove' as const,
    status: 'pending' as const,
    error: null,
    request: {
      confirmation: true,
      confirmationToken: 'a'.repeat(64),
      confirmDestructive: false,
      preview: removePreviewRecord,
      checkoutIdentity: null,
      prunable: false,
      gitWorktreeKey: null,
      repositoryIdentity: null,
      phase: 'accepted' as const,
      managedWrapperPath: null,
      cleanupCommands: {
        status: 'pending' as const,
        definitionHash: null,
        skippedReason: null,
        commands: []
      }
    },
    result: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const serviceMethods = {
    events: new ProductEventBus(),
    listProjects: vi.fn(async () => []),
    listRecentProjects: vi.fn(() => [
      {
        id: 'recent',
        name: 'Recent',
        kind: 'folder',
        rootPath: '/recent',
        repositoryPath: '/recent',
        lastOpenedAt: '2026-01-01T00:00:00.000Z'
      }
    ]),
    openProject: vi.fn(async (id: string) => ({ ...projectRecord, id })),
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
      project: {
        state: 'valid' as const,
        kind: 'folder' as const,
        path: input
      },
      repository: { state: 'not-repository' as const, message: 'Not a repo' }
    })),
    closeProject: vi.fn(async () => undefined),
    dismissRecentProject: vi.fn(async () => undefined),
    deleteProject: vi.fn(async () => undefined),
    updateProjectColor: vi.fn((id: string, color: string | null) => ({
      id,
      color
    })),
    listTreeContextFields: vi.fn(() => ({
      fields: [{ id: 'issue', label: 'Issue', input: 'text' as const }],
      diagnostics: []
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
          shellCommand: null,
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
      ...projectRecord,
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
    getProjectSnapshot: vi.fn(async (id: string) => ({
      ...projectRecord,
      id
    })),
    resolveProject: vi.fn(async () => ({ id: 'p' })),
    refreshTerminalStatus: vi.fn(async (id: string) => ({
      ...terminalRecord,
      id
    })),
    database: {
      worktree: vi.fn(() => ({ id: 'wt_1', path: '/repo' }))
    },
    getWorktreeSnapshot: vi.fn(async (id: string) => {
      if (!['wt_1', 'wt_2'].includes(id)) {
        throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
      }

      return { id, panels: [{ id: `${id}_panel` }] }
    }),
    getWorktree: vi.fn(() => ({ id: 'wt_1' })),
    getWorktreeContext: vi.fn(() => ({ issue: 'TREE-123' })),
    requestWorkspaceOpen: vi.fn(async () => undefined),
    listWebPanelDefinitions: vi.fn(async () => [
      {
        id: 'project:review',
        title: 'Review',
        icon: null,
        source: { type: 'project' },
        permissions: [],
        permissionsGranted: true,
        sandbox: { allowSameOrigin: false }
      }
    ]),
    openBrowserPanel: vi.fn(async (worktreeId: string, url?: string) => ({
      panel: {
        id: 'panel_browser',
        kind: 'browser',
        worktreeId,
        title: url ? 'example.com' : 'Browser',
        url: url ?? 'about:blank',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }
    })),
    openBrowserPanelFromTerminal: vi.fn(
      async (_terminalId: string, url: string) => ({
        panel: {
          id: 'panel_browser',
          kind: 'browser',
          worktreeId: 'wt_1',
          title: 'example.com',
          url,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01'
        }
      })
    ),
    openBrowserPanelFromPanel: vi.fn(async (_panelId: string, url: string) => ({
      panel: {
        id: 'panel_popup',
        kind: 'browser',
        worktreeId: 'wt_1',
        title: 'popup.example.com',
        url,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }
    })),
    updateBrowserPanelState: vi.fn(
      async (panelId: string, state: { url: string; title: string }) => ({
        id: panelId,
        kind: 'browser',
        worktreeId: 'wt_1',
        ...state,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02'
      })
    ),
    createWebPanel: vi.fn(async (worktreeId: string) => ({
      id: 'panel_review',
      kind: 'web',
      worktreeId,
      definitionId: 'project:review',
      title: 'Review',
      launch: { input: null, cwd: null },
      permissions: [],
      sandbox: { allowSameOrigin: false },
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
        permissions: [],
        sandbox: { allowSameOrigin: false },
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02'
      },
      created: false,
      reused: true
    })),
    deletePanel: vi.fn(async () => undefined),
    getWebPanelContext: vi.fn(async () => ({
      apiVersion: 1,
      panel: {
        id: 'panel_review',
        kind: 'web',
        worktreeId: 'wt_1',
        definitionId: 'project:review',
        title: 'Review',
        launch: { input: null, cwd: null },
        permissions: [],
        sandbox: { allowSameOrigin: false },
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      },
      launch: { input: null, cwd: null },
      project: {
        id: 'p',
        name: 'Project',
        kind: 'folder',
        defaultBranch: null
      },
      worktree: {
        id: 'wt_1',
        name: 'Project',
        kind: 'folder',
        branch: null,
        head: null
      }
    })),
    listTreeFiles: vi.fn(async () => ({
      paths: ['src/app.ts'],
      truncated: false
    })),
    readTreeFile: vi.fn(async (_panelId: string, filePath: string) => ({
      path: filePath,
      content: 'export const value = 1\n',
      revision: 'revision-1'
    })),
    searchTreeFiles: vi.fn(async () => ({
      files: [
        {
          path: 'src/app.ts',
          matches: [
            {
              lineNumber: 1,
              column: 13,
              length: 5,
              preview: 'export const value = 1',
              previewStart: 0,
              lineLength: 22
            }
          ]
        }
      ],
      truncated: false
    })),
    writeTreeFile: vi.fn(async (_panelId: string, input: { path: string }) => ({
      path: input.path,
      revision: 'revision-2'
    })),
    getWebPanelDiff: vi.fn(async () => ({
      baseRef: 'origin/trunk',
      baseCommit: 'base',
      headCommit: 'head',
      generatedAt: '2026-01-01T00:00:00.000Z',
      unified: 'diff --git a/a b/a',
      changeSets: {
        branch: ['a'],
        staged: [],
        unstaged: [],
        untracked: []
      }
    })),
    getPanelListeners: vi.fn(async () => ({
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
    getWebPanelStorage: vi.fn(
      async (): Promise<JsonValue | undefined> => [
        { file: 'src/app.ts', line: 12 }
      ]
    ),
    setWebPanelStorage: vi.fn(async () => undefined),
    deleteWebPanelStorage: vi.fn(async () => undefined),
    resolveWebPanelAsset: vi.fn<
      (
        panelId: string,
        requestedPath: string
      ) => Promise<WebPanelAssetResolution>
    >(async () => ({
      kind: 'asset',
      path: '/missing',
      immutable: true,
      development: false,
      allowNetworkRequests: false
    })),
    createTerminal: vi.fn(async () => terminalRecord),
    getTerminal: vi.fn(async (id: string) => ({
      id,
      worktreeId: 'wt_1'
    })),
    beginCreateWorktree: vi.fn(async () => createOperationRecord),
    listActiveOperations: vi.fn(async () => [
      { ...createOperationRecord, status: 'running' as const }
    ]),
    getOperation: vi.fn(async (id: string) => ({
      ...createOperationRecord,
      id,
      status: 'running' as const
    })),
    removePreview: vi.fn(async () => removePreviewRecord),
    beginRemove: vi.fn(async () => removeOperationRecord),
    terminateAllTerminals: vi.fn(async () => 2)
  }
  // SAFETY: The fixture exposes the same doubles through the temporary façade
  // and the domain APIs used by the HTTP handlers.
  const service = testAccess<TreeportService & typeof serviceMethods>({
    ...serviceMethods,
    runEffect: vi.fn((effect) =>
      Effect.isEffect(effect)
        ? Effect.runPromise(effect as Effect.Effect<unknown, unknown, never>)
        : effect
    ),
    terminalUploadMutation: vi.fn((effect) => effect),
    projects: serviceMethods,
    worktrees: serviceMethods,
    terminals: serviceMethods,
    terminalPresets: serviceMethods,
    panels: serviceMethods,
    treeFiles: serviceMethods,
    packageManagement: serviceMethods
  })
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
  const metadataTrack = vi.fn(() => Effect.void)
  const metadataAcknowledgeBell = vi.fn(() => Effect.void)
  // SAFETY: The test fixture provides the asserted contract used here.
  const terminalMetadata = testAccess<TerminalMetadataManager>({
    snapshot: metadataSnapshot,
    get: metadataGet,
    trackTerminal: metadataTrack,
    acknowledgeBell: metadataAcknowledgeBell
  })
  const captureTerminal = vi.fn(
    async (): Promise<string | null> => 'Preparing changes\nRunning tests'
  )
  const applicationUpdateStatus: ApplicationUpdateStatus = {
    currentVersion: '0.4.0',
    latestVersion: null,
    updateAvailable: false,
    checkedAt: null,
    canUpdate: false,
    blockedReason: null,
    phase: 'idle',
    operationId: null,
    targetVersion: null,
    error: null
  }
  const applicationUpdate = testAccess<ApplicationUpdateManager>({
    status: vi.fn(async () => applicationUpdateStatus),
    check: vi.fn(async () => undefined),
    beginPolling: vi.fn(),
    start: vi.fn(async () => applicationUpdateStatus),
    dispose: vi.fn()
  })
  const browserAgentCommand = vi.fn(async () => 'browser output')
  const browserRequestPanelClose = vi.fn(async () => true)
  const browserSessions = testAccess<BrowserSessionManager>({
    agentCommand: browserAgentCommand,
    requestPanelClose: browserRequestPanelClose
  })
  const terminalHost = testAccess<TerminalSessionBackend>({
    captureTerminal,
    shutdownIfEmpty: vi.fn(async () => undefined)
  })
  const presence = new WorkspacePresenceManager(service.events)
  const app = createApp({
    service,
    config,
    terminalHost,
    applicationUpdate,
    terminalMetadata,
    browserSessions,
    presence,
    webDist
  })
  return {
    app,
    presence,
    applicationUpdate,
    browserAgentCommand,
    browserRequestPanelClose,
    captureTerminal,
    config,
    metadataAcknowledgeBell,
    metadataGet,
    metadataSnapshot,
    metadataTrack,
    service,
    terminalHost
  }
}

describe('HTTP API validation', () => {
  it('binds workspace presence to authenticated requests and validates focus', async ({
    onTestFinished
  }) => {
    const { app, presence, service } = fixture()
    const listener = await service.runEffect(
      NodeHttpServer.makeHandler(app.httpApp)
    )
    const server = http.createServer((request, response) => {
      const security = authorizeRequest(request)
      if (!security.allowed) {
        rejectHttpRequest(request, response, security)
        return
      }

      if (security.principal) {
        authenticatedPrincipals.set(request, security.principal)
      }

      listener(request, response)
    })
    onTestFinished(async () => {
      presence.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    // SAFETY: The server is listening on a TCP port.
    const address = server.address() as AddressInfo
    const url = `http://127.0.0.1:${address.port}/api/presence`
    const headers = {
      'content-type': 'application/json',
      host: 'treeport.tailnet.ts.net',
      origin: 'https://treeport.tailnet.ts.net',
      'x-forwarded-host': 'treeport.tailnet.ts.net',
      'x-forwarded-proto': 'https',
      'tailscale-user-login': 'alice@example.test',
      'tailscale-user-name': 'Alice'
    }
    const input = {
      sessionId: crypto.randomUUID(),
      worktreeId: 'wt_1',
      focusedPanelId: 'wt_1_panel',
      visible: true,
      focused: true
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input)
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      identity: {
        source: 'tailscale',
        login: 'alice@example.test',
        name: 'Alice',
        profilePicture: null
      }
    })
    expect(presence.snapshot()).toMatchObject([
      { ...input, identity: { name: 'Alice' } }
    ])

    const bobHeaders = {
      ...headers,
      'tailscale-user-login': 'bob@example.test',
      'tailscale-user-name': 'Bob'
    }
    await fetch(url, {
      method: 'POST',
      headers: bobHeaders,
      body: JSON.stringify(input)
    })
    expect(presence.snapshot().map((viewer) => viewer.identity.name)).toEqual([
      'Alice',
      'Bob'
    ])
    await fetch(url, {
      method: 'POST',
      headers: bobHeaders,
      body: JSON.stringify({
        ...input,
        worktreeId: 'wt_2',
        focusedPanelId: 'wt_2_panel'
      })
    })
    expect(presence.snapshot().map((viewer) => viewer.worktreeId)).toEqual([
      'wt_1',
      'wt_2'
    ])
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...input, visible: false })
    })
    expect(presence.snapshot()[0]).toMatchObject({
      visible: false,
      focused: false,
      focusedPanelId: null
    })

    for (const [body, status] of [
      [{ ...input, identity: { name: 'Mallory' } }, 400],
      [{ ...input, focusedPanelId: 'wt_2_panel' }, 400],
      [{ ...input, worktreeId: null }, 400],
      [{ ...input, worktreeId: 'missing' }, 404],
      [{ ...input, sessionId: 'not-a-session' }, 400]
    ] as const) {
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
          })
        ).status
      ).toBe(status)
    }
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers, origin: 'https://evil.example' },
          body: JSON.stringify(input)
        })
      ).status
    ).toBe(403)
    expect(presence.snapshot()).toHaveLength(2)

    // Even with the same tab ID, Bob can remove only Bob's presence.
    await fetch(url, {
      method: 'POST',
      headers: bobHeaders,
      body: JSON.stringify({
        ...input,
        worktreeId: null,
        focusedPanelId: null
      })
    })
    expect(presence.snapshot().map((viewer) => viewer.identity.name)).toEqual([
      'Alice'
    ])
    // A Fetch request that bypasses the Node ingress cannot forge its principal.
    expect(
      (
        await app.request('/api/presence', {
          method: 'POST',
          headers,
          body: JSON.stringify(input)
        })
      ).status
    ).toBe(401)
  })

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

  it('reports and starts only the server-selected application update', async () => {
    const { app, applicationUpdate } = fixture()
    const available: ApplicationUpdateStatus = {
      currentVersion: '0.4.0',
      latestVersion: '0.5.0',
      updateAvailable: true,
      checkedAt: '2026-03-20T12:00:00.000Z',
      canUpdate: true,
      blockedReason: null,
      phase: 'idle',
      operationId: null,
      targetVersion: '0.5.0',
      error: null
    }
    vi.mocked(applicationUpdate.status).mockResolvedValue(available)
    vi.mocked(applicationUpdate.start).mockResolvedValue({
      ...available,
      phase: 'starting'
    })

    const status = await app.request('/api/update')
    expect(status.status).toBe(200)
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect(await status.json()).toEqual(available)

    const started = await app.request('/api/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '99.0.0' })
    })
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({
      currentVersion: '0.4.0',
      targetVersion: '0.5.0',
      phase: 'starting'
    })
    expect(applicationUpdate.start).toHaveBeenCalledWith()

    vi.mocked(applicationUpdate.start).mockRejectedValue(
      new DomainError(
        'APPLICATION_UPDATE_IN_PROGRESS',
        'Another Treeport update is already running.',
        409
      )
    )
    const conflict = await app.request('/api/update', { method: 'POST' })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({
      error: {
        code: 'APPLICATION_UPDATE_IN_PROGRESS',
        message: 'Another Treeport update is already running.'
      }
    })
  })

  it('routes persistent Browser and web-panel lifecycle with scoped runtime reads', async () => {
    const { app, browserAgentCommand, service } = fixture()
    const browser = await app.request('/api/worktrees/wt_1/browser-panels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/application',
        sourceTerminalId: 'term_1'
      })
    })
    expect(browser.status).toBe(201)
    expect(await browser.json()).toMatchObject({
      panel: { kind: 'browser', worktreeId: 'wt_1' }
    })
    expect(service.openBrowserPanel).toHaveBeenCalledWith(
      'wt_1',
      'https://example.com/application',
      'term_1',
      null
    )

    const terminalBrowser = await app.request(
      '/api/terminals/term_1/browser-panels/open',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://localhost:4173/' })
      }
    )
    expect(terminalBrowser.status).toBe(201)
    expect(service.openBrowserPanelFromTerminal).toHaveBeenCalledWith(
      'term_1',
      'http://localhost:4173/'
    )

    expect(
      (
        await app.request('/api/panels/panel_browser/browser-state', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url: 'https://example.com/native',
            title: 'Native application'
          })
        })
      ).status
    ).toBe(404)
    expect(
      (
        await app.request('/api/panels/panel_browser/browser-popups', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://popup.example.com/' })
        })
      ).status
    ).toBe(404)

    for (const url of [
      'file:///tmp/private',
      'https://user:secret@example.com/'
    ]) {
      expect(
        (
          await app.request('/api/worktrees/wt_1/browser-panels', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url })
          })
        ).status
      ).toBe(400)
    }
    expect(service.openBrowserPanel).toHaveBeenCalledOnce()

    const snapshot = await app.request(
      '/api/panels/panel_browser/browser-agent',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'snapshot', args: [] })
      }
    )
    expect(snapshot.status).toBe(200)
    expect(await snapshot.json()).toEqual({ output: 'browser output' })
    expect(browserAgentCommand).toHaveBeenCalledWith('panel_browser', {
      command: 'snapshot',
      args: []
    })

    browserAgentCommand.mockRejectedValueOnce(
      new Error('The Browser panel is not visible.')
    )
    const failedScreenshot = await app.request(
      '/api/panels/panel_browser/browser-agent',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'screenshot', args: [] })
      }
    )
    expect(failedScreenshot.status).toBe(409)
    expect(await failedScreenshot.json()).toEqual({
      error: {
        code: 'BROWSER_COMMAND_FAILED',
        message: 'The Browser panel is not visible.',
        details: {
          command: 'screenshot',
          recovery:
            'Open Browser panel_browser in Treeport, then retry the screenshot.'
        }
      }
    })

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
      await (await app.request('/api/panels/panel_review/files')).json()
    ).toEqual({ paths: ['src/app.ts'], truncated: false })
    expect(service.listTreeFiles).toHaveBeenCalledWith('panel_review')

    const searchFiles = await app.request(
      '/api/panels/panel_review/files/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'value' })
      }
    )
    expect(await searchFiles.json()).toEqual({
      files: [
        {
          path: 'src/app.ts',
          matches: [
            {
              lineNumber: 1,
              column: 13,
              length: 5,
              preview: 'export const value = 1',
              previewStart: 0,
              lineLength: 22
            }
          ]
        }
      ],
      truncated: false
    })
    expect(service.searchTreeFiles).toHaveBeenCalledWith(
      'panel_review',
      'value'
    )
    for (const query of ['', 'two\nlines']) {
      expect(
        (
          await app.request('/api/panels/panel_review/files/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query })
          })
        ).status
      ).toBe(400)
    }
    expect(service.searchTreeFiles).toHaveBeenCalledOnce()

    const readFile = await app.request('/api/panels/panel_review/files/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/app.ts' })
    })
    expect(await readFile.json()).toEqual({
      path: 'src/app.ts',
      content: 'export const value = 1\n',
      revision: 'revision-1'
    })
    expect(service.readTreeFile).toHaveBeenCalledWith(
      'panel_review',
      'src/app.ts'
    )

    const writeFile = await app.request('/api/panels/panel_review/files', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'src/app.ts',
        content: 'export const value = 2\n',
        expectedRevision: 'revision-1'
      })
    })
    expect(await writeFile.json()).toEqual({
      path: 'src/app.ts',
      revision: 'revision-2'
    })
    expect(service.writeTreeFile).toHaveBeenCalledWith('panel_review', {
      path: 'src/app.ts',
      content: 'export const value = 2\n',
      expectedRevision: 'revision-1'
    })
    expect(
      (
        await app.request('/api/panels/panel_review/files/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '../outside' })
        })
      ).status
    ).toBe(400)

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
    expect(service.getPanelListeners).toHaveBeenCalledWith('panel_review')

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
      found: true,
      value: [{ file: 'src/app.ts', line: 12 }]
    })

    vi.mocked(service.getWebPanelStorage)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(null)
    const missingStorage = await app.request(
      '/api/panels/panel_review/storage/get',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'missing' })
      }
    )
    expect(await missingStorage.json()).toEqual({ found: false, value: null })
    const nullStorage = await app.request(
      '/api/panels/panel_review/storage/get',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'null-value' })
      }
    )
    expect(await nullStorage.json()).toEqual({ found: true, value: null })

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
    expect(service.deletePanel).toHaveBeenCalledWith('panel_review', false)

    await app.request('/api/panels/panel_review?discardStoredData=true', {
      method: 'DELETE'
    })
    expect(service.deletePanel).toHaveBeenLastCalledWith('panel_review', true)
  })

  it('asks for confirmation only when Browser reports beforeunload', async () => {
    const { app, browserRequestPanelClose, service } = fixture()
    browserRequestPanelClose.mockResolvedValueOnce(false)

    const blocked = await app.request('/api/panels/browser_panel', {
      method: 'DELETE'
    })
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toEqual({
      error: {
        code: 'BROWSER_BEFORE_UNLOAD',
        message: 'Changes you made may not be saved.'
      }
    })
    expect(service.deletePanel).not.toHaveBeenCalled()

    const closed = await app.request('/api/panels/browser_panel?force=true', {
      method: 'DELETE'
    })
    expect(closed.status).toBe(200)
    expect(browserRequestPanelClose).toHaveBeenLastCalledWith(
      'browser_panel',
      true
    )
    expect(service.deletePanel).toHaveBeenCalledWith('browser_panel', false)
  })

  it('uses the panel SDK to broker scoped panel requests', async () => {
    const listeners = new Map<string, EventListener>()
    const panelParent = { postMessage: vi.fn() }
    vi.stubGlobal('parent', panelParent)
    vi.stubGlobal('self', globalThis)
    vi.stubGlobal('addEventListener', (type: string, listener: EventListener) =>
      listeners.set(type, listener)
    )
    const dispatch = <EventFixture extends object>(
      type: string,
      event: EventFixture
    ) => listeners.get(type)!(testAccess<Event>(event))
    try {
      // SAFETY: The test fixture provides the asserted contract used here.
      const sdk = (await import('@treeport/panel-sdk')) as {
        treeport: {
          version: number
          panel: { setTitle: (title: string | null) => void }
          context: () => Promise<object>
          network: { listeners: () => Promise<object> }
          files: { search: (query: string) => Promise<object> }
          storage: {
            set: (key: string, value: JsonValue) => Promise<void>
          }
          shortcuts: {
            onFind: (handler: () => void) => () => void
          }
        }
      }
      const context = sdk.treeport.context()
      const message = panelParent.postMessage.mock.calls[0]![0]
      dispatch('message', {
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
      dispatch('message', {
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

      const search = sdk.treeport.files.search('exact value')
      const searchMessage = panelParent.postMessage.mock.calls.at(-1)![0]
      expect(searchMessage).toMatchObject({
        source: 'treeport-panel-v1',
        method: 'files.search',
        query: 'exact value'
      })
      dispatch('message', {
        source: panelParent,
        data: {
          source: 'treeport-host-v1',
          id: searchMessage.id,
          ok: true,
          value: {
            files: [{ path: 'src/app.ts', matches: [] }],
            truncated: false
          }
        }
      })
      await expect(search).resolves.toEqual({
        files: [{ path: 'src/app.ts', matches: [] }],
        truncated: false
      })

      const stored = sdk.treeport.storage.set('comments', [{ line: 12 }])
      const storageMessage = panelParent.postMessage.mock.calls.at(-1)![0]
      expect(storageMessage).toMatchObject({
        source: 'treeport-panel-v1',
        method: 'storage.set',
        key: 'comments',
        value: [{ line: 12 }]
      })
      dispatch('message', {
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

      const findHandler = vi.fn()
      const unsubscribeFind = sdk.treeport.shortcuts.onFind(findHandler)
      const preventFindDefault = vi.fn()
      const stopFindPropagation = vi.fn()
      dispatch('keydown', {
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

      dispatch('message', {
        source: panelParent,
        data: {
          source: 'treeport-host-v1',
          method: 'shortcut',
          shortcut: 'find'
        }
      })
      expect(findHandler).toHaveBeenCalledTimes(2)

      unsubscribeFind()
      dispatch('message', {
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
      dispatch('keydown', {
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
      // SAFETY: The test fixture provides the asserted contract used here.
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
    const ambiguousCommand = await app.request(
      '/api/worktrees/wt_1/terminals',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'bad command',
          argv: ['bun'],
          shellCommand: 'bun remotion'
        })
      }
    )
    expect(ambiguousCommand.status).toBe(400)
    expect(service.createTerminal).not.toHaveBeenCalled()
  })

  it('forwards terminal completion behavior without changing argv', async () => {
    const { app, service } = fixture()
    const response = await app.request('/api/worktrees/wt_1/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Diff',
        initialTitle: 'Review changes',
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
        initialTitle: 'Review changes',
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

    const shellCommand = await app.request('/api/worktrees/wt_1/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Remotion',
        shellCommand: 'bun remotion',
        returnToShell: true
      })
    })
    expect(shellCommand.status).toBe(201)
    expect(service.createTerminal).toHaveBeenLastCalledWith(
      'wt_1',
      'Remotion',
      undefined,
      { returnToShell: true, shellCommand: 'bun remotion' }
    )
  })

  it('targets workspace opening at the client that shows the source terminal', async () => {
    const { app, service } = fixture()
    const response = await app.request('/api/worktrees/wt_1/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceTerminalId: 'term_source' })
    })

    expect(response.status).toBe(200)
    expect(service.requestWorkspaceOpen).toHaveBeenCalledWith(
      'wt_1',
      'term_source'
    )
  })

  it('validates and forwards server directory browsing', async () => {
    const { app, service } = fixture()
    const browsed = await app.request(
      '/api/filesystem/directories?input=%2Frepos%2Fwith%20spaces&hidden=true'
    )
    expect(browsed.status).toBe(200)
    expect(await browsed.json()).toMatchObject({
      project: {
        state: 'valid',
        kind: 'folder',
        path: '/repos/with spaces'
      }
    })
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

  it('keeps recent, open, close, dismiss, and destructive delete as distinct routes', async () => {
    const { app, service } = fixture()

    const recent = await app.request('/api/projects/recent')
    expect(recent.status).toBe(200)
    expect(await recent.json()).toMatchObject({
      projects: [
        {
          id: 'recent',
          kind: 'folder',
          rootPath: '/recent',
          repositoryPath: '/recent'
        }
      ]
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

    const dismissed = await app.request('/api/projects/p/recent', {
      method: 'DELETE'
    })
    expect(dismissed.status).toBe(200)
    expect(service.dismissRecentProject).toHaveBeenCalledWith('p')

    const removed = await app.request('/api/projects/p', {
      method: 'DELETE'
    })
    expect(removed.status).toBe(200)
    expect(service.deleteProject).toHaveBeenCalledWith('p')
    expect(service.closeProject).toHaveBeenCalledTimes(1)
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
    const contextFields = await app.request(
      '/api/tree-context-fields?projectId=project_1'
    )
    expect(contextFields.status).toBe(200)
    expect(await contextFields.json()).toEqual({
      fields: [{ id: 'issue', label: 'Issue', input: 'text' }],
      diagnostics: []
    })
    expect(service.listTreeContextFields).toHaveBeenCalledWith('project_1')

    const treeContext = await app.request('/api/worktrees/wt_1/context')
    expect(treeContext.status).toBe(200)
    expect(await treeContext.json()).toEqual({
      context: { issue: 'TREE-123' }
    })
    expect(service.getWorktreeContext).toHaveBeenCalledWith('wt_1')

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

  it('interrupts owned HTTP work when the client aborts', async () => {
    const { app, service } = fixture()
    let started = false
    let interrupted = false
    vi.mocked(service.listProjects).mockReturnValueOnce(
      // SAFETY: This test intentionally replaces the Promise double with the
      // Effect returned by the production domain service.
      Effect.sync(() => {
        started = true
      }).pipe(
        Effect.zipRight(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          })
        )
      ) as never
    )
    const abort = new AbortController()
    const response = app.request(
      new Request('http://localhost/api/projects', { signal: abort.signal })
    )

    await vi.waitFor(() => expect(started).toBe(true))
    abort.abort()
    await expect(response).resolves.toMatchObject({ status: 499 })
    await vi.waitFor(() => expect(interrupted).toBe(true))
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
        context: {
          issue: 'TREE-123',
          brief: 'Review the cache behavior.'
        },
        initialTerminal: {
          name: 'Terminal',
          initialTitle: 'Review changes',
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
        initialTitle: 'Review changes',
        argv: ['tool', 'semi;colon', '$HOME'],
        returnToShell: true,
        initialSize: { cols: 144, rows: 48 }
      },
      'wt_main',
      {
        issue: 'TREE-123',
        brief: 'Review the cache behavior.'
      }
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
      // SAFETY: The test fixture provides the asserted contract used here.
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
          // SAFETY: The test fixture provides the asserted contract used here.
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
    const { app, captureTerminal, service } = fixture()
    const response = await app.request('/api/terminals/term/capture?lines=12')

    expect(response.status).toBe(200)
    expect(service.getTerminal).toHaveBeenCalledWith('term')
    expect(captureTerminal).toHaveBeenCalledWith('term', 12)
    expect(await response.json()).toMatchObject({
      terminalId: 'term',
      capturedAt: expect.any(String),
      lineLimit: 12,
      content: 'Preparing changes\nRunning tests'
    })

    const invalid = await app.request('/api/terminals/term/capture?lines=5001')
    expect(invalid.status).toBe(400)
    expect(service.getTerminal).toHaveBeenCalledTimes(1)

    captureTerminal.mockResolvedValueOnce(null)
    const unavailable = await app.request('/api/terminals/term/capture')
    expect(unavailable.status).toBe(409)
    expect(await unavailable.json()).toEqual({
      error: {
        code: 'TERMINAL_CAPTURE_UNAVAILABLE',
        message: 'Terminal is unavailable',
        details: { terminalId: 'term' }
      }
    })
    expect(captureTerminal).toHaveBeenLastCalledWith('term', 200)
  })

  it('shuts down an empty detached host after terminating all terminals', async () => {
    const { app, service, terminalHost } = fixture()
    const response = await app.request('/api/admin/terminate-terminals', {
      method: 'POST'
    })

    expect(response.status).toBe(200)
    expect(service.terminateAllTerminals).toHaveBeenCalledOnce()
    expect(terminalHost.shutdownIfEmpty).toHaveBeenCalledOnce()
    expect(await response.json()).toEqual({ terminated: 2 })
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

      const head = await app.request(
        '/projects/project/worktrees/worktree/terminals/terminal',
        { method: 'HEAD' }
      )
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')

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
