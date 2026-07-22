import { spawn } from 'node:child_process'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server as SocketIOServer } from 'socket.io'
import { SOCKET_IO_PATH } from '@tasktty/shared'
import type {
  ProjectRecord,
  TerminalRecord,
  TerminalRuntimeMetadata,
  WorktreeRecord
} from '@tasktty/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
)
const cliExecutable = path.join(repositoryRoot, 'node_modules/.bin/tasktty')
const timestamp = '2026-01-01T00:00:00.000Z'

const terminal: TerminalRecord = {
  id: 'term_context',
  worktreeId: 'wt_context',
  name: 'Pi',
  tmuxSessionName: 'tasktty-term-context',
  argv: ['pi'],
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
  tmuxSocketName: 'tasktty-wt-context',
  status: 'active',
  cleanupError: null,
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
  createdAt: timestamp,
  updatedAt: timestamp
}

const project: ProjectRecord = {
  id: 'proj_context',
  name: 'tasktty',
  repositoryPath: '/repo/tasktty',
  mainWorktreePath: '/repo/tasktty',
  defaultBranch: 'main',
  color: null,
  availability: { state: 'available', message: null },
  worktrees: [worktree],
  createdAt: timestamp,
  updatedAt: timestamp
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

async function runCli(
  args: string[],
  overrides: NodeJS.ProcessEnv = {}
): Promise<CliResult> {
  const env = { ...process.env }
  for (const name of [
    'TASKTTY_API_URL',
    'TASKTTY_PROJECT_ID',
    'TASKTTY_WORKTREE_ID',
    'TASKTTY_TERMINAL_ID'
  ]) {
    delete env[name]
  }
  Object.assign(env, overrides)

  return new Promise((resolve, reject) => {
    const child = spawn(cliExecutable, args, {
      cwd: repositoryRoot,
      env,
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

describe('CLI context and machine output', () => {
  let server: Server
  let socketServer: SocketIOServer
  let apiUrl: string
  const requests: string[] = []
  const spawnBodies: unknown[] = []
  let observedTerminal = terminal
  let observedMetadata: TerminalRuntimeMetadata = {
    terminalId: terminal.id,
    title: 'Pi · /repo',
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

  beforeEach(() => {
    observedTerminal = terminal
    observedMetadata = {
      terminalId: terminal.id,
      title: 'Pi · /repo',
      progress: null,
      progressStartedAt: timestamp,
      progressClearedAt: timestamp,
      bell: null
    }
    eventScenario = 'none'
    inspectionRequests = 0
  })

  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`)
      response.setHeader('content-type', 'application/json')

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
        response.end(JSON.stringify({ projects: [project] }))
        return
      }

      if (
        request.method === 'GET' &&
        request.url === '/api/projects/proj_context'
      ) {
        response.end(JSON.stringify({ project }))
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

      if (request.method === 'POST' && request.url === '/api/spawn') {
        let source = ''
        for await (const chunk of request) {
          source += chunk
        }
        const body = JSON.parse(source) as { worktreeName: string }
        spawnBodies.push(body)
        if (body.worktreeName === 'partial') {
          response.statusCode = 201
          response.end(
            JSON.stringify({
              worktree: { ...worktree, name: 'partial' },
              terminal: null,
              terminalError: 'tmux failed',
              setupError: 'setup could not be prepared'
            })
          )
          return
        }

        response.statusCode = 201
        response.end(
          JSON.stringify({
            worktree: { ...worktree, name: body.worktreeName },
            terminal,
            terminalError: null,
            setupError: null
          })
        )
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
          bell: { sequence: 1, at: '2026-01-01T00:02:00.000Z' }
        }
      }

      socket.emit('snapshot', {
        at: timestamp,
        terminalMetadata: [observedMetadata]
      })
      if (
        eventScenario === 'none' ||
        eventScenario === 'slow-refresh' ||
        eventScenario === 'bell-snapshot'
      ) {
        return
      }

      const timer = setTimeout(() => {
        let event: {
          type: 'terminal.metadata' | 'terminal.updated'
          data: Record<string, unknown>
        }
        if (eventScenario === 'working') {
          observedMetadata = {
            ...observedMetadata,
            progress: { state: 'indeterminate', value: null },
            progressStartedAt: '2026-01-01T00:01:00.000Z'
          }
          event = { type: 'terminal.metadata', data: observedMetadata }
        } else if (eventScenario === 'bell') {
          observedMetadata = {
            ...observedMetadata,
            bell: {
              sequence: (observedMetadata.bell?.sequence ?? 0) + 1,
              at: '2026-01-01T00:02:00.000Z'
            }
          }
          event = { type: 'terminal.metadata', data: observedMetadata }
        } else {
          observedTerminal = {
            ...observedTerminal,
            status: 'exited',
            exitCode: 7
          }
          event = {
            type: 'terminal.updated',
            data: { terminalId: observedTerminal.id }
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
    const address = server.address() as AddressInfo
    apiUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => socketServer.close(() => resolve()))
  })

  it('prints concise context text by default', async () => {
    const result = await runCli(['context'], {
      TASKTTY_API_URL: apiUrl,
      TASKTTY_PROJECT_ID: project.id,
      TASKTTY_WORKTREE_ID: worktree.id,
      TASKTTY_TERMINAL_ID: terminal.id
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('TaskTTY context')
    expect(result.stdout).toContain('Project:  tasktty (proj_context)')
    expect(result.stdout).toContain('Worktree: agent-tools (wt_context)')
    expect(result.stdout).toContain('Terminal: Pi (term_context) — running')
    expect(result.stdout.trimStart().startsWith('{')).toBe(false)
  })

  it('returns compact structured context only when requested', async () => {
    const result = await runCli(['context', '--json'], {
      TASKTTY_API_URL: apiUrl,
      TASKTTY_PROJECT_ID: project.id,
      TASKTTY_WORKTREE_ID: worktree.id,
      TASKTTY_TERMINAL_ID: terminal.id
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('\n  ')
    expect(JSON.parse(result.stdout)).toMatchObject({
      managed: true,
      apiUrl,
      project: { id: project.id, name: 'tasktty' },
      worktree: { id: worktree.id, name: 'agent-tools' },
      terminal: { id: terminal.id, name: 'Pi', status: 'running' }
    })
  })

  it('detects an unmanaged terminal without contacting the daemon', async () => {
    const requestCount = requests.length
    const result = await runCli(['context', '--json'], {
      TASKTTY_API_URL: apiUrl
    })

    expect(result).toEqual({
      code: 0,
      stdout: '{"managed":false,"reason":"outside_tasktty"}\n',
      stderr: ''
    })
    expect(requests).toHaveLength(requestCount)
  })

  it('refuses incomplete and inconsistent injected context', async () => {
    const requestCount = requests.length
    const incomplete = await runCli(['context', '--json'], {
      TASKTTY_API_URL: apiUrl,
      TASKTTY_PROJECT_ID: project.id
    })
    expect(incomplete.code).toBe(5)
    expect(incomplete.stdout).toBe('')
    expect(JSON.parse(incomplete.stderr)).toEqual({
      error: {
        code: 'TASKTTY_CONTEXT_INCOMPLETE',
        message:
          'Incomplete TaskTTY context; missing TASKTTY_WORKTREE_ID, TASKTTY_TERMINAL_ID',
        details: {
          missing: ['TASKTTY_WORKTREE_ID', 'TASKTTY_TERMINAL_ID']
        }
      }
    })
    expect(requests).toHaveLength(requestCount)

    const inconsistent = await runCli(['context', '--json'], {
      TASKTTY_API_URL: apiUrl,
      TASKTTY_PROJECT_ID: project.id,
      TASKTTY_WORKTREE_ID: 'wt_other',
      TASKTTY_TERMINAL_ID: terminal.id
    })
    expect(inconsistent.code).toBe(5)
    expect(JSON.parse(inconsistent.stderr)).toMatchObject({
      error: { code: 'TASKTTY_CONTEXT_INVALID' }
    })
  })

  it('preserves API domain errors in JSON mode', async () => {
    const result = await runCli(['context', '--json'], {
      TASKTTY_API_URL: apiUrl,
      TASKTTY_PROJECT_ID: 'proj_domain',
      TASKTTY_WORKTREE_ID: worktree.id,
      TASKTTY_TERMINAL_ID: terminal.id
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

  it('reports an unreachable daemon as a structured exit 3 failure', async () => {
    const unavailable = http.createServer()
    await new Promise<void>((resolve) => {
      unavailable.listen(0, '127.0.0.1', resolve)
    })
    const address = unavailable.address() as AddressInfo
    await new Promise<void>((resolve, reject) => {
      unavailable.close((error) => (error ? reject(error) : resolve()))
    })

    const result = await runCli(['context', '--json'], {
      TASKTTY_API_URL: `http://127.0.0.1:${address.port}`,
      TASKTTY_PROJECT_ID: project.id,
      TASKTTY_WORKTREE_ID: worktree.id,
      TASKTTY_TERMINAL_ID: terminal.id
    })

    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'DAEMON_UNREACHABLE' }
    })
  })

  it('keeps spawn argv structured and exposes partial creation', async () => {
    const result = await runCli(
      [
        'spawn',
        '--project',
        project.id,
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
      { TASKTTY_API_URL: apiUrl }
    )

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      worktree: { id: worktree.id, name: 'partial' },
      terminal: null,
      terminalError: 'tmux failed',
      setupError: 'setup could not be prepared'
    })
    expect(spawnBodies.at(-1)).toMatchObject({
      project: project.id,
      argv: ['pi', 'semi;colon', '$HOME']
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
      { TASKTTY_API_URL: apiUrl }
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Created worktree child (wt_context)')
    expect(result.stdout).toContain('Terminal: Pi (term_context) — running')
  })

  it('inspects terminals by exact ID and managed dot context', async () => {
    const human = await runCli(['terminal', 'inspect', terminal.id], {
      TASKTTY_API_URL: apiUrl
    })
    expect(human.code).toBe(0)
    expect(human.stderr).toBe('')
    expect(human.stdout).toContain('Terminal: Pi (term_context)')
    expect(human.stdout).toContain('Progress: idle')
    expect(human.stdout).toContain('Title:    Pi · /repo')

    const json = await runCli(['terminal', 'inspect', '.', '--json'], {
      TASKTTY_API_URL: apiUrl,
      TASKTTY_TERMINAL_ID: terminal.id
    })
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout)).toEqual({
      terminal,
      metadata: observedMetadata
    })
  })

  it('returns immediately when a raw wait condition already matches', async () => {
    const result = await runCli(
      ['terminal', 'wait', terminal.id, '--until', 'idle', '--json'],
      { TASKTTY_API_URL: apiUrl }
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
      { TASKTTY_API_URL: apiUrl }
    )
    expect(working.code).toBe(0)
    expect(JSON.parse(working.stdout)).toMatchObject({
      condition: 'working',
      metadata: { progress: { state: 'indeterminate', value: null } }
    })

    observedMetadata = {
      ...observedMetadata,
      progress: null,
      bell: { sequence: 4, at: '2026-01-01T00:01:00.000Z' }
    }
    eventScenario = 'bell'
    const bell = await runCli(
      ['terminal', 'wait', terminal.id, '--until', 'bell', '--json'],
      { TASKTTY_API_URL: apiUrl }
    )
    expect(bell.code).toBe(0)
    expect(JSON.parse(bell.stdout)).toMatchObject({
      condition: 'bell',
      observedAt: '2026-01-01T00:02:00.000Z',
      metadata: { bell: { sequence: 5 } }
    })
  })

  it('observes a bell between inspection and the Socket.IO snapshot', async () => {
    eventScenario = 'bell-snapshot'
    const result = await runCli(
      ['terminal', 'wait', terminal.id, '--until', 'bell', '--json'],
      { TASKTTY_API_URL: apiUrl }
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      condition: 'bell',
      observedAt: '2026-01-01T00:02:00.000Z',
      metadata: { bell: { sequence: 1 } }
    })
  })

  it('refreshes terminal status after an exit event', async () => {
    eventScenario = 'exit'
    const result = await runCli(
      ['terminal', 'wait', terminal.id, '--until', 'exit', '--json'],
      { TASKTTY_API_URL: apiUrl }
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
      { TASKTTY_API_URL: apiUrl }
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
      { TASKTTY_API_URL: apiUrl }
    )
    expect(duration.code).toBe(2)

    const dot = await runCli(['terminal', 'inspect', '.', '--json'], {
      TASKTTY_API_URL: apiUrl
    })
    expect(dot.code).toBe(5)
    expect(JSON.parse(dot.stderr)).toMatchObject({
      error: { code: 'TASKTTY_CONTEXT_INCOMPLETE' }
    })
  })

  it('rejects unexpected context arguments as usage errors', async () => {
    const result = await runCli(['context', 'unexpected', '--json'])

    expect(result.code).toBe(2)
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'USAGE_ERROR', message: expect.stringContaining('Usage:') }
    })
  })
})
