import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import type { WebAppStorage } from '@treeport/app-sdk'
import {
  authenticatedViewers,
  authorizeRequest,
  rejectHttpRequest
} from './request-security.ts'
import { WorkspacePresenceManager } from './workspace-presence.ts'
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
} from './core/index.ts'
import { testAccess } from './test-access.ts'
import { createApp } from './app.ts'
import type { WebAppAssetResolution } from './core/web-app-vite-runtime.ts'
import type { TerminalMetadataManager } from './terminal-metadata.ts'
import type { BrowserSessionManager } from './browser-sessions.ts'

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
    apiUrl: 'http://127.0.0.1:8733',
    remoteUrl: null,
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
    originUrl: null,
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
    command: null,
    status: 'running' as const,
    exitCode: null,
    parentTerminalId: null,
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
      skipCleanup: false,
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
    listLaunchers: vi.fn(() => [
      {
        id: 'launcher_existing',
        name: 'Existing',
        executable: 'pi',
        args: [],
        closeOnSuccess: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]),
    listLauncherDefinitions: vi.fn(() => ({
      definitions: [
        {
          id: 'package:local:tools:launcher:dev',
          name: 'Package dev',
          executable: 'pnpm',
          args: ['dev'],
          shellCommand: null,
          cwd: null,
          env: {},
          closeOnSuccess: false,
          source: {
            type: 'package',
            packageId: 'local:tools',
            source: './tools',
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
    reloadPackages: vi.fn(() => ({ results: [], diagnostics: [] })),
    createLauncher: vi.fn(
      (input: {
        name: string
        executable: string
        args: string[]
        closeOnSuccess: boolean
      }) => ({
        id: 'launcher_new',
        ...input,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      })
    ),
    updateLauncher: vi.fn(
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
    deleteLauncher: vi.fn(),
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

      return { id, workspaceItems: [{ id: `${id}_app` }] }
    }),
    getWorktree: vi.fn(() => ({ id: 'wt_1' })),
    requestWorkspaceOpen: vi.fn(async () => undefined),
    listWebAppDefinitions: vi.fn(async () => [
      {
        id: 'project:review',
        title: 'Review',
        icon: null,
        source: { type: 'project' },
        permissions: [],
        permissionsGranted: true,
        sandbox: { enabled: true, allowSameOrigin: false }
      }
    ]),
    openBrowserApp: vi.fn(async (worktreeId: string, url?: string) => ({
      app: {
        id: 'app_browser',
        kind: 'browser',
        worktreeId,
        title: url ? 'example.com' : 'Browser',
        url: url ?? 'about:blank',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }
    })),
    openBrowserAppFromTerminal: vi.fn(
      async (_terminalId: string, url: string) => ({
        app: {
          id: 'app_browser',
          kind: 'browser',
          worktreeId: 'wt_1',
          title: 'example.com',
          url,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01'
        }
      })
    ),
    openBrowserAppFromApp: vi.fn(async (_appId: string, url: string) => ({
      app: {
        id: 'app_popup',
        kind: 'browser',
        worktreeId: 'wt_1',
        title: 'popup.example.com',
        url,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }
    })),
    updateBrowserAppState: vi.fn(
      async (appId: string, state: { url: string; title: string }) => ({
        id: appId,
        kind: 'browser',
        worktreeId: 'wt_1',
        ...state,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02'
      })
    ),
    createWebApp: vi.fn(async (worktreeId: string) => ({
      id: 'app_review',
      kind: 'web',
      worktreeId,
      definitionId: 'project:review',
      title: 'Review',
      launch: { input: null, cwd: null },
      permissions: [],
      sandbox: { enabled: true, allowSameOrigin: false },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })),
    openWebApp: vi.fn(async (worktreeId: string) => ({
      app: {
        id: 'app_review',
        kind: 'web',
        worktreeId,
        definitionId: 'project:review',
        title: 'Review',
        launch: {
          input: { path: 'output/demo.mp4' },
          cwd: 'packages/preview'
        },
        permissions: [],
        sandbox: { enabled: true, allowSameOrigin: false },
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02'
      },
      created: false,
      reused: true
    })),
    deleteApp: vi.fn(async () => undefined),
    getWebAppContext: vi.fn(async () => ({
      apiVersion: 1,
      app: {
        id: 'app_review',
        kind: 'web',
        worktreeId: 'wt_1',
        definitionId: 'project:review',
        title: 'Review',
        launch: { input: null, cwd: null },
        permissions: [],
        sandbox: { enabled: true, allowSameOrigin: false },
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
    readTreeFile: vi.fn(async (_appId: string, filePath: string) => ({
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
    writeTreeFile: vi.fn(async (_appId: string, input: { path: string }) => ({
      path: input.path,
      revision: 'revision-2'
    })),
    getWebAppDiffImage: vi.fn(async () => ({
      dataUrl: 'data:image/png;base64,iVBORw==',
      byteLength: 4
    })),
    getWebAppFileDiff: vi.fn(async (_appId: string, filePath: string) => ({
      path: filePath,
      status: 'ready' as const,
      unified: 'diff --git a/a b/a',
      revision: 'revision-1',
      message: null
    })),
    getWebAppDiff: vi.fn(async () => ({
      baseRef: 'origin/trunk',
      baseCommit: 'base',
      headCommit: 'head',
      generatedAt: '2026-01-01T00:00:00.000Z',
      lineCounts: { additions: 1, deletions: 1 },
      files: [
        {
          path: 'a',
          previousPath: null,
          status: 'modified' as const
        }
      ],
      changeSets: {
        branch: ['a'],
        staged: [],
        unstaged: [],
        untracked: []
      }
    })),
    getAppListeners: vi.fn(async () => ({
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
    hasWebAppStorage: vi.fn(async () => true),
    getWebAppStorage: vi.fn(
      async (): Promise<JsonValue | undefined> => [
        { file: 'src/app.ts', line: 12 }
      ]
    ),
    setWebAppStorage: vi.fn(async () => undefined),
    deleteWebAppStorage: vi.fn(async () => undefined),
    resolveWebAppAsset: vi.fn<
      (appId: string, requestedPath: string) => Promise<WebAppAssetResolution>
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
    getKnownTerminal: vi.fn(async (id: string) => ({
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
    launchers: serviceMethods,
    apps: serviceMethods,
    treeFiles: serviceMethods,
    packageManagement: serviceMethods
  })

  const runtimeMetadata: TerminalRuntimeMetadata = {
    terminalId: 'term',
    title: 'pi · /repo',
    program: 'pi',
    activity: {
      state: 'idle',
      kind: null,
      progress: null,
      app: null,
      message: null,
      since: null
    },
    attention: null
  }

  const metadataSnapshot = vi.fn<() => TerminalRuntimeMetadata[]>(() => [])

  const metadataGet = vi.fn((terminalId: string) => ({
    ...runtimeMetadata,
    terminalId
  }))

  const metadataTrack = vi.fn(() => Effect.void)
  const metadataAcknowledgeAttention = vi.fn(() => Effect.void)

  const terminalMetadata = testAccess<TerminalMetadataManager>({
    snapshot: metadataSnapshot,
    get: metadataGet,
    trackTerminal: metadataTrack,
    acknowledgeAttention: metadataAcknowledgeAttention
  })

  const captureTerminal = vi.fn(
    async (_terminalId: string, _lines: number): Promise<string | null> =>
      'Preparing changes\nRunning tests'
  )

  const browserIssueTicket = vi.fn(() => Effect.succeed('b'.repeat(43)))
  const browserAgentCommand = vi.fn(async () => 'browser output')
  const browserRequestAppClose = vi.fn(async () => true)

  const browserSessions = testAccess<BrowserSessionManager>({
    issueTicket: browserIssueTicket,
    agentCommand: browserAgentCommand,
    requestAppClose: browserRequestAppClose
  })

  const terminalHost = testAccess<TerminalSessionBackend>({
    captureTerminal: (terminalId: string, lines: number) =>
      Effect.promise(() => captureTerminal(terminalId, lines)),
    shutdownIfEmpty: vi.fn(() => Effect.void)
  })

  const presence = new WorkspacePresenceManager(service.events)

  const app = createApp({
    service,
    config,
    terminalHost,
    terminalMetadata,
    browserSessions,
    presence,
    webDist
  })

  return {
    app,
    presence,
    browserIssueTicket,
    browserAgentCommand,
    browserRequestAppClose,
    captureTerminal,
    config,
    metadataAcknowledgeAttention,
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
    const { app, presence, service, browserIssueTicket } = fixture()

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
        authenticatedViewers.set(request, {
          account: security.principal,
          deviceId: security.deviceId
        })
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
      'tailscale-user-name': 'Alice',
      'x-forwarded-for': '100.64.0.10'
    }

    const input = {
      sessionId: crypto.randomUUID(),
      worktreeId: 'wt_1',
      focusedAppId: 'wt_1_app',
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

    const ticketPath = '/api/apps/app_browser/browser-ticket'
    const ticketInput = { clientId: 'viewer-one', visible: true }

    const ticketResponse = await fetch(new URL(ticketPath, url), {
      method: 'POST',
      headers,
      body: JSON.stringify(ticketInput)
    })

    expect(ticketResponse.status).toBe(200)
    expect(browserIssueTicket).toHaveBeenCalledWith(
      'app_browser',
      'viewer-one',
      true,
      {
        account: {
          source: 'tailscale',
          login: 'alice@example.test',
          name: 'Alice',
          profilePicture: null
        },
        deviceId: 'tailscale:100.64.0.10'
      }
    )

    for (const field of ['account', 'deviceId', 'identity']) {
      const forged = await fetch(new URL(ticketPath, url), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...ticketInput, [field]: 'forged' })
      })

      expect(forged.status).toBe(400)
    }

    expect(
      (
        await app.request(ticketPath, {
          method: 'POST',
          headers,
          body: JSON.stringify(ticketInput)
        })
      ).status
    ).toBe(401)
    expect(browserIssueTicket).toHaveBeenCalledTimes(1)

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
        focusedAppId: 'wt_2_app'
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
      focusedAppId: null
    })

    for (const [body, status] of [
      [{ ...input, identity: { name: 'Mallory' } }, 400],
      [{ ...input, focusedAppId: 'wt_2_app' }, 400],
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

    await fetch(url, {
      method: 'POST',
      headers: bobHeaders,
      body: JSON.stringify({
        ...input,
        worktreeId: null,
        focusedAppId: null
      })
    })
    expect(presence.snapshot().map((viewer) => viewer.identity.name)).toEqual([
      'Alice'
    ])
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
      hostname: os.hostname()
    })
  })

  it('routes persistent Browser and web-app lifecycle with scoped runtime reads', async () => {
    const { app, browserAgentCommand, service } = fixture()

    const browser = await app.request('/api/worktrees/wt_1/browser-apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/application',
        sourceTerminalId: 'term_1'
      })
    })

    expect(browser.status).toBe(201)
    expect(await browser.json()).toMatchObject({
      app: { kind: 'browser', worktreeId: 'wt_1' }
    })
    expect(service.openBrowserApp).toHaveBeenCalledWith(
      'wt_1',
      'https://example.com/application',
      'term_1',
      null
    )

    const terminalBrowser = await app.request(
      '/api/terminals/term_1/browser-apps/open',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'link-click-1'
        },
        body: JSON.stringify({ url: 'http://localhost:4173/' })
      }
    )

    expect(terminalBrowser.status).toBe(201)
    expect(service.openBrowserAppFromTerminal).toHaveBeenCalledWith(
      'term_1',
      'http://localhost:4173/',
      'link-click-1'
    )

    expect(
      (
        await app.request('/api/apps/app_browser/browser-state', {
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
        await app.request('/api/apps/app_browser/browser-popups', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://popup.example.com/' })
        })
      ).status
    ).toBe(404)

    for (const url of [
      'file://server/share/private',
      'https://user:secret@example.com/'
    ]) {
      expect(
        (
          await app.request('/api/worktrees/wt_1/browser-apps', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url })
          })
        ).status
      ).toBe(400)
    }

    expect(service.openBrowserApp).toHaveBeenCalledOnce()

    const fileUrl = 'file:///tmp/preview%20draft.html#section'

    const fileBrowser = await app.request('/api/worktrees/wt_1/browser-apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: fileUrl })
    })

    expect(fileBrowser.status).toBe(201)
    expect(service.openBrowserApp).toHaveBeenLastCalledWith(
      'wt_1',
      fileUrl,
      null,
      null
    )

    const fileNavigation = await app.request(
      '/api/apps/app_browser/browser-agent',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'goto', args: [fileUrl] })
      }
    )

    expect(fileNavigation.status).toBe(200)
    expect(browserAgentCommand).toHaveBeenLastCalledWith('app_browser', {
      command: 'goto',
      args: [fileUrl]
    })

    const snapshot = await app.request('/api/apps/app_browser/browser-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'snapshot', args: [] })
    })

    expect(snapshot.status).toBe(200)
    expect(await snapshot.json()).toEqual({ output: 'browser output' })
    expect(browserAgentCommand).toHaveBeenCalledWith('app_browser', {
      command: 'snapshot',
      args: []
    })

    browserAgentCommand.mockRejectedValueOnce(
      new Error('The Browser app is not visible.')
    )

    const failedScreenshot = await app.request(
      '/api/apps/app_browser/browser-agent',
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
        message: 'The Browser app is not visible.',
        details: {
          command: 'screenshot',
          recovery:
            'Open Browser app_browser in Treeport, then retry the screenshot.'
        }
      }
    })

    const definitions = await app.request(
      '/api/worktrees/wt_1/web-app-definitions'
    )

    expect(await definitions.json()).toMatchObject({
      definitions: [{ id: 'project:review', source: { type: 'project' } }]
    })

    const created = await app.request('/api/worktrees/wt_1/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definitionId: 'project:review',
        input: { path: 'output/demo.mp4' },
        launchCwd: 'packages/preview'
      })
    })

    expect(created.status).toBe(201)
    expect(service.createWebApp).toHaveBeenCalledWith(
      'wt_1',
      'project:review',
      {
        input: { path: 'output/demo.mp4' },
        cwd: 'packages/preview'
      }
    )

    const opened = await app.request('/api/worktrees/wt_1/apps/open', {
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
    expect(service.openWebApp).toHaveBeenCalledWith(
      'wt_1',
      'project:review',
      {
        input: { path: 'output/demo.mp4' },
        cwd: 'packages/preview'
      },
      false,
      'term_1',
      opened.headers.get('x-request-id')
    )

    expect((await app.request('/api/apps/app_review/context')).status).toBe(200)
    expect((await app.request('/api/apps/app_review/diff')).status).toBe(200)
    expect(service.getWebAppDiff).toHaveBeenCalledWith('app_review', undefined)
    expect(
      (await app.request('/api/apps/app_review/diff?scope=committed')).status
    ).toBe(200)
    expect(service.getWebAppDiff).toHaveBeenCalledWith(
      'app_review',
      'committed'
    )
    expect(
      (await app.request('/api/apps/app_review/diff?scope=invalid')).status
    ).toBe(400)

    const fileDiff = await app.request('/api/apps/app_review/diff/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'a' })
    })

    expect(fileDiff.status).toBe(200)
    expect(await fileDiff.json()).toEqual({
      path: 'a',
      status: 'ready',
      unified: 'diff --git a/a b/a',
      revision: 'revision-1',
      message: null
    })
    expect(service.getWebAppFileDiff).toHaveBeenCalledWith(
      'app_review',
      'a',
      undefined
    )
    expect(
      (
        await app.request('/api/apps/app_review/diff/file', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'a', scope: 'uncommitted' })
        })
      ).status
    ).toBe(200)
    expect(service.getWebAppFileDiff).toHaveBeenCalledWith(
      'app_review',
      'a',
      'uncommitted'
    )

    const image = await app.request('/api/apps/app_review/diff/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'image.png', commit: null })
    })

    expect(image.status).toBe(200)
    expect(await image.json()).toEqual({
      dataUrl: 'data:image/png;base64,iVBORw==',
      byteLength: 4
    })
    expect(service.getWebAppDiffImage).toHaveBeenCalledWith('app_review', {
      path: 'image.png',
      commit: null
    })

    expect(
      await (await app.request('/api/apps/app_review/files')).json()
    ).toEqual({ paths: ['src/app.ts'], truncated: false })
    expect(service.listTreeFiles).toHaveBeenCalledWith('app_review')

    const searchFiles = await app.request('/api/apps/app_review/files/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'value' })
    })

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
    expect(service.searchTreeFiles).toHaveBeenCalledWith('app_review', 'value')

    for (const query of ['', 'two\nlines']) {
      expect(
        (
          await app.request('/api/apps/app_review/files/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query })
          })
        ).status
      ).toBe(400)
    }

    expect(service.searchTreeFiles).toHaveBeenCalledOnce()

    const readFile = await app.request('/api/apps/app_review/files/read', {
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
      'app_review',
      'src/app.ts'
    )

    const writeFile = await app.request('/api/apps/app_review/files', {
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
    expect(service.writeTreeFile).toHaveBeenCalledWith('app_review', {
      path: 'src/app.ts',
      content: 'export const value = 2\n',
      expectedRevision: 'revision-1'
    })
    expect(
      (
        await app.request('/api/apps/app_review/files/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '../outside' })
        })
      ).status
    ).toBe(400)

    expect(
      await (await app.request('/api/apps/app_review/network/listeners')).json()
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
    expect(service.getAppListeners).toHaveBeenCalledWith('app_review')

    expect(
      await (await app.request('/api/apps/app_review/storage')).json()
    ).toEqual({ hasData: true })
    expect(service.hasWebAppStorage).toHaveBeenCalledWith('app_review')

    const stored = await app.request('/api/apps/app_review/storage', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'comments',
        value: [{ line: 12 }],
        scope: 'definition'
      })
    })

    expect(stored.status).toBe(200)
    expect(service.setWebAppStorage).toHaveBeenCalledWith(
      'app_review',
      'comments',
      [{ line: 12 }],
      'definition'
    )

    const restored = await app.request('/api/apps/app_review/storage/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'comments' })
    })

    expect(await restored.json()).toEqual({
      found: true,
      value: [{ file: 'src/app.ts', line: 12 }]
    })

    vi.mocked(service.getWebAppStorage)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(null)

    const missingStorage = await app.request(
      '/api/apps/app_review/storage/get',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'missing' })
      }
    )

    expect(await missingStorage.json()).toEqual({ found: false, value: null })

    const nullStorage = await app.request('/api/apps/app_review/storage/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'null-value' })
    })

    expect(await nullStorage.json()).toEqual({ found: true, value: null })

    const removedStorage = await app.request('/api/apps/app_review/storage', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'comments' })
    })

    expect(removedStorage.status).toBe(200)
    expect(service.deleteWebAppStorage).toHaveBeenCalledWith(
      'app_review',
      'comments',
      undefined
    )

    const closed = await app.request('/api/apps/app_review', {
      method: 'DELETE'
    })

    expect(closed.status).toBe(200)
    expect(service.deleteApp).toHaveBeenCalledWith('app_review', false)

    await app.request('/api/apps/app_review?discardStoredData=true', {
      method: 'DELETE'
    })
    expect(service.deleteApp).toHaveBeenLastCalledWith('app_review', true)
  })

  it('asks for confirmation only when Browser reports beforeunload', async () => {
    const { app, browserRequestAppClose, service } = fixture()
    browserRequestAppClose.mockResolvedValueOnce(false)

    const blocked = await app.request('/api/apps/browser_app', {
      method: 'DELETE'
    })

    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toEqual({
      error: {
        code: 'BROWSER_BEFORE_UNLOAD',
        message: 'Changes you made may not be saved.'
      }
    })
    expect(service.deleteApp).not.toHaveBeenCalled()

    const closed = await app.request('/api/apps/browser_app?force=true', {
      method: 'DELETE'
    })

    expect(closed.status).toBe(200)
    expect(browserRequestAppClose).toHaveBeenLastCalledWith('browser_app', true)
    expect(service.deleteApp).toHaveBeenCalledWith('browser_app', false)
  })

  it('uses the app SDK to broker scoped app requests', async () => {
    const listeners = new Map<string, EventListener>()
    const appParent = { postMessage: vi.fn() }
    vi.stubGlobal('parent', appParent)
    vi.stubGlobal('self', globalThis)
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('addEventListener', (type: string, listener: EventListener) =>
      listeners.set(type, listener)
    )

    const dispatch = <EventFixture extends object>(
      type: string,
      event: EventFixture
    ) => listeners.get(type)!(testAccess<Event>(event))

    try {
      // SAFETY: The built app SDK module exports this treeport client surface.
      const sdk = (await import('@treeport/app-sdk')) as {
        treeport: {
          version: number
          app: { setTitle: (title: string | null) => void }
          context: () => Promise<object>
          network: { listeners: () => Promise<object> }
          files: { search: (query: string) => Promise<object> }
          storage: WebAppStorage
          shortcuts: {
            onFind: (handler: () => void) => () => void
          }
        }
      }

      const context = sdk.treeport.context()
      const message = appParent.postMessage.mock.calls[0]![0]
      dispatch('message', {
        source: appParent,
        data: {
          source: 'treeport-host-v1',
          id: message.id,
          ok: true,
          value: { apiVersion: 1, app: { id: 'app_review' } }
        }
      })

      await expect(context).resolves.toMatchObject({
        apiVersion: 1,
        app: { id: 'app_review' }
      })
      expect(sdk.treeport.version).toBe(1)
      expect(appParent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'treeport-app-v1',
          method: 'context'
        }),
        '*'
      )

      const discovery = sdk.treeport.network.listeners()
      const discoveryMessage = appParent.postMessage.mock.calls[1]![0]
      expect(discoveryMessage).toMatchObject({
        source: 'treeport-app-v1',
        method: 'network.listeners'
      })
      dispatch('message', {
        source: appParent,
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
      const searchMessage = appParent.postMessage.mock.calls.at(-1)![0]
      expect(searchMessage).toMatchObject({
        source: 'treeport-app-v1',
        method: 'files.search',
        query: 'exact value'
      })
      dispatch('message', {
        source: appParent,
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

      const stored = sdk.treeport.storage.set('comments', [{ line: 12 }], {
        scope: 'definition'
      })

      const storageMessage = appParent.postMessage.mock.calls.at(-1)![0]
      expect(storageMessage).toMatchObject({
        source: 'treeport-app-v1',
        method: 'storage.set',
        scope: 'definition',
        key: 'comments',
        value: [{ line: 12 }]
      })
      dispatch('message', {
        source: appParent,
        data: {
          source: 'treeport-host-v1',
          id: storageMessage.id,
          ok: true
        }
      })
      await expect(stored).resolves.toBeUndefined()

      sdk.treeport.app.setTitle('Review route')
      expect(appParent.postMessage).toHaveBeenLastCalledWith(
        {
          source: 'treeport-app-v1',
          method: 'app.title.set',
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
        source: appParent,
        data: {
          source: 'treeport-host-v1',
          method: 'shortcut',
          shortcut: 'find'
        }
      })
      expect(findHandler).toHaveBeenCalledTimes(2)

      unsubscribeFind()
      dispatch('message', {
        source: appParent,
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
      expect(appParent.postMessage).toHaveBeenLastCalledWith(
        {
          source: 'treeport-app-v1',
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
    const appRoot = path.join(config.runtimeDir, 'typed-app')
    const indexPath = path.join(appRoot, 'index.html')
    const modulePath = path.join(appRoot, 'app.js')

    const indexSource =
      '<!doctype html><html><body><script type="module" src="app.js"></script></body></html>'

    await fs.mkdir(appRoot, { recursive: true })
    await fs.writeFile(indexPath, indexSource)
    await fs.writeFile(modulePath, 'export const answer = 42')
    vi.mocked(service.resolveWebAppAsset).mockImplementation(
      async (_appId, requestedPath) => ({
        kind: 'asset',
        path: requestedPath ? path.join(appRoot, requestedPath) : indexPath,
        immutable: true,
        development: false,
        allowNetworkRequests: false
      })
    )

    try {
      const browserOrigin = 'https://treeport.example.ts.net:5173'

      const documentResponse = await app.request(
        '/api/web-apps/app_review/assets/',
        {
          headers: {
            referer: `${browserOrigin}/projects/project_1/apps/app_review`,
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
        '/api/web-apps/app_review/assets/app.js'
      )

      expect(moduleResponse.status).toBe(200)
      expect(moduleResponse.headers.get('content-type')).toBe(
        'text/javascript; charset=utf-8'
      )
      const moduleSource = await moduleResponse.text()

      // SAFETY: The served module is compiled from a source that exports answer.
      const compiled = (await import(
        /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`
      )) as { answer: number }

      expect(compiled.answer).toBe(42)
    } finally {
      await fs.rm(config.runtimeDir, { recursive: true, force: true })
    }
  })

  it('serves nested app modules with their browser MIME type', async () => {
    const { app, config, service } = fixture()
    const modulePath = path.join(config.runtimeDir, 'nested', 'review.js')
    await fs.mkdir(path.dirname(modulePath), { recursive: true })
    await fs.writeFile(modulePath, 'export const loaded = true')
    vi.mocked(service.resolveWebAppAsset).mockResolvedValue({
      kind: 'asset',
      path: modulePath,
      immutable: true,
      development: false,
      allowNetworkRequests: true
    })

    try {
      const response = await app.request(
        '/api/web-apps/app_review/assets/nested/review.js'
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(
        'text/javascript; charset=utf-8'
      )
      expect(response.headers.get('content-security-policy')).toContain(
        'connect-src http: https:'
      )
      expect(await response.text()).toBe('export const loaded = true')
      expect(service.resolveWebAppAsset).toHaveBeenCalledWith(
        'app_review',
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

  it('forwards terminal commands and exit behavior unchanged', async () => {
    const { app, service } = fixture()

    const response = await app.request('/api/worktrees/wt_1/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Diff',
        command: 'diff main --mode split',
        cwd: '/repo/worktrees/topic',
        env: { CUSTOM: 'argument with spaces;$HOME' },
        initialSize: { cols: 132, rows: 47 }
      })
    })

    expect(response.status).toBe(201)
    expect(service.createTerminal).toHaveBeenCalledWith('wt_1', 'Diff', {
      command: 'diff main --mode split',
      initialSize: { cols: 132, rows: 47 },
      cwd: '/repo/worktrees/topic',
      env: { CUSTOM: 'argument with spaces;$HOME' }
    })

    const oneOff = await app.request('/api/worktrees/wt_1/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Open editor',
        command: 'code .',
        afterExit: 'closeOnSuccess'
      })
    })

    expect(oneOff.status).toBe(201)
    expect(service.createTerminal).toHaveBeenLastCalledWith(
      'wt_1',
      'Open editor',
      { command: 'code .', afterExit: 'closeOnSuccess' }
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
        initialTerminal: {
          name: 'Terminal',
          command: "tool 'semi;colon' $HOME",
          afterExit: 'shell',
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
        command: "tool 'semi;colon' $HOME",
        afterExit: 'shell',
        initialSize: { cols: 144, rows: 48 }
      },
      'wt_main',
      undefined,
      undefined
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
      confirmDestructive: true,
      skipCleanup: false
    })
  })

  it('uploads browser files to a private terminal-readable path', async () => {
    const { app, config, service } = fixture()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const uploadDirectory = path.join(config.runtimeDir, 'uploads')
    const stalePath = path.join(uploadDirectory, 'treeport-upload-stale.png')

    const retainedPath = path.join(
      uploadDirectory,
      'treeport-upload-retained.bin'
    )

    try {
      await fs.mkdir(uploadDirectory, { recursive: true })
      await fs.writeFile(stalePath, 'stale')
      const staleTime = new Date(Date.now() - 25 * 60 * 60_000)
      await fs.utimes(stalePath, staleTime, staleTime)
      await fs.writeFile(retainedPath, '')
      await fs.truncate(retainedPath, 600 * 1024 * 1024)

      const response = await app.request('/api/terminals/term_1/files', {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-treeport-file-extension': 'png',
          'content-length': String(60 * 1024 * 1024)
        },
        body: bytes
      })

      expect(response.status).toBe(201)
      expect(service.getTerminal).toHaveBeenCalledWith('term_1')
      // SAFETY: The upload endpoint answers 201, asserted above, with the stored file path.
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

      expect((await fs.stat(retainedPath)).size).toBe(600 * 1024 * 1024)

      const oversized = await app.request('/api/terminals/term_1/files', {
        method: 'POST',
        headers: { 'content-length': String(50 * 1024 * 1024 * 1024 + 1) },
        body: bytes
      })

      expect(oversized.status).toBe(413)
      expect(await oversized.json()).toMatchObject({
        error: { code: 'FILE_TOO_LARGE' }
      })

      const legacyHeader = await app.request('/api/terminals/term_1/files', {
        method: 'POST',
        headers: { 'x-treeport-file-extension': 'txt' },
        body: new TextEncoder().encode('legacy')
      })

      expect(legacyHeader.status).toBe(201)
      expect(
        path.extname(
          // SAFETY: The upload endpoint answers 201, asserted above, with the stored file path.
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

  it('acknowledges an exact attention sequence without refreshing projects', async () => {
    const { app, metadataAcknowledgeAttention, metadataTrack, service } =
      fixture()

    const response = await app.request(
      '/api/terminals/term/attention/acknowledge',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sequence: 4 })
      }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(service.getKnownTerminal).toHaveBeenCalledWith('term')
    expect(service.getTerminal).not.toHaveBeenCalled()
    expect(service.listProjects).not.toHaveBeenCalled()
    expect(metadataTrack).not.toHaveBeenCalled()
    expect(metadataAcknowledgeAttention).toHaveBeenCalledWith('term', 4)

    const invalid = await app.request(
      '/api/terminals/term/attention/acknowledge',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sequence: 0 })
      }
    )

    expect(invalid.status).toBe(400)
  })

  it.each([
    { code: 'TERMINAL_NOT_FOUND', status: 404 },
    { code: 'PROJECT_CLOSED', status: 409 }
  ])(
    'does not acknowledge attention when lookup fails with $code',
    async ({ code, status }) => {
      const { app, metadataAcknowledgeAttention, service } = fixture()
      service.getKnownTerminal.mockRejectedValueOnce(
        new DomainError(code, 'Terminal is unavailable', status)
      )

      const response = await app.request(
        '/api/terminals/term/attention/acknowledge',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sequence: 4 })
        }
      )

      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: { code } })
      expect(metadataAcknowledgeAttention).not.toHaveBeenCalled()
    }
  )

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
      expect(deepLink.headers.get('cache-control')).toBe('no-store')
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
