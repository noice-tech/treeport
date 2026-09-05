import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import http, { type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { NodeHttpServer } from '@effect/platform-node'
import { RpcSerialization, RpcServer } from '@effect/rpc'
import {
  browserAgentCommandSchema,
  decodeUnknownOrNull,
  TreeportRpcs
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import type {
  BrowserPanel,
  OperationRecord,
  ProjectRecord,
  TerminalRecord,
  TerminalRuntimeMetadata,
  WebPanel,
  WorktreeRecord
} from '@treeport/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runCliApplication } from './application.js'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..'
)
const packageVersion = JSON.parse(
  await readFile(
    path.join(repositoryRoot, 'apps/treeport/package.json'),
    'utf8'
  )
).version
const timestamp = '2026-01-01T00:00:00.000Z'

const terminal: TerminalRecord = {
  id: 'term_context',
  worktreeId: 'wt_context',
  name: 'Pi',
  argv: ['pi'],
  shellCommand: null,
  interactiveShell: false,
  status: 'running',
  exitCode: null,
  createdAt: timestamp,
  updatedAt: timestamp
}

const worktree: WorktreeRecord = {
  id: 'wt_context',
  projectId: 'proj_context',
  name: 'agent-tools',
  path: '/repo/worktrees/agent-tools',
  head: '1234567890abcdef',
  branch: null,
  detached: true,
  locked: false,
  lockReason: null,
  prunable: false,
  kind: 'linked',
  managedWrapperPath: null,
  pr: {
    state: 'no_pr',
    number: null,
    url: null,
    baseBranch: null,
    headBranch: null,
    mergedAt: null,
    refreshedAt: null
  },
  dirty: null,
  terminals: [terminal],
  panels: [],
  createdAt: timestamp,
  updatedAt: timestamp
}

const project: ProjectRecord = {
  id: 'proj_context',
  name: 'treeport',
  kind: 'repository',
  rootPath: '/repo/treeport',
  repositoryPath: '/repo/treeport',
  mainWorktreePath: '/repo/treeport',
  defaultBranch: 'main',
  color: null,
  availability: { state: 'available', message: null },
  worktrees: [worktree],
  createdAt: timestamp,
  updatedAt: timestamp
}

interface ObservedWebPanelBody {
  definitionId: string
  input: WebPanel['launch']['input']
  launchCwd: string
  newInstance?: boolean
  sourceTerminalId?: string | null
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

function cliEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const name of [
    'TREEPORT_API_URL',
    'TREEPORT_MANAGED_API_URL',
    'TREEPORT_DAEMON_RECORD',
    'TREEPORT_DAEMON_LIFECYCLE',
    'TREEPORT_PROJECT_ID',
    'TREEPORT_WORKTREE_ID',
    'TREEPORT_TERMINAL_ID',
    'TREEPORT_WEB_DEVELOPMENT',
    'TREEPORT_WEB_DIST'
  ]) {
    delete environment[name]
  }
  return Object.assign(environment, overrides)
}

async function runCli(
  args: string[],
  overrides: NodeJS.ProcessEnv = {},
  cwd = repositoryRoot
): Promise<CliResult> {
  let stdout = ''
  let stderr = ''
  const code = await runCliApplication({
    args,
    environment: cliEnvironment(overrides),
    cwd,
    stdout: (value) => {
      stdout += value
    },
    stderr: (value) => {
      stderr += value
    }
  })
  return { code, stdout, stderr }
}

describe('CLI executable', () => {
  it('uses the development CLI that belongs to the managed daemon', async () => {
    const developmentRoot = await mkdtemp(
      path.join(os.tmpdir(), 'treeport-cli-development-')
    )
    const daemonRecord = path.join(
      developmentRoot,
      '.treeport-dev/runtime/daemon.json'
    )
    const developmentCli = path.join(
      developmentRoot,
      '.treeport-dev-dist/node/cli/index.js'
    )
    await mkdir(path.dirname(developmentCli), { recursive: true })
    await writeFile(
      developmentCli,
      "#!/usr/bin/env node\nprocess.stdout.write('development cli\\n')\n",
      { mode: 0o700 }
    )

    const result = await execute(
      process.execPath,
      [path.join(repositoryRoot, 'apps/treeport/bin/treeport.mjs')],
      {
        env: cliEnvironment({
          TREEPORT_CLI_ENTRYPOINT: '',
          TREEPORT_DAEMON_RECORD: daemonRecord
        })
      }
    )
    expect(result.stdout).toBe('development cli\n')
    expect(result.stderr).toBe('')

    await rm(developmentRoot, { recursive: true, force: true })
  })
})

describe('CLI context and machine output', () => {
  let server: Server
  let rpcScope: Scope.CloseableScope
  let rpcListener: RequestListener
  let apiUrl: string
  const requests: string[] = []
  const creationBodies: unknown[] = []
  const terminalCreateBodies: unknown[] = []
  const webPanelBodies: Array<{
    url: string
    body: ObservedWebPanelBody
  }> = []
  const browserAgentBodies: Array<{ command: string; args: string[] }> = []
  const browserPanelBodies: Array<{
    url?: string
    sourceTerminalId?: string | null
  }> = []
  const packageBodies: Array<{
    url: string
    body: { source?: string; projectId?: string }
  }> = []
  const registeredFolderPaths: string[] = []
  const workspaceOpenBodies: Array<{ sourceTerminalId: string }> = []
  let observedTerminal = terminal
  let observedMetadata: TerminalRuntimeMetadata = {
    terminalId: terminal.id,
    title: 'Pi · /repo',
    program: 'pi',
    progress: null,
    progressStartedAt: timestamp,
    progressClearedAt: timestamp,
    bell: null
  }
  let eventScenario:
    | 'none'
    | 'working'
    | 'bell'
    | 'bell-snapshot'
    | 'exit'
    | 'slow-refresh' = 'none'
  let inspectionRequests = 0
  let observedDaemonLifecycle: 'treeport' | 'service' | 'external' = 'treeport'
  let creationOperation: OperationRecord | null = null
  let removalOperations: OperationRecord[] = []
  const removalBodies: unknown[] = []
  let createdWorktree: WorktreeRecord | null = null
  let createdWebPanels: WebPanel[] = []
  let createdBrowserPanels: BrowserPanel[] = []

  beforeEach(() => {
    observedTerminal = terminal
    observedMetadata = {
      terminalId: terminal.id,
      title: 'Pi · /repo',
      program: 'pi',
      progress: null,
      progressStartedAt: timestamp,
      progressClearedAt: timestamp,
      bell: null
    }
    eventScenario = 'none'
    inspectionRequests = 0
    observedDaemonLifecycle = 'treeport'
    creationOperation = null
    removalOperations = []
    removalBodies.length = 0
    createdWorktree = null
    createdWebPanels = []
    createdBrowserPanels = []
    webPanelBodies.length = 0
    browserPanelBodies.length = 0
    browserAgentBodies.length = 0
    registeredFolderPaths.length = 0
    workspaceOpenBodies.length = 0
  })

  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/api/rpc') {
        rpcListener(request, response)
        return
      }

      requests.push(`${request.method} ${request.url}`)
      response.setHeader('content-type', 'application/json')

      if (request.method === 'GET' && request.url === '/api/health') {
        response.end(
          JSON.stringify({
            ok: true,
            version: packageVersion,
            protocolVersion: 1,
            hostname: 'cli-test',
            pid: process.pid,
            instanceId: 'instance_context',
            installationMethod: 'development',
            daemonLifecycle: observedDaemonLifecycle,
            url: apiUrl
          })
        )
        return
      }

      if (
        request.method === 'GET' &&
        request.url?.startsWith('/api/terminals/') &&
        request.url.includes('/capture?')
      ) {
        const url = new URL(request.url, 'http://treeport.test')
        const terminalId = decodeURIComponent(
          url.pathname.slice('/api/terminals/'.length).replace(/\/capture$/, '')
        )
        if (terminalId !== observedTerminal.id) {
          response.statusCode = 404
          response.end(
            JSON.stringify({
              error: {
                code: 'TERMINAL_NOT_FOUND',
                message: 'Terminal not found'
              }
            })
          )
          return
        }

        response.end(
          JSON.stringify({
            terminalId,
            capturedAt: timestamp,
            lineLimit: Number(url.searchParams.get('lines')),
            content: 'Preparing changes\nRunning tests'
          })
        )
        return
      }

      if (
        request.method === 'GET' &&
        request.url?.startsWith('/api/terminals/')
      ) {
        const terminalId = decodeURIComponent(
          request.url.slice('/api/terminals/'.length)
        )
        if (terminalId !== observedTerminal.id) {
          response.statusCode = 404
          response.end(
            JSON.stringify({
              error: {
                code: 'TERMINAL_NOT_FOUND',
                message: 'Terminal not found'
              }
            })
          )
          return
        }

        inspectionRequests += 1
        if (eventScenario === 'slow-refresh' && inspectionRequests > 1) {
          return
        }

        response.end(
          JSON.stringify({
            terminal: observedTerminal,
            metadata: observedMetadata
          })
        )
        return
      }

      if (request.method === 'GET' && request.url === '/api/projects') {
        response.end(
          JSON.stringify({
            projects: [
              {
                ...project,
                worktrees: [
                  {
                    ...worktree,
                    panels: [
                      ...worktree.panels,
                      ...createdWebPanels,
                      ...createdBrowserPanels
                    ]
                  }
                ]
              }
            ]
          })
        )
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/api/projects/proj_context'
      ) {
        response.end(
          JSON.stringify({
            project: createdWorktree
              ? { ...project, worktrees: [createdWorktree] }
              : project
          })
        )
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/api/worktrees/wt_context/context'
      ) {
        response.end(
          JSON.stringify({
            context: {
              issue: 'TREE-123',
              brief: 'Review the cache behavior.\nKeep the terminal workflow.',
              control: '\u001b]2;changed\u0007'
            }
          })
        )
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/api/projects/proj_domain'
      ) {
        response.statusCode = 409
        response.end(
          JSON.stringify({
            error: {
              code: 'PROJECT_BUSY',
              message: 'Project is already being modified',
              details: { projectId: 'proj_domain' }
            }
          })
        )
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/api/projects/proj_auth'
      ) {
        response.statusCode = 401
        response.end(
          JSON.stringify({
            error: {
              code: 'AUTHENTICATION_REQUIRED',
              message:
                'Treeport accepts remote requests only through Tailscale Serve.'
            }
          })
        )
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/api/projects/proj_invalid'
      ) {
        response.end(JSON.stringify({ project: { id: 'proj_invalid' } }))
        return
      }

      if (request.method === 'POST' && request.url === '/api/projects') {
        let source = ''
        for await (const chunk of request) {
          source += chunk
        }
        // SAFETY: The test fixture provides the asserted contract used here.
        const body = JSON.parse(source) as { path: string }
        registeredFolderPaths.push(body.path)
        response.statusCode = 201
        response.end(
          JSON.stringify({
            project: {
              ...project,
              id: 'proj_opened',
              kind: 'folder',
              rootPath: body.path,
              repositoryPath: body.path,
              mainWorktreePath: body.path,
              defaultBranch: '',
              worktrees: [
                {
                  ...worktree,
                  id: 'wt_opened',
                  projectId: 'proj_opened',
                  path: body.path,
                  kind: 'folder'
                }
              ]
            }
          })
        )
        return
      }

      if (
        request.method === 'POST' &&
        request.url === '/api/worktrees/wt_opened/open'
      ) {
        let source = ''
        for await (const chunk of request) {
          source += chunk
        }
        // SAFETY: The test fixture provides the asserted contract used here.
        workspaceOpenBodies.push(
          JSON.parse(source) as { sourceTerminalId: string }
        )
        response.end(JSON.stringify({ ok: true }))
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/api/worktrees/wt_context/web-panel-definitions'
      ) {
        response.end(
          JSON.stringify({
            definitions: [
              {
                id: 'project:preview',
                title: 'Preview',
                icon: null,
                source: { type: 'project' },
                permissions: [],
                permissionsGranted: true,
                sandbox: { allowSameOrigin: false }
              },
              {
                id: 'package:one:review',
                title: 'Review one',
                icon: null,
                source: {
                  type: 'package',
                  packageId: 'one',
                  source: 'npm:@acme/one',
                  scope: 'global'
                },
                permissions: [],
                permissionsGranted: true,
                sandbox: { allowSameOrigin: false }
              },
              {
                id: 'package:two:review',
                title: 'Review two',
                icon: null,
                source: {
                  type: 'package',
                  packageId: 'two',
                  source: 'npm:@acme/two',
                  scope: 'global'
                },
                permissions: [],
                permissionsGranted: true,
                sandbox: { allowSameOrigin: false }
              }
            ]
          })
        )
        return
      }

      if (
        request.method === 'POST' &&
        request.url === '/api/worktrees/wt_context/browser-panels'
      ) {
        let source = ''
        for await (const chunk of request) {
          source += chunk
        }
        // SAFETY: The test server records the validated Browser request contract.
        const body = JSON.parse(source) as {
          url?: string
          sourceTerminalId?: string | null
        }
        browserPanelBodies.push(body)
        const url = body.url ? new URL(body.url).href : 'about:blank'
        const panel: BrowserPanel = {
          id: `panel_${createdWebPanels.length + createdBrowserPanels.length + 1}`,
          kind: 'browser',
          worktreeId: worktree.id,
          title: url === 'about:blank' ? 'Browser' : new URL(url).host,
          url,
          createdAt: timestamp,
          updatedAt: timestamp
        }
        createdBrowserPanels.push(panel)
        response.statusCode = 201
        response.end(JSON.stringify({ panel }))
        return
      }

      if (
        request.method === 'POST' &&
        /^\/api\/panels\/panel_[^/]+\/browser-agent$/.test(request.url ?? '')
      ) {
        let source = ''
        for await (const chunk of request) {
          source += chunk
        }
        const body = decodeUnknownOrNull(
          browserAgentCommandSchema,
          JSON.parse(source)
        )
        if (!body) {
          throw new Error('Invalid Browser agent command')
        }

        browserAgentBodies.push({ command: body.command, args: [...body.args] })
        response.end(
          JSON.stringify({
            output: '### Snapshot\n- button "Run checks" [ref=e2]'
          })
        )
        return
      }

      if (
        request.method === 'POST' &&
        (request.url === '/api/worktrees/wt_context/panels' ||
          request.url === '/api/worktrees/wt_context/panels/open')
      ) {
        let source = ''
        for await (const chunk of request) {
          source += chunk
        }
        // SAFETY: The test fixture provides the asserted contract used here.
        const body = JSON.parse(source) as ObservedWebPanelBody
        webPanelBodies.push({ url: request.url, body })
        const open = request.url.endsWith('/open')
        const previous = [...createdWebPanels]
          .reverse()
          .find((panel) => panel.definitionId === body.definitionId)
        const reuse =
          open && body.newInstance !== true && previous !== undefined
        const panel: WebPanel = reuse
          ? {
              ...previous!,
              launch: {
                // SAFETY: The test fixture provides the asserted contract used here.
                input: body.input as WebPanel['launch']['input'],
                cwd: String(body.launchCwd)
              },
              updatedAt: '2026-01-01T00:00:01.000Z'
            }
          : {
              id: `panel_${createdWebPanels.length + 1}`,
              kind: 'web',
              worktreeId: worktree.id,
              definitionId: String(body.definitionId),
              title: 'Preview',
              launch: {
                // SAFETY: The test fixture provides the asserted contract used here.
                input: body.input as WebPanel['launch']['input'],
                cwd: String(body.launchCwd)
              },
              permissions: [],
              sandbox: { allowSameOrigin: false },
              createdAt: timestamp,
              updatedAt: timestamp
            }
        if (reuse) {
          createdWebPanels[createdWebPanels.indexOf(previous!)] = panel
        } else {
          createdWebPanels.push(panel)
        }

        response.statusCode = open ? 200 : 201
        response.end(
          JSON.stringify(
            open ? { panel, created: !reuse, reused: reuse } : { panel }
          )
        )
        return
      }

      if (
        request.method === 'DELETE' &&
        request.url?.startsWith('/api/panels/')
      ) {
        const panelId = decodeURIComponent(
          request.url.slice('/api/panels/'.length).split('?')[0]!
        )
        createdWebPanels = createdWebPanels.filter(
          (panel) => panel.id !== panelId
        )
        createdBrowserPanels = createdBrowserPanels.filter(
          (panel) => panel.id !== panelId
        )
        response.end(JSON.stringify({ ok: true }))
        return
      }

      if (
        request.method === 'POST' &&
        request.url === '/api/worktrees/wt_context/terminals'
      ) {
        let source = ''
        for await (const chunk of request) {
          source += chunk
        }
        terminalCreateBodies.push(JSON.parse(source))
        response.statusCode = 201
        response.end(JSON.stringify({ terminal }))
        return
      }

      if (
        request.method === 'GET' &&
        request.url?.startsWith('/api/packages/project?')
      ) {
        response.end(JSON.stringify({ project }))
        return
      }

      if (request.method === 'GET' && request.url === '/api/packages') {
        response.end(
          JSON.stringify({
            packages: [
              {
                source: 'npm:@acme/tools',
                identity: 'npm:@acme/tools',
                scope: 'global',
                projectId: null,
                projectName: null,
                installedPath: '/data/npm/node_modules/@acme/tools',
                resources: {
                  webPanels: 1,
                  terminalPresets: 1
                },
                diagnostics: []
              }
            ],
            diagnostics: []
          })
        )
        return
      }

      if (
        request.method === 'POST' &&
        request.url?.startsWith('/api/packages/')
      ) {
        let source = ''
        for await (const chunk of request) {
          source += chunk
        }
        // SAFETY: The test fixture provides the asserted contract used here.
        const body = JSON.parse(source) as {
          source?: string
          projectId?: string
        }
        packageBodies.push({ url: request.url, body })
        const action = request.url.slice('/api/packages/'.length)
        if (action === 'reload') {
          response.end(
            JSON.stringify({
              results: [
                {
                  action: 'reload',
                  source: null,
                  scope: body.projectId ? 'project' : 'global',
                  projectId: body.projectId ?? null,
                  status: 'reloaded'
                }
              ],
              diagnostics: []
            })
          )
          return
        }

        if (action === 'update') {
          response.end(
            JSON.stringify({
              results: [
                {
                  action: 'update',
                  source: body.source ?? 'npm:@acme/tools',
                  scope: 'global',
                  projectId: null,
                  status: 'updated'
                }
              ]
            })
          )
          return
        }

        response.end(
          JSON.stringify({
            result: {
              action: action === 'install' ? 'install' : 'remove',
              source: body.source,
              scope: body.projectId ? 'project' : 'global',
              projectId: body.projectId ?? null,
              status: action === 'install' ? 'installed' : 'removed'
            }
          })
        )
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/api/worktrees/wt_context/remove-preview'
      ) {
        const accepted = removalOperations[0]
        const preview =
          accepted?.kind === 'remove' ? accepted.request.preview : null
        response.end(JSON.stringify({ preview }))
        return
      }

      if (
        request.method === 'POST' &&
        request.url === '/api/worktrees/wt_context/remove'
      ) {
        let source = ''
        for await (const chunk of request) {
          source += chunk
        }
        removalBodies.push(JSON.parse(source))
        response.statusCode = 202
        response.end(JSON.stringify({ operation: removalOperations.shift() }))
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/api/operations/op_remove'
      ) {
        response.end(JSON.stringify({ operation: removalOperations.shift() }))
        return
      }

      if (
        request.method === 'POST' &&
        request.url === '/api/projects/proj_context/worktree-operations'
      ) {
        let source = ''
        for await (const chunk of request) {
          source += chunk
        }
        // SAFETY: The test fixture provides the asserted contract used here.
        const body = JSON.parse(source) as {
          name: string
          base: 'default' | 'current'
          initialTerminal?: { name: string; argv?: string[] }
        }
        creationBodies.push(body)
        const partial = body.name === 'partial'
        createdWorktree = {
          ...worktree,
          name: body.name,
          terminals: partial ? [] : [terminal]
        }
        creationOperation = {
          id: 'op_create',
          kind: 'create',
          projectId: project.id,
          worktreeId: worktree.id,
          status: 'completed',
          request: body,
          result: {
            worktreeId: worktree.id,
            terminalId: partial ? null : terminal.id,
            terminalError: partial ? 'terminal host failed' : null,
            setupError: partial ? 'setup could not be prepared' : null
          },
          error: null,
          createdAt: timestamp,
          updatedAt: timestamp
        }
        response.statusCode = 202
        response.end(
          JSON.stringify({
            operation: { ...creationOperation, status: 'pending' }
          })
        )
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/api/operations/op_create' &&
        creationOperation
      ) {
        response.end(JSON.stringify({ operation: creationOperation }))
        return
      }

      response.statusCode = 404
      response.end(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } })
      )
    })
    const handlers = TreeportRpcs.toLayer(
      Effect.succeed({
        WatchProjectEvents: () =>
          Stream.unwrap(
            Effect.sync(() => {
              if (eventScenario === 'bell-snapshot') {
                observedMetadata = {
                  ...observedMetadata,
                  bell: {
                    sequence: 1,
                    at: '2026-01-01T00:02:00.000Z',
                    unread: true
                  }
                }
              }

              const snapshot = Stream.succeed({
                _tag: 'Snapshot' as const,
                snapshot: {
                  at: timestamp,
                  terminalMetadata: [observedMetadata],
                  webPanels: [],
                  browserPanels: [],
                  presence: []
                }
              })
              if (
                eventScenario === 'none' ||
                eventScenario === 'slow-refresh' ||
                eventScenario === 'bell-snapshot'
              ) {
                return Stream.concat(snapshot, Stream.never)
              }

              const event = Effect.sleep(10).pipe(
                Effect.map(() => {
                  if (eventScenario === 'working') {
                    observedMetadata = {
                      ...observedMetadata,
                      progress: { state: 'indeterminate', value: null },
                      progressStartedAt: '2026-01-01T00:01:00.000Z'
                    }
                    return {
                      _tag: 'ProductEvent' as const,
                      event: {
                        id: 'event-1',
                        type: 'terminal.metadata' as const,
                        at: '2026-01-01T00:03:00.000Z',
                        data: { ...observedMetadata, worktreeId: null }
                      }
                    }
                  }

                  if (eventScenario === 'bell') {
                    observedMetadata = {
                      ...observedMetadata,
                      bell: {
                        sequence: (observedMetadata.bell?.sequence ?? 0) + 1,
                        at: '2026-01-01T00:02:00.000Z',
                        unread: true
                      }
                    }
                    return {
                      _tag: 'ProductEvent' as const,
                      event: {
                        id: 'event-1',
                        type: 'terminal.metadata' as const,
                        at: '2026-01-01T00:03:00.000Z',
                        data: { ...observedMetadata, worktreeId: null }
                      }
                    }
                  }

                  observedTerminal = {
                    ...observedTerminal,
                    status: 'exited',
                    exitCode: 7
                  }
                  return {
                    _tag: 'ProductEvent' as const,
                    event: {
                      id: 'event-1',
                      type: 'terminal.updated' as const,
                      at: '2026-01-01T00:03:00.000Z',
                      data: {
                        terminalId: observedTerminal.id,
                        worktreeId: observedTerminal.worktreeId
                      }
                    }
                  }
                })
              )
              return Stream.concat(
                snapshot,
                Stream.concat(Stream.fromEffect(event), Stream.never)
              )
            })
          )
      })
    )
    rpcScope = await Effect.runPromise(Scope.make())
    const rpcApp = await Effect.runPromise(
      Scope.extend(
        RpcServer.toHttpApp(TreeportRpcs).pipe(
          Effect.provide(handlers),
          Effect.provide(RpcSerialization.layerNdjson)
        ),
        rpcScope
      )
    )
    rpcListener = await Effect.runPromise(NodeHttpServer.makeHandler(rpcApp))
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    // SAFETY: The test fixture provides the asserted contract used here.
    const address = server.address() as AddressInfo
    apiUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await Effect.runPromise(Scope.close(rpcScope, Exit.void))
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })

  it('prints context in concise human and compact JSON forms', async () => {
    const result = await runCli(['context'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Treeport context')
    expect(result.stdout).toContain('Project:  treeport (proj_context)')
    expect(result.stdout).toContain('Tree:     agent-tools (wt_context)')
    expect(result.stdout).toContain('  issue: TREE-123')
    expect(result.stdout).toContain(
      '  brief: Review the cache behavior.\n    Keep the terminal workflow.'
    )
    expect(result.stdout).toContain('  control: \\u001b]2;changed\\u0007')
    expect(result.stdout).not.toContain('\u001b')
    expect(result.stdout).toContain('Terminal: Pi (term_context) — running')
    expect(result.stdout).toContain('Lifecycle: managed by Treeport')
    expect(result.stdout.trimStart().startsWith('{')).toBe(false)

    const structured = await runCli(['context', '--json'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })
    expect(structured.code).toBe(0)
    expect(structured.stderr).toBe('')
    expect(structured.stdout).not.toContain('\n  ')
    expect(JSON.parse(structured.stdout)).toMatchObject({
      managed: true,
      apiUrl,
      daemonLifecycle: 'treeport',
      project: { id: project.id, name: 'treeport' },
      worktree: {
        id: worktree.id,
        name: 'agent-tools',
        context: {
          issue: 'TREE-123',
          brief: 'Review the cache behavior.\nKeep the terminal workflow.',
          control: '\u001b]2;changed\u0007'
        }
      },
      terminal: { id: terminal.id, name: 'Pi', status: 'running' }
    })

    observedDaemonLifecycle = 'external'
    const external = await runCli(['context'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })
    expect(external.code).toBe(0)
    expect(external.stdout).toContain('Lifecycle: externally managed')

    observedDaemonLifecycle = 'service'
    const supervised = await runCli(['context'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })
    expect(supervised.code).toBe(0)
    expect(supervised.stdout).toContain('Lifecycle: managed by the OS service')
    observedDaemonLifecycle = 'treeport'

    const runtimeDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'treeport-managed-cli-')
    )
    const daemonRecordPath = path.join(runtimeDirectory, 'daemon.json')
    await writeFile(
      daemonRecordPath,
      JSON.stringify({
        pid: process.pid,
        instanceId: 'current-instance',
        version: 'development',
        apiUrl,
        dataDir: runtimeDirectory,
        startedAt: timestamp,
        installationMethod: 'development',
        daemonLifecycle: 'treeport'
      })
    )
    const staleApiUrl = 'http://127.0.0.1:1'
    const recovered = await runCli(['context'], {
      TREEPORT_API_URL: staleApiUrl,
      TREEPORT_MANAGED_API_URL: staleApiUrl,
      TREEPORT_DAEMON_RECORD: daemonRecordPath,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })
    expect(recovered.code).toBe(0)
    expect(recovered.stderr).toBe('')
    expect(recovered.stdout).toContain(`API:      ${apiUrl}`)

    await writeFile(
      daemonRecordPath,
      JSON.stringify({
        pid: process.pid,
        instanceId: 'stale-instance',
        version: 'development',
        apiUrl: staleApiUrl,
        dataDir: runtimeDirectory,
        startedAt: timestamp,
        installationMethod: 'development',
        daemonLifecycle: 'treeport'
      })
    )
    const overridden = await runCli(['context'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_MANAGED_API_URL: staleApiUrl,
      TREEPORT_DAEMON_RECORD: daemonRecordPath,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })
    expect(overridden.code).toBe(0)
    expect(overridden.stderr).toBe('')
    expect(overridden.stdout).toContain(`API:      ${apiUrl}`)
    await rm(runtimeDirectory, { recursive: true, force: true })
  })

  it('opens a folder in the client that contains the managed terminal', async () => {
    observedDaemonLifecycle = 'external'
    const result = await runCli(['.', '--json'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_DAEMON_LIFECYCLE: 'external',
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })
    observedDaemonLifecycle = 'treeport'

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      projectId: 'proj_opened',
      worktreeId: 'wt_opened',
      path: await realpath(repositoryRoot),
      projectKind: 'folder',
      client: 'current'
    })
    expect(registeredFolderPaths).toEqual([await realpath(repositoryRoot)])
    expect(workspaceOpenBodies).toEqual([{ sourceTerminalId: terminal.id }])
  })

  it('detects an unmanaged terminal without contacting the daemon', async () => {
    const requestCount = requests.length
    const result = await runCli(['context', '--json'], {
      TREEPORT_API_URL: apiUrl
    })

    expect(result).toEqual({
      code: 0,
      stdout: '{"managed":false,"reason":"outside_treeport"}\n',
      stderr: ''
    })
    expect(requests).toHaveLength(requestCount)
  })

  it('refuses incomplete and inconsistent injected context', async () => {
    const requestCount = requests.length
    const incomplete = await runCli(['context', '--json'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: project.id
    })
    expect(incomplete.code).toBe(5)
    expect(incomplete.stdout).toBe('')
    expect(JSON.parse(incomplete.stderr)).toEqual({
      error: {
        code: 'TREEPORT_CONTEXT_INCOMPLETE',
        message:
          'Incomplete Treeport context; missing TREEPORT_WORKTREE_ID, TREEPORT_TERMINAL_ID',
        details: {
          missing: ['TREEPORT_WORKTREE_ID', 'TREEPORT_TERMINAL_ID']
        }
      }
    })
    expect(requests).toHaveLength(requestCount)

    const inconsistent = await runCli(['context', '--json'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: 'wt_other',
      TREEPORT_TERMINAL_ID: terminal.id
    })
    expect(inconsistent.code).toBe(5)
    expect(JSON.parse(inconsistent.stderr)).toMatchObject({
      error: { code: 'TREEPORT_CONTEXT_INVALID' }
    })
  })

  it('preserves API domain errors in JSON mode', async () => {
    const result = await runCli(['context', '--json'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: 'proj_domain',
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })

    expect(result.code).toBe(5)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'PROJECT_BUSY',
        message: 'Project is already being modified',
        details: { projectId: 'proj_domain' }
      }
    })
  })

  it('reports an authentication refusal without treating the daemon as unreachable', async () => {
    const result = await runCli(['context', '--json'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: 'proj_auth',
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })

    expect(result.code).toBe(5)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message:
          'Treeport accepts remote requests only through Tailscale Serve.'
      }
    })
  })

  it('rejects malformed successful API responses before using them', async () => {
    const result = await runCli(['context', '--json'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: 'proj_invalid',
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })

    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'DAEMON_PROTOCOL_ERROR',
        message:
          'Treeport daemon returned an invalid response for /api/projects/proj_invalid',
        details: { pathname: '/api/projects/proj_invalid' }
      }
    })
  })

  it('reports an unreachable daemon as a structured exit 3 failure', async () => {
    const unavailable = http.createServer()
    await new Promise<void>((resolve) => {
      unavailable.listen(0, '127.0.0.1', resolve)
    })
    // SAFETY: The test fixture provides the asserted contract used here.
    const address = unavailable.address() as AddressInfo
    await new Promise<void>((resolve, reject) => {
      unavailable.close((error) => (error ? reject(error) : resolve()))
    })

    const result = await runCli(['context', '--json'], {
      TREEPORT_API_URL: `http://127.0.0.1:${address.port}`,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })

    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'DAEMON_UNREACHABLE' }
    })
  })

  it('detects the current project and keeps command arguments structured', async () => {
    const created = await runCli(
      [
        'terminal',
        'create',
        '--worktree',
        worktree.id,
        '--name',
        'Agent',
        '--json',
        '--',
        'pi',
        '--json',
        'semi;colon'
      ],
      { TREEPORT_API_URL: apiUrl }
    )
    expect(created.code).toBe(0)
    expect(JSON.parse(created.stdout)).toMatchObject({ id: terminal.id })
    expect(terminalCreateBodies.at(-1)).toEqual({
      name: 'Agent',
      argv: ['pi', '--json', 'semi;colon']
    })

    const createdWorktreeResult = await runCli(
      ['worktree', 'create', '--name', 'from-folder', '--json'],
      { TREEPORT_API_URL: apiUrl },
      path.join(worktree.path, 'packages', 'client')
    )
    expect(createdWorktreeResult.code).toBe(0)
    expect(JSON.parse(createdWorktreeResult.stdout)).toMatchObject({
      worktree: { id: worktree.id, name: 'from-folder' }
    })
    expect(creationBodies.at(-1)).toEqual({
      name: 'from-folder',
      base: 'default'
    })

    const result = await runCli(
      [
        'spawn',
        '--worktree-name',
        'partial',
        '--name',
        'Agent',
        '--json',
        '--',
        'pi',
        'semi;colon',
        '$HOME'
      ],
      { TREEPORT_API_URL: apiUrl },
      path.join(worktree.path, 'packages', 'client')
    )

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      worktree: { id: worktree.id, name: 'partial' },
      terminal: null,
      terminalError: 'terminal host failed',
      setupError: 'setup could not be prepared'
    })
    expect(creationBodies.at(-1)).toMatchObject({
      name: 'partial',
      initialTerminal: {
        name: 'Agent',
        argv: ['pi', 'semi;colon', '$HOME']
      }
    })
  })

  it('prints cleanup output in order and keeps JSON removal output structured', async () => {
    const cleanupCommands = [
      {
        name: 'Drop database',
        status: 'completed' as const,
        stdout: 'database removed\n',
        stderr: '',
        exitCode: 0,
        error: null,
        outputTruncated: false
      },
      {
        name: 'Remove cache',
        status: 'completed' as const,
        stdout: '',
        stderr: 'cache removed\n',
        exitCode: 0,
        error: null,
        outputTruncated: false
      }
    ]
    const preview = {
      worktreeId: worktree.id,
      name: worktree.name,
      path: worktree.path,
      head: worktree.head,
      branch: worktree.branch,
      detached: worktree.detached,
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
      detachedHeadReachable: true,
      forceRequired: false,
      eligible: true,
      reasons: [],
      warnings: [],
      cleanup: {
        commands: cleanupCommands.map((command) => command.name),
        available: true,
        unavailableReason: null
      },
      terminals: [],
      confirmationToken: 'token'
    }
    const request = {
      confirmation: null,
      confirmationToken: 'token',
      confirmDestructive: false,
      skipCleanup: false,
      preview,
      checkoutIdentity: null,
      prunable: false,
      gitWorktreeKey: 'worktrees/agent-tools',
      repositoryIdentity: 'repository',
      phase: 'accepted' as const,
      managedWrapperPath: null,
      cleanupCommands: {
        status: 'pending' as const,
        definitionHash: 'definition',
        skippedReason: null,
        commands: cleanupCommands.map((command) => ({
          ...command,
          status: 'pending' as const,
          stdout: '',
          stderr: '',
          exitCode: null
        }))
      }
    }
    const pending: OperationRecord = {
      id: 'op_remove',
      kind: 'remove',
      projectId: project.id,
      worktreeId: worktree.id,
      status: 'pending',
      request,
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const completed: OperationRecord = {
      ...pending,
      status: 'completed',
      request: {
        ...request,
        phase: 'cleanup_pending',
        cleanupCommands: {
          ...request.cleanupCommands,
          status: 'completed',
          commands: cleanupCommands
        }
      },
      result: {
        removed: true,
        worktreeId: worktree.id,
        name: worktree.name,
        branchPreserved: worktree.branch,
        path: worktree.path,
        recovered: false,
        cleanup: {
          status: 'completed',
          residualPath: null,
          warning: null,
          commands: cleanupCommands
        }
      }
    }
    removalOperations = [pending, completed]
    const human = await runCli(['worktree', 'remove', worktree.id], {
      TREEPORT_API_URL: apiUrl
    })
    expect(human.code).toBe(0)
    expect(human.stdout).toContain(
      'Cleanup: Drop database\ndatabase removed\nCleanup: Remove cache\ncache removed'
    )
    expect(human.stdout).toContain(`Removed tree ${worktree.name}`)
    expect(removalBodies.at(-1)).toMatchObject({ skipCleanup: false })

    removalOperations = [pending, completed]
    const json = await runCli(['worktree', 'remove', worktree.id, '--json'], {
      TREEPORT_API_URL: apiUrl
    })
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout)).toMatchObject({
      removed: true,
      cleanup: {
        commands: [
          { name: 'Drop database', stdout: 'database removed\n' },
          { name: 'Remove cache', stderr: 'cache removed\n' }
        ]
      }
    })

    removalOperations = [pending]
    const unconfirmedSkip = await runCli(
      ['worktree', 'remove', worktree.id, '--skip-cleanup'],
      { TREEPORT_API_URL: apiUrl }
    )
    expect(unconfirmedSkip.code).toBe(5)
    expect(unconfirmedSkip.stderr).toContain(
      'Re-run with --force --skip-cleanup to confirm removal.'
    )

    removalOperations = [pending, completed]
    const confirmedSkip = await runCli(
      ['worktree', 'remove', worktree.id, '--force', '--skip-cleanup'],
      { TREEPORT_API_URL: apiUrl }
    )
    expect(confirmedSkip.code).toBe(0)
    expect(removalBodies.at(-1)).toMatchObject({
      confirmDestructive: true,
      skipCleanup: true
    })
  })

  it('reports cleanup failure and states that Git kept the tree', async () => {
    const failedCommand = {
      name: 'Drop database',
      status: 'failed' as const,
      stdout: 'attempted cleanup\n',
      stderr: 'database is busy\n',
      exitCode: 12,
      error: 'database is busy',
      outputTruncated: false
    }
    const preview = {
      worktreeId: worktree.id,
      name: worktree.name,
      path: worktree.path,
      head: worktree.head,
      branch: worktree.branch,
      detached: worktree.detached,
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
      detachedHeadReachable: true,
      forceRequired: false,
      eligible: true,
      reasons: [],
      warnings: [],
      cleanup: {
        commands: [failedCommand.name],
        available: true,
        unavailableReason: null
      },
      terminals: [],
      confirmationToken: 'token'
    }
    const request = {
      confirmation: null,
      confirmationToken: 'token',
      confirmDestructive: false,
      skipCleanup: false,
      preview,
      checkoutIdentity: null,
      prunable: false,
      gitWorktreeKey: 'worktrees/agent-tools',
      repositoryIdentity: 'repository',
      phase: 'terminals_stopped' as const,
      managedWrapperPath: null,
      cleanupCommands: {
        status: 'failed' as const,
        definitionHash: 'definition',
        skippedReason: null,
        commands: [failedCommand]
      }
    }
    const pending: OperationRecord = {
      id: 'op_remove',
      kind: 'remove',
      projectId: project.id,
      worktreeId: worktree.id,
      status: 'pending',
      request,
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    removalOperations = [
      pending,
      {
        ...pending,
        status: 'failed',
        error:
          'Project cleanup command “Drop database” failed. Git kept the tree.'
      }
    ]

    const result = await runCli(['worktree', 'remove', worktree.id], {
      TREEPORT_API_URL: apiUrl
    })
    expect(result.code).toBe(5)
    expect(result.stdout).toContain('Cleanup: Drop database (failed)')
    expect(result.stdout).toContain('database is busy')
    expect(result.stderr).toContain('Git kept the tree')
  })

  it('opens and reuses web panels with JSON input', async () => {
    const environment = {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    }
    const cwd = '/repo/worktrees/agent-tools/packages/client'

    const opened = await runCli(
      [
        'web-panel',
        'open',
        'preview',
        '--worktree',
        '.',
        '--input',
        '{"path":"output/demo.json","mode":"inspect"}',
        '--json'
      ],
      environment,
      cwd
    )
    expect(opened.code, opened.stderr).toBe(0)
    expect(JSON.parse(opened.stdout)).toMatchObject({
      panel: { id: 'panel_1', definitionId: 'project:preview' },
      created: true,
      reused: false
    })
    expect(webPanelBodies.at(-1)).toEqual({
      url: '/api/worktrees/wt_context/panels/open',
      body: {
        definitionId: 'project:preview',
        input: { path: 'output/demo.json', mode: 'inspect' },
        launchCwd: 'packages/client',
        newInstance: false,
        sourceTerminalId: terminal.id
      }
    })

    const reused = await runCli(
      [
        'web-panel',
        'open',
        'preview',
        '--worktree',
        '.',
        '--input',
        '{"path":"output/updated.json"}',
        '--json'
      ],
      environment,
      cwd
    )
    expect(reused.code).toBe(0)
    expect(JSON.parse(reused.stdout)).toMatchObject({
      panel: { id: 'panel_1' },
      created: false,
      reused: true
    })

    const separate = await runCli(
      [
        'web-panel',
        'open',
        'project:preview',
        '--worktree',
        '.',
        '--new',
        '--json'
      ],
      environment,
      cwd
    )
    expect(separate.code).toBe(0)
    expect(JSON.parse(separate.stdout)).toMatchObject({
      panel: { id: 'panel_2' },
      created: true,
      reused: false
    })

    const browser = await runCli(
      ['browser', 'open', 'http://127.0.0.1:5173', '--worktree', '.', '--json'],
      environment,
      cwd
    )
    expect(browser.code).toBe(0)
    expect(JSON.parse(browser.stdout)).toMatchObject({
      panel: {
        id: 'panel_3',
        kind: 'browser',
        title: '127.0.0.1:5173',
        url: 'http://127.0.0.1:5173/'
      }
    })
    expect(browserPanelBodies).toEqual([
      {
        url: 'http://127.0.0.1:5173',
        sourceTerminalId: terminal.id
      }
    ])

    const browserList = await runCli(
      ['browser', 'list', '--json'],
      environment,
      cwd
    )
    expect(browserList.code).toBe(0)
    expect(JSON.parse(browserList.stdout)).toEqual([
      expect.objectContaining({ panelId: 'panel_3', worktreeId: worktree.id })
    ])
    const snapshot = await runCli(
      ['browser', 'snapshot', '--json'],
      environment,
      cwd
    )
    expect(snapshot.code).toBe(0)
    expect(JSON.parse(snapshot.stdout)).toEqual({
      panelId: 'panel_3',
      output: '### Snapshot\n- button "Run checks" [ref=e2]'
    })
    expect(browserAgentBodies).toEqual([{ command: 'snapshot', args: [] }])

    const invalid = await runCli(
      [
        'web-panel',
        'open',
        'preview',
        '--worktree',
        '.',
        '--input',
        'not-json',
        '--json'
      ],
      environment,
      cwd
    )
    expect(invalid.code).toBe(2)
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      error: { code: 'USAGE_ERROR' }
    })

    const ambiguous = await runCli(
      ['web-panel', 'open', 'review', '--worktree', '.', '--json'],
      environment,
      cwd
    )
    expect(ambiguous.code).toBe(5)
    expect(JSON.parse(ambiguous.stderr)).toMatchObject({
      error: {
        code: 'WEB_PANEL_DEFINITION_AMBIGUOUS',
        details: {
          definitionIds: ['package:one:review', 'package:two:review']
        }
      }
    })
  })

  it('inspects terminals by exact ID and managed dot context', async () => {
    const human = await runCli(['terminal', 'inspect', terminal.id], {
      TREEPORT_API_URL: apiUrl
    })
    expect(human.code).toBe(0)
    expect(human.stderr).toBe('')
    expect(human.stdout).toContain('Terminal: Pi (term_context)')
    expect(human.stdout).toContain('Progress: idle')
    expect(human.stdout).toContain('Title:    Pi · /repo')

    const json = await runCli(['terminal', 'inspect', '.', '--json'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_TERMINAL_ID: terminal.id
    })
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout)).toEqual({
      terminal,
      metadata: observedMetadata
    })
  })

  it('captures terminal output by exact ID and managed dot context', async () => {
    const human = await runCli(
      ['terminal', 'capture', terminal.id, '--lines', '12'],
      { TREEPORT_API_URL: apiUrl }
    )
    expect(human).toEqual({
      code: 0,
      stdout: 'Preparing changes\nRunning tests\n',
      stderr: ''
    })
    expect(requests.at(-1)).toBe(
      'GET /api/terminals/term_context/capture?lines=12'
    )

    const json = await runCli(['terminal', 'capture', '.', '--json'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_TERMINAL_ID: terminal.id
    })
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout)).toEqual({
      terminalId: terminal.id,
      capturedAt: timestamp,
      lineLimit: 200,
      content: 'Preparing changes\nRunning tests'
    })

    const requestCount = requests.length
    const invalid = await runCli(
      ['terminal', 'capture', terminal.id, '--lines', '5001'],
      { TREEPORT_API_URL: apiUrl }
    )
    expect(invalid.code).toBe(2)
    expect(requests).toHaveLength(requestCount)
  })

  it('returns immediately when a raw wait condition already matches', async () => {
    const result = await runCli(
      ['terminal', 'wait', terminal.id, '--until', 'idle', '--json'],
      { TREEPORT_API_URL: apiUrl }
    )

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      condition: 'idle',
      terminal: { id: terminal.id },
      metadata: { progress: null }
    })
  })

  it('waits for progress and bell Effect RPC events', async () => {
    eventScenario = 'working'
    const working = await runCli(
      ['terminal', 'wait', terminal.id, '--until', 'working', '--json'],
      { TREEPORT_API_URL: apiUrl }
    )
    expect(working.code).toBe(0)
    expect(JSON.parse(working.stdout)).toMatchObject({
      condition: 'working',
      metadata: { progress: { state: 'indeterminate', value: null } }
    })

    observedMetadata = {
      ...observedMetadata,
      progress: null,
      bell: {
        sequence: 4,
        at: '2026-01-01T00:01:00.000Z',
        unread: true
      }
    }
    eventScenario = 'bell'
    const bell = await runCli(
      ['terminal', 'wait', terminal.id, '--until', 'bell', '--json'],
      { TREEPORT_API_URL: apiUrl }
    )
    expect(bell.code).toBe(0)
    expect(JSON.parse(bell.stdout)).toMatchObject({
      condition: 'bell',
      observedAt: '2026-01-01T00:02:00.000Z',
      metadata: { bell: { sequence: 5, unread: true } }
    })
  })

  it('observes a bell between inspection and the Effect RPC snapshot', async () => {
    eventScenario = 'bell-snapshot'
    const result = await runCli(
      ['terminal', 'wait', terminal.id, '--until', 'bell', '--json'],
      { TREEPORT_API_URL: apiUrl }
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      condition: 'bell',
      observedAt: '2026-01-01T00:02:00.000Z',
      metadata: { bell: { sequence: 1, unread: true } }
    })
  })

  it('refreshes terminal status after an exit event', async () => {
    eventScenario = 'exit'
    const result = await runCli(
      ['terminal', 'wait', terminal.id, '--until', 'exit', '--json'],
      { TREEPORT_API_URL: apiUrl }
    )

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      condition: 'exit',
      terminal: { status: 'exited', exitCode: 7 }
    })
  })

  it('times out with exit 4 and aborts an in-flight status refresh', async () => {
    eventScenario = 'slow-refresh'
    const result = await runCli(
      [
        'terminal',
        'wait',
        terminal.id,
        '--until',
        'working',
        '--timeout',
        '50ms',
        '--json'
      ],
      { TREEPORT_API_URL: apiUrl }
    )

    expect(result.code).toBe(4)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: 'WAIT_TIMEOUT',
        details: {
          terminalId: terminal.id,
          until: 'working',
          timeoutMs: 50,
          lastObservation: { metadata: { progress: null } }
        }
      }
    })
  })

  it('rejects invalid wait arguments and dot without terminal context', async () => {
    const duration = await runCli(
      [
        'terminal',
        'wait',
        terminal.id,
        '--until',
        'working',
        '--timeout',
        '30',
        '--json'
      ],
      { TREEPORT_API_URL: apiUrl }
    )
    expect(duration.code).toBe(2)

    const dot = await runCli(['terminal', 'inspect', '.', '--json'], {
      TREEPORT_API_URL: apiUrl
    })
    expect(dot.code).toBe(5)
    expect(JSON.parse(dot.stderr)).toMatchObject({
      error: { code: 'TREEPORT_CONTEXT_INCOMPLETE' }
    })
  })

  it('rejects extra arguments and unknown options as usage errors', async () => {
    const extraArgument = await runCli(['context', 'unexpected', '--json'])

    expect(extraArgument.code).toBe(2)
    expect(JSON.parse(extraArgument.stderr)).toMatchObject({
      error: {
        code: 'USAGE_ERROR',
        message: expect.stringContaining('Usage:')
      }
    })

    const unknownOption = await runCli([
      'project',
      'list',
      '--unknown',
      '--json'
    ])
    expect(unknownOption.code).toBe(2)
    expect(JSON.parse(unknownOption.stderr)).toMatchObject({
      error: {
        code: 'USAGE_ERROR',
        message: expect.stringContaining("unknown option '--unknown'")
      }
    })
  })
})
