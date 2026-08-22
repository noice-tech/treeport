import { execFile, spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Server as SocketIOServer } from 'socket.io'
import { SOCKET_IO_PATH } from '@treeport/shared'
import type {
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
const cliExecutable = path.join(repositoryRoot, 'node_modules/.bin/treeport')
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
  tmuxSessionName: 'treeport-term-context',
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
  tmuxSocketName: 'treeport-wt-context',
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

async function runPackagedCli(
  args: string[],
  overrides: NodeJS.ProcessEnv = {},
  executable = cliExecutable,
  cwd = repositoryRoot
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: cliEnvironment(overrides),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function requestPackagedDaemon(options: {
  port: number
  path: string
  method?: string
  headers: Record<string, string>
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method,
        headers: options.headers
      },
      (response) => {
        response.setEncoding('utf8')
        let body = ''
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.once('end', () =>
          resolve({ status: response.statusCode ?? 0, body })
        )
      }
    )
    request.once('error', reject)
    request.end()
  })
}

describe('CLI context and machine output', () => {
  let server: Server
  let socketServer: SocketIOServer
  let apiUrl: string
  const requests: string[] = []
  const creationBodies: unknown[] = []
  const terminalCreateBodies: unknown[] = []
  const webPanelBodies: Array<{
    url: string
    body: ObservedWebPanelBody
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
  let createdWorktree: WorktreeRecord | null = null
  let createdWebPanels: WebPanel[] = []

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
    createdWorktree = null
    createdWebPanels = []
    webPanelBodies.length = 0
    registeredFolderPaths.length = 0
    workspaceOpenBodies.length = 0
  })

  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`)
      response.setHeader('content-type', 'application/json')

      if (request.method === 'GET' && request.url === '/api/health') {
        response.end(
          JSON.stringify({
            ok: true,
            version: packageVersion,
            protocolVersion: 1,
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
                    panels: [...worktree.panels, ...createdWebPanels]
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
                id: 'package:npm:@treeport/web-panel-browser:web-panel:browser',
                title: 'Browser',
                source: {
                  type: 'package',
                  packageId: 'npm:@treeport/web-panel-browser',
                  source: 'npm:@treeport/web-panel-browser',
                  scope: 'global'
                }
              },
              {
                id: 'project:preview',
                title: 'Preview',
                source: { type: 'project' }
              },
              {
                id: 'package:one:review',
                title: 'Review one',
                source: {
                  type: 'package',
                  packageId: 'one',
                  source: 'npm:@acme/one',
                  scope: 'global'
                }
              },
              {
                id: 'package:two:review',
                title: 'Review two',
                source: {
                  type: 'package',
                  packageId: 'two',
                  source: 'npm:@acme/two',
                  scope: 'global'
                }
              }
            ]
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
              title:
                body.definitionId ===
                'package:npm:@treeport/web-panel-browser:web-panel:browser'
                  ? String(
                      // SAFETY: The test fixture provides the asserted contract used here.
                      (body.input as { title?: string } | undefined)?.title ??
                        '127.0.0.1:5173'
                    )
                  : 'Preview',
              launch: {
                // SAFETY: The test fixture provides the asserted contract used here.
                input: body.input as WebPanel['launch']['input'],
                cwd: String(body.launchCwd)
              },
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
            terminalError: partial ? 'tmux failed' : null,
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
    socketServer = new SocketIOServer(server, {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      serveClient: false
    })
    socketServer.of('/events').on('connection', (socket) => {
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

      socket.emit('snapshot', {
        at: timestamp,
        terminalMetadata: [observedMetadata],
        webPanels: []
      })
      if (
        eventScenario === 'none' ||
        eventScenario === 'slow-refresh' ||
        eventScenario === 'bell-snapshot'
      ) {
        return
      }

      const timer = setTimeout(() => {
        let event:
          | {
              type: 'terminal.metadata'
              data: TerminalRuntimeMetadata & { worktreeId: null }
            }
          | {
              type: 'terminal.updated'
              data: { terminalId: string; worktreeId: string }
            }
        if (eventScenario === 'working') {
          observedMetadata = {
            ...observedMetadata,
            progress: { state: 'indeterminate', value: null },
            progressStartedAt: '2026-01-01T00:01:00.000Z'
          }
          event = {
            type: 'terminal.metadata',
            data: { ...observedMetadata, worktreeId: null }
          }
        } else if (eventScenario === 'bell') {
          observedMetadata = {
            ...observedMetadata,
            bell: {
              sequence: (observedMetadata.bell?.sequence ?? 0) + 1,
              at: '2026-01-01T00:02:00.000Z',
              unread: true
            }
          }
          event = {
            type: 'terminal.metadata',
            data: { ...observedMetadata, worktreeId: null }
          }
        } else {
          observedTerminal = {
            ...observedTerminal,
            status: 'exited',
            exitCode: 7
          }
          event = {
            type: 'terminal.updated',
            data: {
              terminalId: observedTerminal.id,
              worktreeId: observedTerminal.worktreeId
            }
          }
        }

        socket.emit('product_event', {
          id: 'event-1',
          type: event.type,
          at: '2026-01-01T00:03:00.000Z',
          data: event.data
        })
      }, 10)
      socket.once('disconnect', () => clearTimeout(timer))
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    // SAFETY: The test fixture provides the asserted contract used here.
    const address = server.address() as AddressInfo
    apiUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => socketServer.close(() => resolve()))
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
      worktree: { id: worktree.id, name: 'agent-tools' },
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
      terminalError: 'tmux failed',
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

  it('includes created worktree and terminal IDs in human spawn output', async () => {
    const result = await runCli(
      [
        'spawn',
        '--project',
        project.id,
        '--worktree-name',
        'child',
        '--name',
        'Agent',
        '--',
        'pi'
      ],
      { TREEPORT_API_URL: apiUrl }
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Created tree child (wt_context)')
    expect(result.stdout).toContain('Terminal: Pi (term_context) — running')
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
    expect(opened.code).toBe(0)
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
      [
        'web-panel',
        'open',
        'browser',
        '--worktree',
        '.',
        '--input',
        '{"url":"http://127.0.0.1:5173","title":"Application"}',
        '--json'
      ],
      environment,
      cwd
    )
    expect(browser.code).toBe(0)
    expect(JSON.parse(browser.stdout)).toMatchObject({
      panel: {
        id: 'panel_3',
        definitionId:
          'package:npm:@treeport/web-panel-browser:web-panel:browser',
        title: 'Application'
      },
      created: true,
      reused: false
    })
    expect(webPanelBodies.at(-1)?.body).toMatchObject({
      definitionId: 'package:npm:@treeport/web-panel-browser:web-panel:browser',
      input: {
        url: 'http://127.0.0.1:5173',
        title: 'Application'
      },
      launchCwd: 'packages/client'
    })

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

  it('waits for progress and bell Socket.IO events', async () => {
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

  it('observes a bell between inspection and the Socket.IO snapshot', async () => {
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

  it('advertises and prints the agent usage guide', async () => {
    const help = await runCli(['--help'])

    expect(help.code).toBe(0)
    expect(help.stderr).toBe('')
    expect(help.stdout).toContain(
      "If you're an AI agent, use `treeport skills` to see the usage guide."
    )
    expect(help.stdout).toContain(
      'Usage: treeport [options] [folder] [command]'
    )
    expect(help.stdout).toContain(
      'Manage Treeport projects, trees, and terminals.'
    )
    expect(help.stdout).not.toContain('\n  open')
    expect(help.stdout.indexOf('AI agents:')).toBeLessThan(
      help.stdout.indexOf('Usage:')
    )

    const commandPaths = [
      ['start'],
      ['stop'],
      ['service'],
      ['service', 'enable'],
      ['service', 'status'],
      ['service', 'disable'],
      ['skills'],
      ['context'],
      ['install'],
      ['remove'],
      ['list'],
      ['update'],
      ['reload'],
      ['project'],
      ['project', 'add'],
      ['project', 'list'],
      ['worktree'],
      ['worktree', 'list'],
      ['worktree', 'create'],
      ['worktree', 'remove'],
      ['terminal'],
      ['terminal', 'list'],
      ['terminal', 'create'],
      ['terminal', 'inspect'],
      ['terminal', 'capture'],
      ['terminal', 'wait'],
      ['terminal', 'delete'],
      ['spawn']
    ]
    const commandHelp = []
    for (const command of commandPaths) {
      commandHelp.push(await runCli([...command, '--help']))
    }
    for (const [index, result] of commandHelp.entries()) {
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain(
        `Usage: treeport ${commandPaths[index]!.join(' ')}`
      )
      expect(result.stdout).toContain('-h, --help')
    }
    expect(
      commandHelp[
        commandPaths.findIndex((command) => command.join(' ') === 'worktree')
      ]!.stdout
    ).toContain('List, create, and remove trees')
    const serviceEnableHelp =
      commandHelp[
        commandPaths.findIndex(
          (command) => command.join(' ') === 'service enable'
        )
      ]!.stdout
    expect(serviceEnableHelp).toContain('--headless')
    expect(serviceEnableHelp).toMatch(/requires an\s+administrator/)

    const skills = await runCli(['skills'])

    expect(skills.code).toBe(0)
    expect(skills.stderr).toBe('')
    expect(skills.stdout).toContain('# Treeport')
    expect(skills.stdout).toContain('## Operating rules')
    expect(skills.stdout).toContain('## Create a child tree and terminal')
    expect(skills.stdout).toContain('treeport context')
    expect(skills.stdout).toContain('treeport spawn')
    expect(skills.stdout).toContain(
      'Never invoke `sudo` for a normal service or update operation.'
    )
    expect(skills.stdout).not.toContain(
      '> **Externally managed daemon lifecycle:**'
    )

    observedDaemonLifecycle = 'external'
    const externalSkills = await runCli(['skills'], {
      TREEPORT_API_URL: apiUrl
    })
    expect(externalSkills.code).toBe(0)
    expect(externalSkills.stdout).toContain(
      '> **Externally managed daemon lifecycle:** Do not run `treeport start`, `treeport stop`, or `treeport remote enable`.'
    )

    for (const command of [['start'], ['stop'], ['remote', 'enable']]) {
      const refusal = await runCli([...command, '--json'], {
        TREEPORT_API_URL: apiUrl
      })
      expect(refusal.code).toBe(5)
      expect(JSON.parse(refusal.stderr)).toMatchObject({
        error: {
          code: 'DAEMON_LIFECYCLE_EXTERNAL',
          message: expect.stringContaining('externally managed')
        }
      })
    }
  })

  it('manages global and current-project packages in human and JSON modes', async () => {
    const environment = {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: project.id
    }
    const globalInstall = await runCli(
      ['install', 'npm:@acme/tools', '--json'],
      environment
    )
    expect(globalInstall.code).toBe(0)
    expect(JSON.parse(globalInstall.stdout)).toMatchObject({
      action: 'install',
      source: 'npm:@acme/tools',
      scope: 'global'
    })
    expect(packageBodies.at(-1)).toEqual({
      url: '/api/packages/install',
      body: { source: 'npm:@acme/tools' }
    })

    const projectInstall = await runCli(
      ['install', './', '--local', '--json'],
      environment
    )
    expect(projectInstall.code).toBe(0)
    expect(packageBodies.at(-1)).toEqual({
      url: '/api/packages/install',
      body: {
        source: await realpath(repositoryRoot),
        projectId: project.id
      }
    })

    const list = await runCli(['list'], environment)
    expect(list.code).toBe(0)
    expect(list.stdout).toContain(
      'global\tnpm:@acme/tools\t1 web panels, 1 terminal presets'
    )

    const reserved = await runCli(['update', '--json'], environment)
    expect(reserved.code).toBe(2)
    expect(JSON.parse(reserved.stderr).error.message).toContain(
      'reserved for a future Treeport self-update'
    )

    const update = await runCli(
      ['update', 'npm:@acme/tools', '--json'],
      environment
    )
    expect(update.code).toBe(0)
    expect(JSON.parse(update.stdout)).toEqual([
      expect.objectContaining({ status: 'updated' })
    ])
    expect(packageBodies.at(-1)).toEqual({
      url: '/api/packages/update',
      body: { source: 'npm:@acme/tools' }
    })

    const reload = await runCli(['reload', '-l', '--json'], environment)
    expect(reload.code).toBe(0)
    expect(packageBodies.at(-1)).toEqual({
      url: '/api/packages/reload',
      body: { projectId: project.id }
    })

    const uninstall = await runCli(
      ['uninstall', 'npm:@acme/tools', '--json'],
      environment
    )
    expect(uninstall.code).toBe(0)
    expect(packageBodies.at(-1)).toEqual({
      url: '/api/packages/remove',
      body: { source: 'npm:@acme/tools' }
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

describe('CLI daemon lifecycle', () => {
  it('starts one packaged daemon, serves the app, reports it, and stops without deleting data', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'treeport-cli-lifecycle-')
    )
    const dataDirectory = path.join(temporaryDirectory, 'data')
    const runtimeDirectory = path.join(temporaryDirectory, 'runtime')
    const tmuxPath = path.join(temporaryDirectory, 'tmux')
    const tailscalePath = path.join(temporaryDirectory, 'tailscale')
    const openerCallsPath = path.join(temporaryDirectory, 'opener-calls')
    const openPath = path.join(temporaryDirectory, 'open')
    const xdgOpenPath = path.join(temporaryDirectory, 'xdg-open')
    const tailscaleStatePath = path.join(temporaryDirectory, 'tailscale.json')
    const tailscaleCallsPath = path.join(temporaryDirectory, 'tailscale-calls')
    const nodeOnlyPath = path.join(temporaryDirectory, 'node-only-bin')
    let identityProxy: Server | null = null
    const tmuxExecutable = (await execute('which', ['tmux'])).stdout.trim()
    await Promise.all([
      writeFile(
        tmuxPath,
        `#!/bin/sh\nexec ${JSON.stringify(tmuxExecutable)} "$@"\n`
      ),
      writeFile(
        openPath,
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TREEPORT_OPEN_CALLS"\nexit 0\n'
      ),
      writeFile(
        xdgOpenPath,
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TREEPORT_OPEN_CALLS"\nexit 0\n'
      ),
      mkdir(nodeOnlyPath),
      writeFile(
        tailscalePath,
        `#!/bin/sh
printf '%s\\n' "$*" >> "$TREEPORT_TAILSCALE_CALLS"
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  printf '%s\\n' '{"BackendState":"Running","Self":{"DNSName":"treeport.tailnet.ts.net."}}'
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  [ -f "$TREEPORT_TAILSCALE_STATE" ] && cat "$TREEPORT_TAILSCALE_STATE" || printf '{}\\n'
  exit 0
fi
if [ "$1" = "serve" ]; then
  port=''
  target=''
  disabled=false
  for argument in "$@"; do
    case "$argument" in
      --https=*) port="\${argument#--https=}" ;;
      http://*) target="$argument" ;;
      off) disabled=true ;;
    esac
  done
  if [ "$disabled" = true ]; then
    printf '{}\\n' > "$TREEPORT_TAILSCALE_STATE"
  else
    printf '{"TCP":{"%s":{"HTTPS":true}},"Web":{"treeport.tailnet.ts.net:%s":{"Handlers":{"/":{"Proxy":"%s"}}}}}\\n' "$port" "$port" "$target" > "$TREEPORT_TAILSCALE_STATE"
  fi
  exit 0
fi
exit 1
`
      )
    ])
    await Promise.all([
      chmod(tmuxPath, 0o755),
      chmod(tailscalePath, 0o755),
      chmod(openPath, 0o755),
      chmod(xdgOpenPath, 0o755),
      symlink(process.execPath, path.join(nodeOnlyPath, 'node'))
    ])

    const repository = path.join(temporaryDirectory, 'repository')
    const linkedWorktree = path.join(temporaryDirectory, 'linked-worktree')
    const mainNestedFolder = path.join(repository, 'src', 'main')
    const linkedNestedFolder = path.join(linkedWorktree, 'src', 'linked')
    await mkdir(repository)
    await execute('git', ['init', '-b', 'main'], { cwd: repository })
    await execute('git', ['config', 'user.name', 'Treeport test'], {
      cwd: repository
    })
    await execute('git', ['config', 'user.email', 'treeport@example.test'], {
      cwd: repository
    })
    await writeFile(path.join(repository, 'README.md'), '# CLI lifecycle\n')
    await execute('git', ['add', 'README.md'], { cwd: repository })
    await execute('git', ['commit', '-m', 'Initial commit'], {
      cwd: repository
    })
    await execute(
      'git',
      ['worktree', 'add', '-b', 'feature/folder-command', linkedWorktree],
      { cwd: repository }
    )
    await Promise.all([
      mkdir(mainNestedFolder, { recursive: true }),
      mkdir(linkedNestedFolder, { recursive: true })
    ])

    const reservation = http.createServer()
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', resolve)
    })
    // SAFETY: The test fixture provides the asserted contract used here.
    const address = reservation.address() as AddressInfo
    const port = address.port
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve()))
    )

    const environment = {
      TREEPORT_API_URL: '',
      TREEPORT_HOST: '127.0.0.1',
      TREEPORT_PORT: String(port),
      TREEPORT_DATA_DIR: dataDirectory,
      TREEPORT_RUNTIME_DIR: runtimeDirectory,
      TREEPORT_TMUX_PATH: tmuxPath,
      TREEPORT_GIT_PATH: 'git',
      TREEPORT_TAILSCALE_STATE: tailscaleStatePath,
      TREEPORT_OPEN_CALLS: openerCallsPath,
      TREEPORT_TAILSCALE_CALLS: tailscaleCallsPath,
      PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`
    }

    try {
      const help = await runPackagedCli([], environment)
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('start [options]')
      expect(help.stdout).not.toContain('start|up')

      const unconfirmed = await runPackagedCli(
        ['stop', '--terminate-terminals'],
        environment
      )
      expect(unconfirmed.code).toBe(2)
      expect(unconfirmed.stderr).toContain('--terminate-terminals --force')

      const missingFolder = await runPackagedCli(
        [path.join(temporaryDirectory, 'missing'), '--json'],
        environment
      )
      expect(missingFolder.code).toBe(5)
      expect(JSON.parse(missingFolder.stderr)).toMatchObject({
        error: { code: 'FOLDER_NOT_FOUND' }
      })

      const filePath = path.join(repository, 'README.md')
      const fileFolder = await runPackagedCli([filePath, '--json'], environment)
      expect(fileFolder.code).toBe(5)
      expect(JSON.parse(fileFolder.stderr)).toMatchObject({
        error: { code: 'FOLDER_NOT_DIRECTORY' }
      })

      const unsafeListener = await runPackagedCli(
        ['start', '--host', '0.0.0.0'],
        environment
      )
      expect(unsafeListener.code).toBe(1)
      expect(unsafeListener.stderr).toContain(
        'Treeport supports only loopback listeners'
      )
      await expect(
        stat(path.join(dataDirectory, 'config.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })

      const linkedOpen = await runPackagedCli(
        ['.', '--json'],
        environment,
        cliExecutable,
        linkedNestedFolder
      )
      expect(linkedOpen.code, linkedOpen.stderr).toBe(0)
      // SAFETY: The test fixture provides the asserted contract used here.
      const linkedResult = JSON.parse(linkedOpen.stdout) as {
        projectId: string
        worktreeId: string
        path: string
        url: string
        client: string
      }
      expect(linkedResult).toMatchObject({
        path: await realpath(linkedNestedFolder),
        client: process.platform === 'darwin' ? 'desktop' : 'browser'
      })

      const projectList = await runPackagedCli(
        ['project', 'list', '--json'],
        environment
      )
      // SAFETY: The test fixture provides the asserted contract used here.
      const registeredProjects = JSON.parse(
        projectList.stdout
      ) as ProjectRecord[]
      expect(registeredProjects).toHaveLength(1)
      expect(registeredProjects[0]!.id).toBe(linkedResult.projectId)
      const registeredWorktrees = registeredProjects[0]!.worktrees
      expect(registeredWorktrees.map((item) => item.kind).sort()).toEqual([
        'linked',
        'main'
      ])
      expect(
        registeredWorktrees.find((item) => item.kind === 'linked')?.id
      ).toBe(linkedResult.worktreeId)

      const mainOpen = await runPackagedCli(
        ['.', '--json'],
        environment,
        cliExecutable,
        mainNestedFolder
      )
      expect(mainOpen.code).toBe(0)
      // SAFETY: The test fixture provides the asserted contract used here.
      const mainResult = JSON.parse(mainOpen.stdout) as typeof linkedResult
      expect(mainResult.projectId).toBe(linkedResult.projectId)
      expect(mainResult.worktreeId).toBe(
        registeredWorktrees.find((item) => item.kind === 'main')?.id
      )

      const openedUrls = (await readFile(openerCallsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((call) => call.split(' ').at(-1)!)
        .map((value) =>
          value.startsWith('treeport:')
            ? new URL(value).searchParams.get('url')
            : value
        )
      expect(openedUrls).toEqual([linkedResult.url, mainResult.url])

      const nonGitDirectory = path.join(temporaryDirectory, 'not-a-repository')
      await mkdir(nonGitDirectory)
      const nonGit = await runPackagedCli(
        [nonGitDirectory, '--json'],
        environment
      )
      expect(nonGit.code, nonGit.stderr).toBe(0)
      expect(JSON.parse(nonGit.stdout)).toMatchObject({
        projectKind: 'folder',
        path: await realpath(nonGitDirectory),
        client: process.platform === 'darwin' ? 'desktop' : 'browser'
      })
      // SAFETY: The packaged CLI returned its documented project-list JSON.
      const projectsWithFolder = JSON.parse(
        (await runPackagedCli(['project', 'list', '--json'], environment))
          .stdout
      ) as ProjectRecord[]
      expect(projectsWithFolder).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'folder',
            rootPath: await realpath(nonGitDirectory),
            worktrees: [
              expect.objectContaining({
                kind: 'folder',
                path: await realpath(nonGitDirectory),
                terminals: [
                  expect.objectContaining({ name: 'Shell', status: 'running' })
                ]
              })
            ]
          })
        ])
      )

      const firstStatus = await runPackagedCli(
        ['status', '--json'],
        environment
      )
      expect(firstStatus.code).toBe(0)
      // SAFETY: The test fixture provides the asserted contract used here.
      const firstState = JSON.parse(firstStatus.stdout) as {
        running: boolean
        verified: boolean
        state: { pid: number }
      }
      expect(firstState).toMatchObject({ running: true, verified: true })

      const secondStart = await runPackagedCli(['start'], environment)
      const secondStatus = await runPackagedCli(
        ['status', '--json'],
        environment
      )
      expect(secondStart.code).toBe(0)
      expect(JSON.parse(secondStatus.stdout).state.pid).toBe(
        firstState.state.pid
      )

      const missingTailscale = await runPackagedCli(
        ['remote', 'enable'],
        {
          ...environment,
          PATH: nodeOnlyPath
        },
        path.join(repositoryRoot, 'apps/treeport/bin/treeport.mjs')
      )
      expect(missingTailscale.code).toBe(1)
      expect(missingTailscale.stderr).toContain(
        'Tailscale is required for remote access. Install it from https://tailscale.com/download, run `tailscale up`, then retry.'
      )

      const remoteEnable = await runPackagedCli(
        ['remote', 'enable'],
        environment
      )
      expect(remoteEnable.code).toBe(0)
      expect(remoteEnable.stdout).toContain(
        'https://treeport.tailnet.ts.net:8733'
      )
      const remoteStatus = await runPackagedCli(
        ['remote', 'status'],
        environment
      )
      expect(remoteStatus.code).toBe(0)
      expect(remoteStatus.stdout).toContain('Treeport remote access is enabled')
      const remoteDisable = await runPackagedCli(
        ['remote', 'disable'],
        environment
      )
      expect(remoteDisable.code).toBe(0)
      expect(remoteDisable.stdout).toContain(
        'Treeport remote access is disabled'
      )
      expect(await readFile(tailscaleCallsPath, 'utf8')).toContain(
        `serve --bg --https=8733 http://127.0.0.1:${port}`
      )

      await writeFile(
        tailscaleStatePath,
        '{"TCP":{"8733":{"HTTPS":true}},"Web":{"other.tailnet.ts.net:8733":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}\n'
      )
      const occupiedRemotePort = await runPackagedCli(
        ['remote', 'enable'],
        environment
      )
      expect(occupiedRemotePort.code).toBe(1)
      expect(occupiedRemotePort.stderr).toContain(
        'Tailscale Serve already uses port 8733'
      )
      expect(await readFile(tailscaleStatePath, 'utf8')).toContain(
        'http://127.0.0.1:3000'
      )

      const alternateRemote = await runPackagedCli(
        ['remote', 'enable', '--port', '8734'],
        environment
      )
      expect(alternateRemote.code).toBe(0)
      expect(alternateRemote.stdout).toContain(
        'https://treeport.tailnet.ts.net:8734'
      )
      const alternateRemoteDisable = await runPackagedCli(
        ['remote', 'disable'],
        environment
      )
      expect(alternateRemoteDisable.code).toBe(0)

      const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(
        (response) => response.json()
      )
      expect(health).toMatchObject({
        ok: true,
        version: packageVersion,
        pid: firstState.state.pid,
        daemonLifecycle: 'treeport'
      })
      const appResponse = await fetch(`http://127.0.0.1:${port}/`)
      expect(appResponse.status).toBe(200)
      expect(await appResponse.text()).toContain('<div id="root"></div>')

      const remoteHost = 'treeport.tailnet.ts.net:8733'
      const unauthenticatedRemote = await requestPackagedDaemon({
        port,
        path: '/api/health',
        headers: { Host: remoteHost }
      })
      expect(unauthenticatedRemote.status).toBe(401)
      expect(JSON.parse(unauthenticatedRemote.body)).toMatchObject({
        error: { code: 'AUTHENTICATION_REQUIRED' }
      })

      const tailscaleHeaders = {
        Host: remoteHost,
        Origin: `https://${remoteHost}`,
        'Tailscale-User-Login': 'developer@example.test',
        'X-Forwarded-Host': remoteHost,
        'X-Forwarded-Proto': 'https'
      }
      const authenticatedRemote = await requestPackagedDaemon({
        port,
        path: '/api/health',
        headers: tailscaleHeaders
      })
      expect(authenticatedRemote.status).toBe(200)

      const ingressRequests: Array<{
        authorization: string | undefined
        url: string | undefined
      }> = []
      identityProxy = http.createServer((request, response) => {
        ingressRequests.push({
          authorization: request.headers.authorization,
          url: request.url
        })
        const headers = { ...request.headers }
        delete headers['tailscale-user-login']
        delete headers['tailscale-user-name']
        delete headers['tailscale-user-profile-pic']
        const outgoing = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: request.url,
            method: request.method,
            headers: {
              ...headers,
              host: remoteHost,
              'tailscale-user-login': 'developer@example.test',
              'tailscale-user-name': 'Treeport Developer',
              'tailscale-user-profile-pic': '',
              'x-forwarded-host': remoteHost,
              'x-forwarded-proto': 'https'
            }
          },
          (incoming) => {
            response.writeHead(incoming.statusCode ?? 500, incoming.headers)
            incoming.pipe(response)
          }
        )
        outgoing.once('error', () => response.destroy())
        request.pipe(outgoing)
      })
      await new Promise<void>((resolve) =>
        identityProxy!.listen(0, '127.0.0.1', resolve)
      )
      // SAFETY: The test fixture provides the asserted contract used here.
      const identityProxyAddress = identityProxy.address() as AddressInfo
      const remoteCli = await runPackagedCli(['project', 'list', '--json'], {
        ...environment,
        TREEPORT_API_URL: `http://127.0.0.1:${identityProxyAddress.port}`
      })
      expect(remoteCli.code).toBe(0)
      expect(JSON.parse(remoteCli.stdout)).toHaveLength(2)
      expect(ingressRequests).toEqual([
        { authorization: undefined, url: '/api/projects' }
      ])
      await new Promise<void>((resolve, reject) =>
        identityProxy!.close((error) => (error ? reject(error) : resolve()))
      )
      identityProxy = null

      const foreignMutation = await requestPackagedDaemon({
        port,
        path: '/api/admin/terminate-terminals',
        method: 'POST',
        headers: { ...tailscaleHeaders, Origin: 'https://evil.example' }
      })
      expect(foreignMutation.status).toBe(403)
      expect(JSON.parse(foreignMutation.body)).toMatchObject({
        error: { code: 'INVALID_ORIGIN' }
      })

      const down = await runPackagedCli(
        ['stop', '--terminate-terminals', '--force'],
        environment
      )
      expect(down.code).toBe(0)
      expect(down.stdout).toContain('Treeport is stopped')
      const stopped = await runPackagedCli(['status'], environment)
      expect(stopped.stdout.trim()).toBe('Treeport is stopped')
      await expect(
        stat(path.join(dataDirectory, 'treeport.db'))
      ).resolves.toBeTruthy()

      await writeFile(
        path.join(dataDirectory, 'config.json'),
        `${JSON.stringify({ host: '192.168.1.10', port }, null, 2)}\n`
      )
      const invalidSavedListener = await runPackagedCli(['start'], {
        ...environment,
        TREEPORT_HOST: '',
        HOST: ''
      })
      expect(invalidSavedListener.code).toBe(1)
      expect(invalidSavedListener.stderr).toContain(
        'treeport start --host 127.0.0.1'
      )
      const repairedListener = await runPackagedCli(
        ['start', '--host', '127.0.0.1'],
        { ...environment, TREEPORT_HOST: '', HOST: '' }
      )
      expect(repairedListener.code).toBe(0)
      await runPackagedCli(
        ['stop', '--terminate-terminals', '--force'],
        environment
      )

      await writeFile(
        tmuxPath,
        '#!/bin/sh\n[ "$1" = "-V" ] && echo "tmux 3.1"\nexit 0\n',
        { mode: 0o755 }
      )
      const doctor = await runPackagedCli(['doctor'], environment)
      expect(doctor.code).toBe(1)
      expect(doctor.stdout).toContain('Treeport requires tmux 3.2 or newer')
      const refused = await runPackagedCli(['start'], environment)
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('Treeport requires tmux 3.2 or newer')
    } finally {
      if (identityProxy) {
        await new Promise<void>((resolve) =>
          identityProxy!.close(() => resolve())
        )
      }

      await runPackagedCli(
        ['stop', '--terminate-terminals', '--force'],
        environment
      )
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }, 60_000)
})
