import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server as SocketIOServer } from 'socket.io'
import { SOCKET_IO_PATH } from '@treeport/shared'
import type {
  ProjectRecord,
  TerminalRecord,
  TerminalRuntimeMetadata,
  WorktreeRecord
} from '@treeport/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
)
const cliExecutable = path.join(repositoryRoot, 'node_modules/.bin/treeport')
const timestamp = '2026-01-01T00:00:00.000Z'

const terminal: TerminalRecord = {
  id: 'term_context',
  worktreeId: 'wt_context',
  name: 'Pi',
  tmuxSessionName: 'treeport-term-context',
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
  tmuxSocketName: 'treeport-wt-context',
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
  name: 'treeport',
  repositoryPath: '/repo/treeport',
  mainWorktreePath: '/repo/treeport',
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
  overrides: NodeJS.ProcessEnv = {},
  executable = cliExecutable
): Promise<CliResult> {
  const env = { ...process.env }
  for (const name of [
    'TREEPORT_API_URL',
    'TREEPORT_PROJECT_ID',
    'TREEPORT_WORKTREE_ID',
    'TREEPORT_TERMINAL_ID'
  ]) {
    delete env[name]
  }
  Object.assign(env, overrides)

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
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
  const terminalCreateBodies: unknown[] = []
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
          bell: {
            sequence: 1,
            at: '2026-01-01T00:02:00.000Z',
            unread: true
          }
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
              at: '2026-01-01T00:02:00.000Z',
              unread: true
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
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Treeport context')
    expect(result.stdout).toContain('Project:  treeport (proj_context)')
    expect(result.stdout).toContain('Worktree: agent-tools (wt_context)')
    expect(result.stdout).toContain('Terminal: Pi (term_context) — running')
    expect(result.stdout.trimStart().startsWith('{')).toBe(false)
  })

  it('returns compact structured context only when requested', async () => {
    const result = await runCli(['context', '--json'], {
      TREEPORT_API_URL: apiUrl,
      TREEPORT_PROJECT_ID: project.id,
      TREEPORT_WORKTREE_ID: worktree.id,
      TREEPORT_TERMINAL_ID: terminal.id
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('\n  ')
    expect(JSON.parse(result.stdout)).toMatchObject({
      managed: true,
      apiUrl,
      project: { id: project.id, name: 'treeport' },
      worktree: { id: worktree.id, name: 'agent-tools' },
      terminal: { id: terminal.id, name: 'Pi', status: 'running' }
    })
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

  it('keeps terminal and spawn argv structured and exposes partial creation', async () => {
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
      { TREEPORT_API_URL: apiUrl }
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
      { TREEPORT_API_URL: apiUrl }
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Created worktree child (wt_context)')
    expect(result.stdout).toContain('Terminal: Pi (term_context) — running')
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
    expect(help.stdout.indexOf('AI agents:')).toBeLessThan(
      help.stdout.indexOf('Usage:')
    )

    const commandPaths = [
      ['skills'],
      ['context'],
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
    const commandHelp = await Promise.all(
      commandPaths.map((command) => runCli([...command, '--help']))
    )
    for (const [index, result] of commandHelp.entries()) {
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain(
        `Usage: treeport ${commandPaths[index]!.join(' ')}`
      )
      expect(result.stdout).toContain('-h, --help')
    }

    const skills = await runCli(['skills'])

    expect(skills.code).toBe(0)
    expect(skills.stderr).toBe('')
    expect(skills.stdout).toContain('# Treeport')
    expect(skills.stdout).toContain('## Operating rules')
    expect(skills.stdout).toContain('treeport context')
    expect(skills.stdout).toContain('treeport spawn')
  })

  it('rejects extra arguments and unknown options as usage errors', async () => {
    const extraArgument = await runCli(['context', 'unexpected', '--json'])

    expect(extraArgument.code).toBe(2)
    expect(JSON.parse(extraArgument.stderr)).toMatchObject({
      error: { code: 'USAGE_ERROR', message: expect.stringContaining('Usage:') }
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
    const gitPath = path.join(temporaryDirectory, 'git')
    await Promise.all([
      writeFile(
        tmuxPath,
        '#!/bin/sh\n[ "$1" = "-V" ] && echo "tmux 3.6a"\nexit 0\n'
      ),
      writeFile(
        gitPath,
        '#!/bin/sh\n[ "$1" = "--version" ] && echo "git version 2.39.5"\nexit 0\n'
      )
    ])
    await Promise.all([chmod(tmuxPath, 0o755), chmod(gitPath, 0o755)])

    const reservation = http.createServer()
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', resolve)
    })
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
      TREEPORT_GIT_PATH: gitPath
    }

    try {
      const help = await runCli([], environment)
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('up [options]')

      const unconfirmed = await runCli(
        ['down', '--terminate-terminals'],
        environment
      )
      expect(unconfirmed.code).toBe(2)
      expect(unconfirmed.stderr).toContain('--terminate-terminals --force')

      const firstUp = await runCli(['up'], environment)
      expect(firstUp.code).toBe(0)
      expect(firstUp.stdout).toContain(`http://127.0.0.1:${port}`)

      const firstStatus = await runCli(['status', '--json'], environment)
      expect(firstStatus.code).toBe(0)
      const firstState = JSON.parse(firstStatus.stdout) as {
        running: boolean
        verified: boolean
        state: { pid: number }
      }
      expect(firstState).toMatchObject({ running: true, verified: true })

      const secondUp = await runCli(['up'], environment)
      const secondStatus = await runCli(['status', '--json'], environment)
      expect(secondUp.code).toBe(0)
      expect(JSON.parse(secondStatus.stdout).state.pid).toBe(
        firstState.state.pid
      )

      const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(
        (response) => response.json()
      )
      expect(health).toMatchObject({
        ok: true,
        version: '0.1.0',
        pid: firstState.state.pid
      })
      const app = await fetch(`http://127.0.0.1:${port}/`).then((response) =>
        response.text()
      )
      expect(app).toContain('<div id="root"></div>')

      const down = await runCli(['down'], environment)
      expect(down.code).toBe(0)
      expect(down.stdout).toContain('Treeport is down')
      const stopped = await runCli(['status'], environment)
      expect(stopped.stdout.trim()).toBe('Treeport is down')
      await expect(
        stat(path.join(dataDirectory, 'treeport.db'))
      ).resolves.toBeTruthy()

      await writeFile(
        tmuxPath,
        '#!/bin/sh\n[ "$1" = "-V" ] && echo "tmux 3.1"\nexit 0\n',
        { mode: 0o755 }
      )
      const doctor = await runCli(['doctor'], environment)
      expect(doctor.code).toBe(1)
      expect(doctor.stdout).toContain('Treeport requires tmux 3.2 or newer')
      const refused = await runCli(['up'], environment)
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('Treeport requires tmux 3.2 or newer')
    } finally {
      await runCli(['down'], environment)
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
