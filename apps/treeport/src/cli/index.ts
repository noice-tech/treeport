#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { Command, CommanderError } from 'commander'
import { io, type Socket } from 'socket.io-client'
import {
  parseEventsSnapshot,
  parseProductEvent,
  parseTerminalRuntimeMetadata,
  SOCKET_IO_PATH,
  TERMINAL_CAPTURE_DEFAULT_LINES,
  TERMINAL_CAPTURE_MAX_LINES,
  type ApiErrorBody,
  type EventsClientToServerEvents,
  type EventsServerToClientEvents,
  type PackageListing,
  type PackageOperationResult,
  type PackageResourceDiagnostic,
  type OperationRecord,
  type ProjectRecord,
  type RemovePreview,
  type TreeportContext,
  type TerminalCapture,
  type TerminalRecord,
  type TerminalRuntimeMetadata,
  type WorktreeRecord
} from '@treeport/shared'
import { parseDurationMs } from '../duration.js'
import { extractJsonOutput } from './args.js'
import { OpenWorkspaceError, openWorkspace } from './open.js'
import {
  daemonDown,
  daemonHealth,
  daemonStatus,
  daemonUp,
  disableTailscaleRemote,
  enableTailscaleRemote,
  readDaemonLogs,
  resolveLocalApiUrl,
  resolvePackagePath,
  runDoctor,
  tailscaleRemoteStatus,
  treeportVersion
} from './lifecycle.js'

const configuredApiUrl = process.env.TREEPORT_API_URL?.trim()
const apiUrl = (await resolveLocalApiUrl()).replace(/\/$/, '')
const contextPrefix = 'TREEPORT'
const contextProjectId = process.env.TREEPORT_PROJECT_ID?.trim()
const contextWorktreeId = process.env.TREEPORT_WORKTREE_ID?.trim()
const contextTerminalId = process.env.TREEPORT_TERMINAL_ID?.trim()
const configuredDaemonLifecycle = process.env.TREEPORT_DAEMON_LIFECYCLE?.trim()
const rawArgs = process.argv.slice(2)
const jsonOutput = extractJsonOutput(rawArgs)

class CliError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(
    message: string,
    readonly exitCode: number,
    code?: string,
    details?: unknown
  ) {
    super(message)
    this.code =
      code ??
      (exitCode === 2
        ? 'USAGE_ERROR'
        : exitCode === 3
          ? 'DAEMON_UNREACHABLE'
          : exitCode === 4
            ? 'WAIT_TIMEOUT'
            : exitCode === 5
              ? 'DOMAIN_ERROR'
              : 'UNEXPECTED_ERROR')
    this.details = details
  }
}

async function resolveDaemonLifecycle(): Promise<'treeport' | 'external'> {
  if (configuredDaemonLifecycle === 'external') {
    return 'external'
  }

  if (configuredApiUrl) {
    return (await daemonHealth(apiUrl))?.daemonLifecycle ?? 'treeport'
  }

  return 'treeport'
}

async function request<T>(
  pathname: string,
  options: RequestInit = {}
): Promise<T> {
  const controller = new AbortController()
  const externalSignal = options.signal
  const abort = () => controller.abort()
  if (externalSignal?.aborted) {
    controller.abort()
  } else {
    externalSignal?.addEventListener('abort', abort, { once: true })
  }

  const timeout = setTimeout(abort, 90_000)
  try {
    const response = await fetch(`${apiUrl}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers
      }
    })
    const body = (await response.json().catch(() => ({}))) as T | ApiErrorBody
    if (!response.ok) {
      const error = (body as ApiErrorBody).error
      throw new CliError(
        error?.message || `HTTP ${response.status}`,
        5,
        error?.code || 'API_ERROR',
        error?.details
      )
    }

    return body as T
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }

    throw new CliError(
      `Cannot reach Treeport daemon at ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`,
      3,
      'DAEMON_UNREACHABLE'
    )
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abort)
  }
}

async function createWorktree(
  projectId: string,
  input: {
    name: string
    base: 'default' | 'current'
    initialTerminal?: { name: string; argv?: string[] }
    sourceWorktreeId?: string
  }
): Promise<{
  worktree: WorktreeRecord
  terminal: TerminalRecord | null
  terminalError: string | null
  setupError: string | null
}> {
  let operation = (
    await request<{ operation: OperationRecord }>(
      `/api/projects/${encodeURIComponent(projectId)}/worktree-operations`,
      { method: 'POST', body: JSON.stringify(input) }
    )
  ).operation

  while (operation.status === 'pending' || operation.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 100))
    operation = (
      await request<{ operation: OperationRecord }>(
        `/api/operations/${encodeURIComponent(operation.id)}`
      )
    ).operation
  }

  if (operation.status === 'failed') {
    throw new CliError(
      operation.error ?? 'Worktree creation failed',
      5,
      'WORKTREE_CREATION_FAILED'
    )
  }

  const worktreeId =
    typeof operation.result?.worktreeId === 'string'
      ? operation.result.worktreeId
      : operation.worktreeId
  if (!worktreeId) {
    throw new CliError(
      'Completed worktree creation did not identify its worktree',
      5,
      'INVALID_OPERATION_RESULT'
    )
  }

  const project = (
    await request<{ project: ProjectRecord }>(
      `/api/projects/${encodeURIComponent(projectId)}`
    )
  ).project
  const worktree = project.worktrees.find((item) => item.id === worktreeId)
  if (!worktree) {
    throw new CliError(
      `Created worktree ${worktreeId} was not found`,
      5,
      'INVALID_OPERATION_RESULT'
    )
  }

  const terminalId =
    typeof operation.result?.terminalId === 'string'
      ? operation.result.terminalId
      : null

  return {
    worktree,
    terminal: worktree.terminals.find((item) => item.id === terminalId) ?? null,
    terminalError:
      typeof operation.result?.terminalError === 'string'
        ? operation.result.terminalError
        : null,
    setupError:
      typeof operation.result?.setupError === 'string'
        ? operation.result.setupError
        : null
  }
}

function commandArgv(args: string[]): string[] | undefined {
  const separator = args.indexOf('--')
  if (separator === -1) {
    return undefined
  }

  const argv = args.slice(separator + 1)
  args.splice(separator)
  if (!argv.length) {
    throw new CliError('Expected a command after --', 2)
  }

  return argv
}

async function canonical(value: string): Promise<string> {
  return fs.realpath(path.resolve(value)).catch(() => path.resolve(value))
}

async function projects(): Promise<ProjectRecord[]> {
  return (await request<{ projects: ProjectRecord[] }>('/api/projects'))
    .projects
}

function pathContains(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

async function resolveProject(identifier: string): Promise<ProjectRecord> {
  const list = await projects()
  const direct = list.find((project) => project.id === identifier)
  if (direct) {
    return direct
  }

  if (identifier === '.' && contextProjectId) {
    const environmentMatch = list.find(
      (project) => project.id === contextProjectId
    )
    if (environmentMatch) {
      return environmentMatch
    }
  }

  const candidate = await canonical(identifier)
  const match = list.find(
    (project) =>
      pathContains(candidate, project.repositoryPath) ||
      project.worktrees.some((worktree) =>
        pathContains(candidate, worktree.path)
      )
  )
  if (!match) {
    throw new CliError(`No registered project matches ${identifier}`, 5)
  }

  return match
}

async function packageSource(value: string): Promise<string> {
  if (value.startsWith('npm:')) {
    return value
  }

  if (
    path.isAbsolute(value) ||
    value === '.' ||
    value === '..' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value === '~' ||
    value.startsWith('~/')
  ) {
    return canonical(value)
  }

  return value
}

async function localPackageProjectId(): Promise<string> {
  const search = new URLSearchParams({ path: await canonical(process.cwd()) })
  return (
    await request<{ project: Pick<ProjectRecord, 'id'> }>(
      `/api/packages/project?${search.toString()}`
    )
  ).project.id
}

async function resolveWorktree(identifier: string): Promise<WorktreeRecord> {
  const all = (await projects()).flatMap((project) => project.worktrees)
  const direct = all.find((worktree) => worktree.id === identifier)
  if (direct) {
    return direct
  }

  if (identifier === '.' && contextWorktreeId) {
    const environmentMatch = all.find(
      (worktree) => worktree.id === contextWorktreeId
    )
    if (environmentMatch) {
      return environmentMatch
    }
  }

  const candidate = await canonical(identifier)
  const match = all
    .filter((worktree) => pathContains(candidate, worktree.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (!match) {
    throw new CliError(`No registered worktree matches ${identifier}`, 5)
  }

  return match
}

type WaitCondition = 'idle' | 'working' | 'bell' | 'exit'

interface TerminalObservation {
  terminal: TerminalRecord
  metadata: TerminalRuntimeMetadata
}

interface TerminalWaitResult extends TerminalObservation {
  condition: WaitCondition
  observedAt: string
}

function resolveTerminalId(identifier: string): string {
  if (identifier !== '.') {
    return identifier
  }

  const terminalId = contextTerminalId
  if (!terminalId) {
    const variable = `${contextPrefix}_TERMINAL_ID`
    throw new CliError(
      `Cannot resolve . without ${variable}`,
      5,
      'TREEPORT_CONTEXT_INCOMPLETE',
      { missing: [variable] }
    )
  }

  return terminalId
}

function parseCaptureLines(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliError(
      `--lines must be an integer between 1 and ${TERMINAL_CAPTURE_MAX_LINES}`,
      2
    )
  }

  const lines = Number(value)
  if (!Number.isSafeInteger(lines) || lines > TERMINAL_CAPTURE_MAX_LINES) {
    throw new CliError(
      `--lines must be an integer between 1 and ${TERMINAL_CAPTURE_MAX_LINES}`,
      2
    )
  }

  return lines
}

function parseDuration(value: string): number {
  try {
    return parseDurationMs(value)
  } catch (error) {
    throw new CliError(
      error instanceof Error ? error.message : String(error),
      2
    )
  }
}

async function inspectTerminal(
  terminalId: string,
  signal?: AbortSignal
): Promise<TerminalObservation> {
  return request<TerminalObservation>(
    `/api/terminals/${encodeURIComponent(terminalId)}`,
    signal ? { signal } : {}
  )
}

async function waitForTerminal(
  terminalId: string,
  condition: WaitCondition,
  timeoutMs?: number
): Promise<TerminalWaitResult> {
  let observation: TerminalObservation | null = null
  let bellBaseline: number | null = null
  const matched = (observedAt: string): TerminalWaitResult | null => {
    if (!observation) {
      return null
    }

    const matches =
      (condition === 'idle' && observation.metadata.progress === null) ||
      (condition === 'working' && observation.metadata.progress !== null) ||
      (condition === 'exit' && observation.terminal.status === 'exited') ||
      (condition === 'bell' &&
        bellBaseline !== null &&
        (observation.metadata.bell?.sequence ?? 0) > bellBaseline)
    if (!matches) {
      return null
    }

    return {
      condition,
      observedAt:
        condition === 'bell'
          ? (observation.metadata.bell?.at ?? observedAt)
          : observedAt,
      ...observation
    }
  }

  const controller = new AbortController()
  let cancellation: 'timeout' | 'interrupt' | null = null
  const interrupt = () => {
    cancellation = 'interrupt'
    controller.abort()
  }
  process.once('SIGINT', interrupt)
  const timeout =
    timeoutMs === undefined
      ? null
      : setTimeout(() => {
          cancellation = 'timeout'
          controller.abort()
        }, timeoutMs)
  timeout?.unref()
  let events: Socket<
    EventsServerToClientEvents,
    EventsClientToServerEvents
  > | null = null

  try {
    observation = await inspectTerminal(terminalId, controller.signal)
    if (condition === 'bell') {
      bellBaseline = observation.metadata.bell?.sequence ?? 0
    }

    const immediate = matched(new Date().toISOString())
    if (immediate) {
      return immediate
    }

    events = io(`${apiUrl}/events`, {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
      reconnection: false,
      retries: 0
    })
    return await new Promise<TerminalWaitResult>((resolve, reject) => {
      let settled = false
      let queue = Promise.resolve()
      const finish = (result: TerminalWaitResult) => {
        if (!settled) {
          settled = true
          resolve(result)
        }
      }
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      }
      const enqueue = (task: () => Promise<void>) => {
        queue = queue.then(task)
        void queue.catch(fail)
      }

      controller.signal.addEventListener(
        'abort',
        () => fail(new Error('Terminal wait cancelled')),
        { once: true }
      )
      events!.on('snapshot', (value) =>
        enqueue(async () => {
          const snapshot = parseEventsSnapshot(value)
          if (!snapshot || !observation) {
            throw new CliError(
              'Treeport daemon sent an invalid event snapshot',
              3,
              'DAEMON_PROTOCOL_ERROR'
            )
          }

          const metadata = snapshot.terminalMetadata.find(
            (item) => item.terminalId === terminalId
          )
          if (metadata) {
            observation = { ...observation, metadata }
          }

          const snapshotMatch = matched(snapshot.at)
          if (snapshotMatch) {
            finish(snapshotMatch)
            return
          }

          observation = await inspectTerminal(terminalId, controller.signal)
          if (cancellation) {
            throw new Error('Terminal wait cancelled')
          }

          const refreshedMatch = matched(new Date().toISOString())
          if (refreshedMatch) {
            finish(refreshedMatch)
          }
        })
      )
      events!.on('product_event', (value) =>
        enqueue(async () => {
          const event = parseProductEvent(value)
          if (!event) {
            throw new CliError(
              'Treeport daemon sent an invalid product event',
              3,
              'DAEMON_PROTOCOL_ERROR'
            )
          }

          if (
            event.type !== 'terminal.metadata' &&
            event.type !== 'terminal.updated' &&
            event.type !== 'terminal.removed'
          ) {
            return
          }

          if (event.data.terminalId !== terminalId) {
            return
          }

          if (event.type === 'terminal.removed') {
            throw new CliError(
              `Terminal ${terminalId} was removed while waiting`,
              5,
              'TERMINAL_REMOVED',
              { terminalId, condition }
            )
          }

          if (event.type === 'terminal.metadata') {
            const metadata = parseTerminalRuntimeMetadata(event.data)
            if (!metadata || !observation) {
              throw new CliError(
                'Treeport daemon sent invalid terminal metadata',
                3,
                'DAEMON_PROTOCOL_ERROR'
              )
            }

            observation = { ...observation, metadata }
          } else {
            observation = await inspectTerminal(terminalId, controller.signal)
            if (cancellation) {
              throw new Error('Terminal wait cancelled')
            }
          }

          const result = matched(event.at)
          if (result) {
            finish(result)
          }
        })
      )
      events!.on('connect_error', (error) =>
        fail(
          new CliError(
            `Cannot reach Treeport daemon at ${apiUrl}: ${error.message}`,
            3,
            'DAEMON_UNREACHABLE'
          )
        )
      )
      events!.on('disconnect', () =>
        fail(
          new CliError(
            'Treeport daemon event channel disconnected before the condition was observed',
            3,
            'DAEMON_DISCONNECTED'
          )
        )
      )
      events!.connect()
    })
  } catch (error) {
    if (cancellation === 'timeout') {
      throw new CliError(
        `Timed out waiting for terminal ${terminalId} to reach ${condition}`,
        4,
        'WAIT_TIMEOUT',
        {
          terminalId,
          until: condition,
          timeoutMs,
          lastObservation: observation
        }
      )
    }

    if (cancellation === 'interrupt') {
      throw new CliError('Interrupted', 130, 'INTERRUPTED')
    }

    if (error instanceof CliError) {
      throw error
    }

    throw new CliError(
      `Treeport daemon event channel failed: ${error instanceof Error ? error.message : String(error)}`,
      3,
      'DAEMON_DISCONNECTED'
    )
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }

    process.off('SIGINT', interrupt)
    controller.abort()
    events?.removeAllListeners()
    events?.disconnect()
  }
}

function print(value: unknown, human?: () => string): void {
  if (jsonOutput) {
    console.log(JSON.stringify(value))
  } else {
    console.log(human ? human() : JSON.stringify(value, null, 2))
  }
}

const agentGuidance = `AI agents:
  If you're an AI agent, use \`treeport skills\` to see the usage guide.
`

async function main(args: string[]): Promise<void> {
  const argv =
    args[0] === 'spawn' || (args[0] === 'terminal' && args[1] === 'create')
      ? commandArgv(args)
      : undefined
  let parserError = ''
  const program = new Command()
    .name('treeport')
    .usage('[options] [folder] [command]')
    .description('Manage Treeport projects, worktrees, and terminals.')
    .argument('[folder]', 'folder inside a Git repository to open')
    .option('--json', 'emit machine-readable JSON')
    .addHelpText('beforeAll', agentGuidance)
    .configureOutput({
      writeErr: (value) => {
        parserError += value
      }
    })
    .showHelpAfterError()
    .exitOverride()

  program.action(async (folder: string | undefined) => {
    if (folder === undefined) {
      process.stdout.write(program.helpInformation())
      return
    }

    const absoluteFolder = path.resolve(folder)
    const folderStatus = await fs
      .stat(absoluteFolder)
      .catch((error: unknown) => {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined
        if (code === 'ENOENT') {
          throw new CliError(
            `Folder does not exist: ${absoluteFolder}`,
            5,
            'FOLDER_NOT_FOUND',
            { path: absoluteFolder }
          )
        }

        throw new CliError(
          `Cannot access folder ${absoluteFolder}: ${error instanceof Error ? error.message : String(error)}`,
          5,
          'FOLDER_UNREADABLE',
          { path: absoluteFolder }
        )
      })
    if (!folderStatus.isDirectory()) {
      throw new CliError(
        `Path is not a folder: ${absoluteFolder}`,
        5,
        'FOLDER_NOT_DIRECTORY',
        { path: absoluteFolder }
      )
    }

    const canonicalFolder = await fs
      .realpath(absoluteFolder)
      .catch((error: unknown) => {
        throw new CliError(
          `Cannot access folder ${absoluteFolder}: ${error instanceof Error ? error.message : String(error)}`,
          5,
          'FOLDER_UNREADABLE',
          { path: absoluteFolder }
        )
      })

    if ((await resolveDaemonLifecycle()) === 'external') {
      if (!(await daemonHealth(apiUrl))) {
        throw new CliError(
          `Cannot reach the externally managed Treeport daemon at ${apiUrl}. Start it through the process that owns its lifecycle and retry.`,
          3,
          'DAEMON_UNREACHABLE'
        )
      }
    } else {
      await daemonUp({})
    }

    const registered = await request<{ project: ProjectRecord }>(
      '/api/projects',
      {
        method: 'POST',
        body: JSON.stringify({ path: canonicalFolder })
      }
    ).catch((error: unknown) => {
      if (error instanceof CliError && error.code === 'NOT_A_GIT_REPOSITORY') {
        throw new CliError(
          `No Git repository contains ${canonicalFolder}.`,
          error.exitCode,
          error.code,
          error.details
        )
      }

      throw error
    })
    const targetWorktree = registered.project.worktrees
      .filter(
        (worktree) =>
          worktree.status === 'active' &&
          !worktree.prunable &&
          pathContains(canonicalFolder, worktree.path)
      )
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (!targetWorktree) {
      throw new CliError(
        `Git did not report an active worktree containing ${canonicalFolder}.`,
        5,
        'WORKTREE_NOT_FOUND',
        { path: canonicalFolder, projectId: registered.project.id }
      )
    }

    const target = new URL(apiUrl)
    target.pathname = `/projects/${encodeURIComponent(registered.project.id)}/worktrees/${encodeURIComponent(targetWorktree.id)}`
    target.search = ''
    target.hash = ''
    const opened = await openWorkspace(target.href).catch((error: unknown) => {
      if (error instanceof OpenWorkspaceError) {
        throw new CliError(error.message, 1, 'OPEN_FAILED', {
          url: target.href
        })
      }

      throw error
    })
    const result = {
      projectId: registered.project.id,
      worktreeId: targetWorktree.id,
      path: canonicalFolder,
      url: target.href,
      client: opened.client
    }
    print(
      result,
      () =>
        `Opened ${registered.project.name} / ${targetWorktree.name} in the ${opened.client === 'desktop' ? 'Treeport desktop app' : 'browser'}\n${target.href}`
    )
  })

  const upCommand = program
    .command('up')
    .description('Ensure the local Treeport daemon is running')
    .option('--host <address>', 'listener address')
    .option('--port <port>', 'listener port')
    .option('--foreground', 'run in the foreground')
    .option('--json', 'emit machine-readable JSON')
  upCommand.action(async () => {
    if ((await resolveDaemonLifecycle()) === 'external') {
      throw new CliError(
        'Cannot run `treeport up` because the daemon lifecycle is externally managed. Control the process that started Treeport instead.',
        5,
        'DAEMON_LIFECYCLE_EXTERNAL'
      )
    }

    const options = upCommand.opts<{
      host?: string
      port?: string
      foreground?: boolean
    }>()
    const port = options.port === undefined ? undefined : Number(options.port)
    const result = await daemonUp({
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(port === undefined ? {} : { port }),
      ...(options.foreground === undefined
        ? {}
        : { foreground: options.foreground })
    })
    if (options.foreground) {
      return
    }

    print(result, () => `Treeport is up\n${result.apiUrl}`)
    const listenerHost = new URL(result.apiUrl).hostname
    if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(listenerHost)) {
      process.stderr.write(
        'Warning: Treeport has no authentication. Use only a trusted private network.\n'
      )
    }
  })

  const downCommand = program
    .command('down')
    .description('Stop the local daemon and preserve terminal sessions')
    .option(
      '--terminate-terminals',
      'terminate every Treeport-owned tmux server'
    )
    .option('--force', 'confirm termination of all terminals')
    .option('--json', 'emit machine-readable JSON')
  downCommand.action(async () => {
    if ((await resolveDaemonLifecycle()) === 'external') {
      throw new CliError(
        'Cannot run `treeport down` because the daemon lifecycle is externally managed. Control the process that started Treeport instead.',
        5,
        'DAEMON_LIFECYCLE_EXTERNAL'
      )
    }

    const options = downCommand.opts<{
      terminateTerminals?: boolean
      force?: boolean
    }>()
    if (options.terminateTerminals && !options.force) {
      throw new CliError(
        'Re-run with --terminate-terminals --force to confirm termination of every terminal.',
        2
      )
    }

    if (options.terminateTerminals) {
      await request('/api/admin/terminate-terminals', { method: 'POST' })
    }

    const result = await daemonDown()
    print(result, () =>
      result.wasRunning ? 'Treeport is down' : 'Treeport is already down'
    )
  })

  const remoteCommand = program
    .command('remote')
    .description('Expose Treeport privately through Tailscale Serve')
  remoteCommand.action(() => {
    process.stdout.write(remoteCommand.helpInformation())
  })

  const remoteEnableCommand = remoteCommand
    .command('enable')
    .description('Enable private HTTPS access through Tailscale')
    .option('--port <port>', 'Tailscale HTTPS port (default: 8733)')
    .option('--json', 'emit machine-readable JSON')
  remoteEnableCommand.action(async () => {
    if ((await resolveDaemonLifecycle()) === 'external') {
      throw new CliError(
        'Cannot run `treeport remote enable` because the daemon lifecycle is externally managed. Configure remote access through the process that started Treeport instead.',
        5,
        'DAEMON_LIFECYCLE_EXTERNAL'
      )
    }

    const options = remoteEnableCommand.opts<{ port?: string }>()
    const port = options.port === undefined ? undefined : Number(options.port)
    if (
      port !== undefined &&
      (!Number.isInteger(port) || port < 1 || port > 65_535)
    ) {
      throw new CliError('--port must be an integer between 1 and 65535', 2)
    }

    const result = await enableTailscaleRemote(
      port === undefined ? {} : { port }
    )
    print(
      result,
      () =>
        `Treeport remote access is ${result.alreadyEnabled ? 'already enabled' : 'enabled'}\n${result.url}\nAccess is limited by your Tailscale policy.`
    )
  })

  const remoteStatusCommand = remoteCommand
    .command('status')
    .description('Show Tailscale remote access status')
    .option('--json', 'emit machine-readable JSON')
  remoteStatusCommand.action(async () => {
    const result = await tailscaleRemoteStatus()
    print(result, () => {
      if (!result.configured) {
        return 'Treeport remote access is disabled'
      }

      return result.active
        ? `Treeport remote access is enabled\n${result.url}`
        : `Treeport remote access is unavailable\nExpected: ${result.url}\nThe Tailscale Serve route no longer points to Treeport.`
    })
  })

  const remoteDisableCommand = remoteCommand
    .command('disable')
    .description('Disable Treeport Tailscale remote access')
    .option('--json', 'emit machine-readable JSON')
  remoteDisableCommand.action(async () => {
    const result = await disableTailscaleRemote()
    print(result, () => {
      if (result.changedTailscale) {
        return 'Treeport remote access is disabled'
      }

      return result.wasEnabled
        ? 'Treeport remote access is disabled'
        : 'Treeport remote access was already disabled; the current Tailscale route was left unchanged.'
    })
  })

  const statusCommand = program
    .command('status')
    .description('Show local daemon status')
    .option('--json', 'emit machine-readable JSON')
  statusCommand.action(async () => {
    const status = await daemonStatus()
    const projectList = status.verified ? await projects() : []
    const result = {
      ...status,
      projects: projectList.length,
      worktrees: projectList.reduce(
        (count, project) => count + project.worktrees.length,
        0
      ),
      terminals: projectList.reduce(
        (count, project) =>
          count +
          project.worktrees.reduce(
            (worktreeCount, worktree) =>
              worktreeCount + worktree.terminals.length,
            0
          ),
        0
      )
    }
    print(result, () => {
      if (!status.state) {
        return 'Treeport is down'
      }

      if (!status.running || !status.verified) {
        return `Treeport is unhealthy (PID ${status.state.pid})\nLogs: ${path.join(status.state.dataDir, 'logs', 'daemon.log')}`
      }

      return `Treeport is up\n${status.state.apiUrl}\nVersion: ${status.health?.version}\nPID: ${status.state.pid}\nProjects: ${result.projects}\nWorktrees: ${result.worktrees}\nTerminals: ${result.terminals}`
    })
  })

  const logsCommand = program
    .command('logs')
    .description('Show recent daemon logs')
    .option('--lines <count>', 'number of lines', '100')
  logsCommand.action(async () => {
    const lines = Number(logsCommand.opts<{ lines: string }>().lines)
    if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) {
      throw new CliError('--lines must be an integer between 1 and 10000', 2)
    }

    process.stdout.write(await readDaemonLogs(lines))
  })

  const doctorCommand = program
    .command('doctor')
    .description('Diagnose local requirements and paths')
    .option('--json', 'emit machine-readable JSON')
  doctorCommand.action(async () => {
    const checks = await runDoctor()
    print(checks, () =>
      checks
        .map(
          (check) =>
            `${check.ok ? 'ok' : 'error'}\t${check.name}\t${check.detail}`
        )
        .join('\n')
    )
    if (checks.some((check) => !check.ok)) {
      process.exitCode = 1
    }
  })

  const versionCommand = program
    .command('version')
    .description('Show CLI and daemon versions')
    .option('--json', 'emit machine-readable JSON')
  versionCommand.action(async () => {
    const [cli, status] = await Promise.all([treeportVersion(), daemonStatus()])
    const result = {
      cli,
      daemon: status.verified ? (status.health?.version ?? null) : null
    }
    print(
      result,
      () => `CLI: ${result.cli}\nDaemon: ${result.daemon ?? 'not running'}`
    )
  })

  const skillsCommand = program
    .command('skills')
    .description('Print the Treeport usage guide for AI agents')
  skillsCommand.action(async () => {
    const skill = await fs.readFile(
      await resolvePackagePath('skills', 'treeport', 'SKILL.md'),
      'utf8'
    )
    process.stdout.write(
      (await resolveDaemonLifecycle()) === 'external'
        ? skill.replace(
            '\n# Treeport\n',
            '\n# Treeport\n\n> **Externally managed daemon lifecycle:** Do not run `treeport up`, `treeport down`, or `treeport remote enable`. The process that started Treeport owns startup, shutdown, remote exposure, and logs. Other Treeport commands continue to use the configured daemon normally.\n'
          )
        : skill
    )
  })

  const contextCommand = program
    .command('context')
    .description('Show the current Treeport-managed terminal context')
    .option('--json', 'emit machine-readable JSON')
  contextCommand.action(async () => {
    const projectId = contextProjectId
    const worktreeId = contextWorktreeId
    const terminalId = contextTerminalId
    const presentIds = [projectId, worktreeId, terminalId].filter(Boolean)
    if (!presentIds.length) {
      const context: TreeportContext = {
        managed: false,
        reason: 'outside_treeport'
      }
      print(context, () => 'Not running in a Treeport-managed terminal.')
      return
    }

    const missing = [
      ...(!configuredApiUrl ? [`${contextPrefix}_API_URL`] : []),
      ...(!projectId ? [`${contextPrefix}_PROJECT_ID`] : []),
      ...(!worktreeId ? [`${contextPrefix}_WORKTREE_ID`] : []),
      ...(!terminalId ? [`${contextPrefix}_TERMINAL_ID`] : [])
    ]
    if (missing.length) {
      throw new CliError(
        `Incomplete Treeport context; missing ${missing.join(', ')}`,
        5,
        'TREEPORT_CONTEXT_INCOMPLETE',
        { missing }
      )
    }

    const project = (
      await request<{ project: ProjectRecord }>(
        `/api/projects/${encodeURIComponent(projectId!)}`
      )
    ).project
    const worktree = project.worktrees.find(
      (candidate) => candidate.id === worktreeId
    )
    if (!worktree) {
      throw new CliError(
        'Treeport context worktree does not belong to the current project',
        5,
        'TREEPORT_CONTEXT_INVALID',
        { projectId, worktreeId }
      )
    }

    const terminal = worktree.terminals.find(
      (candidate) => candidate.id === terminalId
    )
    if (!terminal) {
      throw new CliError(
        'Treeport context terminal does not belong to the current worktree',
        5,
        'TREEPORT_CONTEXT_INVALID',
        { worktreeId, terminalId }
      )
    }

    const context: TreeportContext = {
      managed: true,
      apiUrl,
      daemonLifecycle: await resolveDaemonLifecycle(),
      project: {
        id: project.id,
        name: project.name,
        repositoryPath: project.repositoryPath,
        mainWorktreePath: project.mainWorktreePath,
        defaultBranch: project.defaultBranch,
        availability: project.availability
      },
      worktree: {
        id: worktree.id,
        projectId: worktree.projectId,
        name: worktree.name,
        path: worktree.path,
        head: worktree.head,
        branch: worktree.branch,
        detached: worktree.detached,
        kind: worktree.kind,
        status: worktree.status
      },
      terminal: {
        id: terminal.id,
        worktreeId: terminal.worktreeId,
        name: terminal.name,
        status: terminal.status,
        exitCode: terminal.exitCode
      }
    }
    print(
      context,
      () =>
        `Treeport context\n\nProject:  ${context.project.name} (${context.project.id})\nWorktree: ${context.worktree.name} (${context.worktree.id})\nPath:     ${context.worktree.path}\nTerminal: ${context.terminal.name} (${context.terminal.id}) — ${context.terminal.status}\nAPI:      ${context.apiUrl}\nLifecycle: ${context.daemonLifecycle === 'external' ? 'externally managed' : 'managed by Treeport'}`
    )
  })

  const installCommand = program
    .command('install')
    .description('Install and configure a Treeport package')
    .argument('<source>', 'npm: source or local directory')
    .option(
      '-l, --local',
      'configure the registered project containing the current directory'
    )
    .option('--json', 'emit machine-readable JSON')
  installCommand.action(async (source: string) => {
    const options = installCommand.opts<{ local?: boolean }>()
    const result = (
      await request<{ result: PackageOperationResult }>(
        '/api/packages/install',
        {
          method: 'POST',
          body: JSON.stringify({
            source: await packageSource(source),
            ...(options.local
              ? { projectId: await localPackageProjectId() }
              : {})
          })
        }
      )
    ).result
    print(
      result,
      () =>
        `Installed ${result.source}${result.scope === 'project' ? ` for project ${result.projectId}` : ' globally'}`
    )
  })

  const removePackageCommand = program
    .command('remove')
    .alias('uninstall')
    .description('Remove a configured Treeport package')
    .argument('<source>', 'npm: source or local directory')
    .option(
      '-l, --local',
      'remove from the registered project containing the current directory'
    )
    .option('--json', 'emit machine-readable JSON')
  removePackageCommand.action(async (source: string) => {
    const options = removePackageCommand.opts<{ local?: boolean }>()
    const result = (
      await request<{ result: PackageOperationResult }>(
        '/api/packages/remove',
        {
          method: 'POST',
          body: JSON.stringify({
            source: await packageSource(source),
            ...(options.local
              ? { projectId: await localPackageProjectId() }
              : {})
          })
        }
      )
    ).result
    print(result, () => `Removed ${result.source}`)
  })

  const listPackagesCommand = program
    .command('list')
    .description('List configured Treeport packages')
    .option('--json', 'emit machine-readable JSON')
  listPackagesCommand.action(async () => {
    const result = await request<{
      packages: PackageListing[]
      diagnostics: PackageResourceDiagnostic[]
    }>('/api/packages')
    print(result, () => {
      const lines = result.packages.map((pkg) => {
        const scope =
          pkg.scope === 'global'
            ? 'global'
            : `project:${pkg.projectName ?? pkg.projectId}`
        return `${scope}\t${pkg.source}\t${pkg.resources.webPanels} web panels, ${pkg.resources.terminalPresets} terminal presets`
      })
      lines.push(
        ...result.diagnostics.map(
          (item) =>
            `error\t${item.scope}\t${item.source ?? item.path ?? 'settings'}\t${item.message}`
        )
      )
      return lines.join('\n')
    })
  })

  const updatePackagesCommand = program
    .command('update')
    .description('Explicitly update configured Treeport packages')
    .argument('[source]', 'one configured npm: source')
    .option('--packages', 'update every eligible configured package')
    .option('--json', 'emit machine-readable JSON')
  updatePackagesCommand.action(async (source: string | undefined) => {
    const options = updatePackagesCommand.opts<{ packages?: boolean }>()
    if ((!source && !options.packages) || (source && options.packages)) {
      throw new CliError(
        'Specify a package source or --packages. Bare `treeport update` is reserved for a future Treeport self-update.',
        2
      )
    }

    const results = (
      await request<{ results: PackageOperationResult[] }>(
        '/api/packages/update',
        {
          method: 'POST',
          body: JSON.stringify(
            source ? { source: await packageSource(source) } : {}
          )
        }
      )
    ).results
    print(results, () =>
      results
        .map(
          (result) =>
            `${result.status}\t${result.scope}\t${result.source ?? 'packages'}${result.reason ? `\t${result.reason}` : ''}`
        )
        .join('\n')
    )
  })

  const reloadCommand = program
    .command('reload')
    .description('Reload package settings and resources without restarting')
    .option(
      '-l, --local',
      'reload only the registered project containing the current directory'
    )
    .option('--json', 'emit machine-readable JSON')
  reloadCommand.action(async () => {
    const options = reloadCommand.opts<{ local?: boolean }>()
    const result = await request<{
      results: PackageOperationResult[]
      diagnostics: PackageResourceDiagnostic[]
    }>('/api/packages/reload', {
      method: 'POST',
      body: JSON.stringify(
        options.local ? { projectId: await localPackageProjectId() } : {}
      )
    })
    print(result, () => {
      const lines = [
        ...result.results.map(
          (item) =>
            `Reloaded ${item.scope === 'global' ? 'global packages' : `project ${item.projectId}`}`
        ),
        ...result.diagnostics.map(
          (item) =>
            `Error: ${item.source ?? item.path ?? item.scope}: ${item.message}`
        )
      ]
      return lines.join('\n')
    })
  })

  const projectCommand = program
    .command('project')
    .description('Register and list projects')
  projectCommand.action(() => {
    throw new CliError(projectCommand.helpInformation(), 2)
  })

  const projectAddCommand = projectCommand
    .command('add')
    .description('Register a Git repository')
    .argument('<path>', 'repository path')
    .option('--json', 'emit machine-readable JSON')
  projectAddCommand.action(async (repository: string) => {
    const body = await request<{ project: ProjectRecord }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: await canonical(repository) })
    })
    print(
      body.project,
      () =>
        `Registered ${body.project.name} (${body.project.id})\n${body.project.repositoryPath}`
    )
  })

  const projectListCommand = projectCommand
    .command('list')
    .description('List registered projects')
    .option('--json', 'emit machine-readable JSON')
  projectListCommand.action(async () => {
    const list = await projects()
    print(list, () =>
      list
        .map(
          (project) =>
            `${project.id}\t${project.name}\t${project.repositoryPath}`
        )
        .join('\n')
    )
  })

  const worktreeCommand = program
    .command('worktree')
    .description('List, create, and remove worktrees')
  worktreeCommand.action(() => {
    throw new CliError(worktreeCommand.helpInformation(), 2)
  })

  const worktreeListCommand = worktreeCommand
    .command('list')
    .description('List discovered worktrees')
    .option('--project <id-or-path>', 'limit results to a project')
    .option('--json', 'emit machine-readable JSON')
  worktreeListCommand.action(async () => {
    const { project: projectIdentifier } = worktreeListCommand.opts<{
      project?: string
    }>()
    const list = projectIdentifier
      ? (await resolveProject(projectIdentifier)).worktrees
      : (await projects()).flatMap((project) => project.worktrees)
    print(list, () =>
      list
        .map(
          (worktree) =>
            `${worktree.id}\t${worktree.name}\t${worktree.branch ?? `detached@${worktree.head.slice(0, 8)}`}\t${worktree.status}\t${worktree.path}`
        )
        .join('\n')
    )
  })

  const worktreeCreateCommand = worktreeCommand
    .command('create')
    .description('Create a linked worktree')
    .requiredOption('--project <id-or-path>', 'project to create from')
    .requiredOption('--name <name>', 'worktree name')
    .option('--from-current', 'base the worktree on the current worktree')
    .option('--json', 'emit machine-readable JSON')
  worktreeCreateCommand.action(async () => {
    const options = worktreeCreateCommand.opts<{
      project: string
      name: string
      fromCurrent?: boolean
    }>()
    const project = await resolveProject(options.project)
    const sourceWorktreeId = options.fromCurrent
      ? (await resolveWorktree('.')).id
      : undefined
    const result = await createWorktree(project.id, {
      name: options.name,
      base: options.fromCurrent ? 'current' : 'default',
      ...(sourceWorktreeId ? { sourceWorktreeId } : {})
    })
    print(
      result,
      () =>
        `Created ${result.worktree.name} (${result.worktree.id})\n${result.worktree.path}${result.setupError ? `\nSetup error: ${result.setupError}` : ''}`
    )
  })

  const worktreeRemoveCommand = worktreeCommand
    .command('remove')
    .description('Remove a linked worktree')
    .argument('<id-or-path-or-dot>', 'worktree to remove')
    .option('--force', 'confirm destructive removal warnings')
    .option('--json', 'emit machine-readable JSON')
  worktreeRemoveCommand.action(async (identifier: string) => {
    const { force: confirmed } = worktreeRemoveCommand.opts<{
      force?: boolean
    }>()
    const worktree = await resolveWorktree(identifier)
    const preview = (
      await request<{ preview: RemovePreview }>(
        `/api/worktrees/${worktree.id}/remove-preview`
      )
    ).preview
    if (!preview.eligible) {
      throw new CliError(preview.reasons.join('\n'), 5)
    }

    if (preview.warnings.length && !confirmed) {
      throw new CliError(
        `${preview.warnings.join('\n')}\nRe-run with --force to confirm removal.`,
        5
      )
    }

    const result = await request<{ operation: { id: string } }>(
      `/api/worktrees/${worktree.id}/remove`,
      {
        method: 'POST',
        body: JSON.stringify({
          confirmationToken: preview.confirmationToken,
          confirmDestructive: preview.warnings.length > 0
        })
      }
    )
    print(result.operation, () => `Remove accepted: ${result.operation.id}`)
  })

  const terminalCommand = program
    .command('terminal')
    .description('Manage persistent worktree terminals')
  terminalCommand.action(() => {
    throw new CliError(terminalCommand.helpInformation(), 2)
  })

  const terminalListCommand = terminalCommand
    .command('list')
    .description('List terminals')
    .option('--worktree <id-or-path>', 'limit results to a worktree')
    .option('--json', 'emit machine-readable JSON')
  terminalListCommand.action(async () => {
    const { worktree: identifier } = terminalListCommand.opts<{
      worktree?: string
    }>()
    const list: TerminalRecord[] = identifier
      ? (await resolveWorktree(identifier)).terminals
      : (await projects()).flatMap((project) =>
          project.worktrees.flatMap((worktree) => worktree.terminals)
        )
    print(list, () =>
      list
        .map(
          (terminal) =>
            `${terminal.id}\t${terminal.name}\t${terminal.status}\t${JSON.stringify(terminal.argv)}`
        )
        .join('\n')
    )
  })

  const terminalCreateCommand = terminalCommand
    .command('create')
    .description('Create a persistent terminal')
    .usage('[options] [-- <command> args...]')
    .requiredOption('--worktree <id-or-path-or-dot>', 'owning worktree')
    .requiredOption('--name <name>', 'terminal name')
    .option('--json', 'emit machine-readable JSON')
    .addHelpText('after', '\nCommand arguments may be passed after --.\n')
  terminalCreateCommand.action(async () => {
    const options = terminalCreateCommand.opts<{
      worktree: string
      name: string
    }>()
    const worktree = await resolveWorktree(options.worktree)
    const result = await request<{ terminal: TerminalRecord }>(
      `/api/worktrees/${worktree.id}/terminals`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: options.name,
          ...(argv ? { argv } : {})
        })
      }
    )
    print(
      result.terminal,
      () => `Created ${result.terminal.name} (${result.terminal.id})`
    )
  })

  const terminalInspectCommand = terminalCommand
    .command('inspect')
    .description('Inspect terminal status and runtime metadata')
    .argument('<terminal-id-or-dot>', 'terminal to inspect')
    .option('--json', 'emit machine-readable JSON')
  terminalInspectCommand.action(async (identifier: string) => {
    const observation = await inspectTerminal(resolveTerminalId(identifier))
    print(observation, () => {
      const { terminal, metadata } = observation
      const progress = metadata.progress
        ? `working (${metadata.progress.state}${metadata.progress.value === null ? '' : ` ${metadata.progress.value}%`})`
        : 'idle'
      const status =
        terminal.status === 'exited'
          ? `exited${terminal.exitCode === null ? '' : ` (${terminal.exitCode})`}`
          : terminal.status
      return `Terminal: ${terminal.name} (${terminal.id})\nStatus:   ${status}\nTitle:    ${metadata.title ?? '—'}\nProgress: ${progress}\nStarted:  ${metadata.progressStartedAt ?? '—'}\nCleared:  ${metadata.progressClearedAt ?? '—'}\nBell:     ${metadata.bell ? `${metadata.bell.at} (#${metadata.bell.sequence})` : '—'}`
    })
  })

  const terminalCaptureCommand = terminalCommand
    .command('capture')
    .description('Capture recent terminal output')
    .argument('<terminal-id-or-dot>', 'terminal to capture')
    .option('--lines <count>', 'number of lines to capture')
    .option('--json', 'emit machine-readable JSON')
  terminalCaptureCommand.action(async (identifier: string) => {
    const { lines: rawLines } = terminalCaptureCommand.opts<{
      lines?: string
    }>()
    const lines =
      rawLines === undefined
        ? TERMINAL_CAPTURE_DEFAULT_LINES
        : parseCaptureLines(rawLines)
    const terminalId = resolveTerminalId(identifier)
    const capture = await request<TerminalCapture>(
      `/api/terminals/${encodeURIComponent(terminalId)}/capture?lines=${lines}`
    )
    if (jsonOutput) {
      print(capture)
    } else {
      process.stdout.write(capture.content)

      if (capture.content && !capture.content.endsWith('\n')) {
        process.stdout.write('\n')
      }
    }
  })

  const terminalWaitCommand = terminalCommand
    .command('wait')
    .description('Wait for a terminal runtime condition')
    .argument('<terminal-id-or-dot>', 'terminal to observe')
    .requiredOption('--until <idle|working|bell|exit>', 'condition to wait for')
    .option('--timeout <duration>', 'maximum wait, such as 30s or 5m')
    .option('--json', 'emit machine-readable JSON')
  terminalWaitCommand.action(async (identifier: string) => {
    const options = terminalWaitCommand.opts<{
      until: string
      timeout?: string
    }>()
    if (!['idle', 'working', 'bell', 'exit'].includes(options.until)) {
      throw new CliError(
        '--until must be one of idle, working, bell, or exit',
        2
      )
    }

    const result = await waitForTerminal(
      resolveTerminalId(identifier),
      options.until as WaitCondition,
      options.timeout === undefined ? undefined : parseDuration(options.timeout)
    )
    print(
      result,
      () =>
        `${result.terminal.name} (${result.terminal.id}) reached ${result.condition} at ${result.observedAt}`
    )
  })

  const terminalDeleteCommand = terminalCommand
    .command('delete')
    .description('Delete a terminal')
    .argument('<terminal-id>', 'terminal to delete')
    .option('--json', 'emit machine-readable JSON')
  terminalDeleteCommand.action(async (terminalId: string) => {
    await request(`/api/terminals/${terminalId}`, { method: 'DELETE' })
    print({ ok: true, terminalId }, () => `Deleted ${terminalId}`)
  })

  const spawnCommand = program
    .command('spawn')
    .description('Create a worktree and its first terminal')
    .usage('[options] [-- <command> args...]')
    .requiredOption('--project <id-or-path-or-dot>', 'project to create from')
    .requiredOption('--worktree-name <name>', 'worktree name')
    .requiredOption('--name <terminal-name>', 'terminal name')
    .option('--from-current', 'base the worktree on the current worktree')
    .option('--json', 'emit machine-readable JSON')
    .addHelpText('after', '\nCommand arguments may be passed after --.\n')
  spawnCommand.action(async () => {
    const options = spawnCommand.opts<{
      project: string
      worktreeName: string
      name: string
      fromCurrent?: boolean
    }>()
    const project = await resolveProject(options.project)
    const sourceWorktreeId = options.fromCurrent
      ? (await resolveWorktree('.')).id
      : undefined
    const result = await createWorktree(project.id, {
      name: options.worktreeName,
      base: options.fromCurrent ? 'current' : 'default',
      initialTerminal: {
        name: options.name,
        ...(argv ? { argv } : {})
      },
      ...(sourceWorktreeId ? { sourceWorktreeId } : {})
    })
    print(
      result,
      () =>
        `Created worktree ${result.worktree.name} (${result.worktree.id})\nPath: ${result.worktree.path}\n${result.terminal ? `Terminal: ${result.terminal.name} (${result.terminal.id}) — ${result.terminal.status}` : 'Terminal: not created'}${result.setupError ? `\nSetup error: ${result.setupError}` : ''}${result.terminalError ? `\nTerminal error: ${result.terminalError}` : ''}`
    )
  })

  try {
    await program.parseAsync(args, { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        return
      }

      throw new CliError(parserError.trim() || error.message, 2, 'USAGE_ERROR')
    }

    throw error
  }
}

main(rawArgs).catch((error: unknown) => {
  const cliError =
    error instanceof CliError
      ? error
      : new CliError(error instanceof Error ? error.message : String(error), 1)
  if (jsonOutput) {
    const body: ApiErrorBody = {
      error: {
        code: cliError.code,
        message: cliError.message,
        ...(cliError.details === undefined ? {} : { details: cliError.details })
      }
    }
    process.stderr.write(`${JSON.stringify(body)}\n`)
  } else {
    process.stderr.write(`${cliError.message}\n`)
  }

  process.exitCode = cliError.exitCode
})
