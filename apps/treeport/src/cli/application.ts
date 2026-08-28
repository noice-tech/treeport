#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { Command, CommanderError } from 'commander'
import { io, type Socket } from 'socket.io-client'
import {
  parseEventsSnapshot,
  parseProductEvent,
  SOCKET_IO_PATH,
  TERMINAL_CAPTURE_DEFAULT_LINES,
  TERMINAL_CAPTURE_MAX_LINES,
  WEB_PANEL_INPUT_MAX_BYTES,
  webPanelInputSchema,
  type ApiErrorBody,
  type BrowserPanel,
  type CreateOperationRequest,
  type EventsClientToServerEvents,
  type EventsServerToClientEvents,
  type PackageListing,
  type PackageOperationResult,
  type PackageResourceDiagnostic,
  type OpenBrowserPanelResult,
  type OpenWebPanelResult,
  type OperationRecord,
  type ProjectRecord,
  type RemovePreview,
  type TreeportContext,
  type TerminalCapture,
  type TerminalRecord,
  type TerminalRuntimeMetadata,
  type WebPanelDefinition,
  type WebPanelInput,
  type WorktreeRecord
} from '@treeport/shared'
import { parseDurationMs } from '../duration.js'
import { extractJsonOutput } from './args.js'
import { OpenWorkspaceError, openWorkspace } from './open.js'
import {
  LocalUpdateError,
  runLocalUpdate,
  type LocalUpdateOptions
} from './update.js'
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
import {
  readServiceLogs,
  serviceApply,
  serviceDisable,
  serviceDoctorCheck,
  serviceEnable,
  serviceInstalled,
  serviceRun,
  serviceStart,
  serviceStatus,
  serviceStop,
  type ServiceStatus
} from './service.js'

const contextPrefix = 'TREEPORT'
let configuredApiUrl: string | undefined
let apiUrl = ''
let contextProjectId: string | undefined
let contextWorktreeId: string | undefined
let contextTerminalId: string | undefined
let configuredDaemonLifecycle: string | undefined
let jsonOutput = false
let workingDirectory = process.cwd()
let writeStdout: (value: string) => void = (value) => {
  process.stdout.write(value)
}
let writeStderr: (value: string) => void = (value) => {
  process.stderr.write(value)
}
let requestedExitCode = 0
let cliEnvironment: NodeJS.ProcessEnv = process.env

interface PackageMutationBody {
  source: string
  projectId?: string
}

interface TerminalCreateBody {
  name: string
  argv?: string[]
}

export interface CliApplicationOptions {
  args: string[]
  environment?: NodeJS.ProcessEnv
  cwd?: string
  stdout?: (value: string) => void
  stderr?: (value: string) => void
}

class CliError<Details = undefined> extends Error {
  readonly code: string
  readonly details: Details | undefined

  constructor(
    message: string,
    readonly exitCode: number,
    code?: string,
    details?: Details
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

async function resolveDaemonLifecycle(): Promise<
  'treeport' | 'service' | 'external'
> {
  if (configuredDaemonLifecycle === 'external') {
    return 'external'
  }

  if (configuredDaemonLifecycle === 'service') {
    return 'service'
  }

  if (configuredApiUrl) {
    const observed = await daemonHealth(apiUrl)
    if (observed) {
      return observed.daemonLifecycle
    }
  }

  return (await serviceInstalled()) ? 'service' : 'treeport'
}

function formatServiceStatus(status: ServiceStatus): string {
  const mode =
    status.mode === 'headless'
      ? 'advanced headless (starts before login)'
      : status.mode === 'user' && status.manager === 'launchd'
        ? 'user/login (starts after login)'
        : status.mode === 'user'
          ? 'user service'
          : 'not installed'
  const lines = [
    `Treeport service: ${status.state}`,
    `Mode: ${mode}`,
    `Manager: ${status.manager ?? 'unsupported'}`,
    `Starts before login: ${status.enabledAtBoot ? 'yes' : 'no'}`,
    `Active: ${status.active ? 'yes' : 'no'}`,
    `Definition: ${status.definitionPath ?? 'not installed'}`
  ]
  if (status.daemon?.state) {
    lines.push(`PID: ${status.daemon.state.pid}`)
  }

  if (status.issues.length) {
    lines.push(...status.issues.map((issue) => `Issue: ${issue}`))
  }

  if (status.administratorCommand) {
    lines.push(
      'Administrator action required:',
      status.administratorCommand,
      'Then run: treeport service status'
    )
  } else if (status.recoveryCommands.length) {
    lines.push(`Next: ${status.recoveryCommands[0]}`)
  }

  return lines.join('\n')
}

async function ensureServiceDaemon(): Promise<{
  apiUrl: string
  pid: number
}> {
  const result = await serviceStart()
  const state = result.status.daemon?.state
  if (state && result.status.healthy) {
    return { apiUrl: state.apiUrl, pid: state.pid }
  }

  if (result.administratorCommand) {
    throw new CliError(
      `An administrator must start the Treeport service:\n${result.administratorCommand}`,
      5,
      'SERVICE_ADMINISTRATOR_ACTION_REQUIRED',
      result
    )
  }

  if (!state || !result.status.healthy) {
    throw new CliError(
      'The Treeport service did not become healthy. Run `treeport service status`.',
      3,
      'DAEMON_UNREACHABLE',
      result.status
    )
  }

  return { apiUrl: state.apiUrl, pid: state.pid }
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
    const headers = new Headers({ accept: 'application/json' })
    if (options.body) {
      headers.set('content-type', 'application/json')
    }

    new Headers(options.headers).forEach((value, key) =>
      headers.set(key, value)
    )
    const response = await fetch(`${apiUrl}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers
    })
    // SAFETY: The validated CLI or Node contract establishes this asserted value.
    const body = (await response.json().catch(() => ({}))) as T | ApiErrorBody
    if (!response.ok) {
      // SAFETY: The validated CLI or Node contract establishes this asserted value.
      const error = (body as ApiErrorBody).error
      throw new CliError(
        error?.message || `HTTP ${response.status}`,
        5,
        error?.code || 'API_ERROR',
        error?.details
      )
    }

    // SAFETY: The validated CLI or Node contract establishes this asserted value.
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
  input: CreateOperationRequest
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
      operation.error ?? 'Tree creation failed',
      5,
      'WORKTREE_CREATION_FAILED'
    )
  }

  if (operation.kind !== 'create') {
    throw new CliError(
      'Tree creation returned an unexpected operation kind',
      5,
      'INVALID_OPERATION_RESULT'
    )
  }

  const worktreeId = operation.result?.worktreeId ?? operation.worktreeId
  if (!worktreeId) {
    throw new CliError(
      'Completed tree creation did not identify its tree',
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
      `Created tree ${worktreeId} was not found`,
      5,
      'INVALID_OPERATION_RESULT'
    )
  }

  const terminalId = operation.result?.terminalId ?? null

  return {
    worktree,
    terminal: worktree.terminals.find((item) => item.id === terminalId) ?? null,
    terminalError: operation.result?.terminalError ?? null,
    setupError: operation.result?.setupError ?? null
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
  const resolved = path.resolve(workingDirectory, value)
  return fs.realpath(resolved).catch(() => resolved)
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

async function resolveProject(identifier?: string): Promise<ProjectRecord> {
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

  const candidate = await canonical(identifier ?? '.')
  const match = list
    .flatMap((project) =>
      [project.rootPath, ...project.worktrees.map((item) => item.path)].map(
        (root) => ({ project, root })
      )
    )
    .filter(({ root }) => pathContains(candidate, root))
    .sort((left, right) => right.root.length - left.root.length)[0]?.project
  if (!match) {
    throw new CliError(
      identifier === undefined
        ? `No registered project contains ${candidate}. Specify --project <id-or-path>.`
        : `No registered project matches ${identifier}`,
      5
    )
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
  const search = new URLSearchParams({
    path: await canonical(workingDirectory)
  })
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
    throw new CliError(`No registered tree matches ${identifier}`, 5)
  }

  return match
}

function parseWebPanelInput(value: string | undefined): WebPanelInput | null {
  if (value === undefined) {
    return null
  }

  if (Buffer.byteLength(value) > WEB_PANEL_INPUT_MAX_BYTES) {
    throw new CliError('Web panel input is limited to 64 KiB', 2)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new CliError(
      `--input must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      2
    )
  }

  const validated = webPanelInputSchema.safeParse(parsed)
  if (!validated.success) {
    throw new CliError('--input must contain a JSON object', 2)
  }

  return validated.data
}

async function webPanelDefinition(
  worktreeId: string,
  identifier: string
): Promise<WebPanelDefinition> {
  const definitions = (
    await request<{ definitions: WebPanelDefinition[] }>(
      `/api/worktrees/${encodeURIComponent(worktreeId)}/web-panel-definitions`
    )
  ).definitions
  const exact = definitions.find((definition) => definition.id === identifier)
  if (exact) {
    return exact
  }

  const matches = definitions.filter(
    (definition) =>
      decodeURIComponent(definition.id.split(':').at(-1) ?? '') === identifier
  )
  if (matches.length === 1) {
    return matches[0]!
  }

  if (matches.length > 1) {
    throw new CliError(
      `Web panel name ${identifier} is ambiguous: ${matches.map((match) => match.id).join(', ')}`,
      5,
      'WEB_PANEL_DEFINITION_AMBIGUOUS',
      { definitionIds: matches.map((match) => match.id) }
    )
  }

  throw new CliError(
    `Web panel ${identifier} is not available in this tree`,
    5,
    'WEB_PANEL_DEFINITION_NOT_FOUND'
  )
}

async function webPanelLaunchCwd(worktree: WorktreeRecord): Promise<string> {
  const [cwd, worktreeRoot] = await Promise.all([
    canonical(workingDirectory),
    canonical(worktree.path)
  ])
  if (!pathContains(cwd, worktreeRoot)) {
    throw new CliError(
      `The current directory is outside tree ${worktree.name}`,
      5,
      'INVALID_WEB_PANEL_LAUNCH_CWD',
      { cwd, worktreeId: worktree.id, worktreePath: worktree.path }
    )
  }

  return path.relative(worktreeRoot, cwd) || '.'
}

async function resolveBrowserPanel(
  panelId?: string
): Promise<{ panel: BrowserPanel; worktree: WorktreeRecord }> {
  const projectList = await projects()
  const candidates = projectList.flatMap((project) =>
    project.worktrees.flatMap((worktree) =>
      worktree.panels
        .filter((panel): panel is BrowserPanel => panel.kind === 'browser')
        .map((panel) => ({ panel, worktree }))
    )
  )
  if (panelId) {
    const match = candidates.find((candidate) => candidate.panel.id === panelId)
    if (!match) {
      throw new CliError(`Browser ${panelId} was not found`, 5)
    }

    return match
  }

  const worktree = await resolveWorktree('.')
  const matches = candidates.filter(
    (candidate) => candidate.worktree.id === worktree.id
  )
  if (matches.length === 1) {
    return matches[0]!
  }

  if (matches.length === 0) {
    throw new CliError(
      `No Browser is open in worktree ${worktree.name}`,
      5,
      'BROWSER_PANEL_NOT_FOUND'
    )
  }

  throw new CliError(
    `More than one Browser is open in worktree ${worktree.name}; specify --panel`,
    5,
    'BROWSER_PANEL_AMBIGUOUS',
    { panelIds: matches.map((candidate) => candidate.panel.id) }
  )
}

async function runBrowserAgentCommand(
  command: string,
  args: string[],
  panelId?: string
): Promise<{ panelId: string; output: string }> {
  const { panel } = await resolveBrowserPanel(panelId)
  const result = await request<{ output: string }>(
    `/api/panels/${encodeURIComponent(panel.id)}/browser-agent`,
    {
      method: 'POST',
      body: JSON.stringify({ command, args })
    }
  )
  return { panelId: panel.id, output: result.output }
}

function panelUrl(worktree: WorktreeRecord, panelId: string): string {
  const target = new URL(apiUrl)
  target.pathname = `/projects/${encodeURIComponent(worktree.projectId)}/worktrees/${encodeURIComponent(worktree.id)}/panels/${encodeURIComponent(panelId)}`
  target.search = ''
  target.hash = ''
  return target.href
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
      const fail = (cause: unknown) => {
        if (!settled) {
          settled = true
          reject(cause)
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
            const { worktreeId: _worktreeId, ...metadata } = event.data
            if (!observation) {
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

function print<Value>(value: Value, human?: () => string): void {
  writeStdout(
    `${jsonOutput ? JSON.stringify(value) : human ? human() : JSON.stringify(value, null, 2)}\n`
  )
}

async function main(args: string[]): Promise<void> {
  const argv =
    args[0] === 'spawn' || (args[0] === 'terminal' && args[1] === 'create')
      ? commandArgv(args)
      : undefined
  let parserError = ''
  const program = new Command()
    .name('treeport')
    .usage('[options] [folder] [command]')
    .description('Manage Treeport projects, trees, and terminals.')
    .argument('[folder]', 'folder or folder inside a Git repository to open')
    .option('--json', 'emit machine-readable JSON')
    .configureOutput({
      writeOut: writeStdout,
      writeErr: (value) => {
        parserError += value
      }
    })
    .showHelpAfterError()
    .exitOverride()

  program.action(async (folder: string | undefined) => {
    if (folder === undefined) {
      writeStdout(program.helpInformation())
      return
    }

    const absoluteFolder = path.resolve(workingDirectory, folder)
    const folderStatus = await fs.stat(absoluteFolder).catch((error) => {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
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

    const canonicalFolder = await fs.realpath(absoluteFolder).catch((error) => {
      throw new CliError(
        `Cannot access folder ${absoluteFolder}: ${error instanceof Error ? error.message : String(error)}`,
        5,
        'FOLDER_UNREADABLE',
        { path: absoluteFolder }
      )
    })

    const lifecycle = await resolveDaemonLifecycle()
    if (lifecycle === 'external') {
      if (!(await daemonHealth(apiUrl))) {
        throw new CliError(
          `Cannot reach the externally managed Treeport daemon at ${apiUrl}. Start it through the process that owns its lifecycle and retry.`,
          3,
          'DAEMON_UNREACHABLE'
        )
      }
    } else if (lifecycle === 'service') {
      await ensureServiceDaemon()
    } else {
      await daemonUp({})
    }

    const registered = await request<{ project: ProjectRecord }>(
      '/api/projects',
      {
        method: 'POST',
        body: JSON.stringify({ path: canonicalFolder })
      }
    )
    const targetWorktree = registered.project.worktrees
      .filter(
        (worktree) =>
          !worktree.prunable && pathContains(canonicalFolder, worktree.path)
      )
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (!targetWorktree) {
      throw new CliError(
        `Treeport did not find a workspace containing ${canonicalFolder}.`,
        5,
        'WORKTREE_NOT_FOUND',
        { path: canonicalFolder, projectId: registered.project.id }
      )
    }

    const target = new URL(apiUrl)
    target.pathname = `/projects/${encodeURIComponent(registered.project.id)}/worktrees/${encodeURIComponent(targetWorktree.id)}`
    target.search = ''
    target.hash = ''
    // ponytail: Managed commands assume a client shows the source terminal. Add request acknowledgements if background commands must open another client.
    const opened = contextTerminalId
      ? await request(
          `/api/worktrees/${encodeURIComponent(targetWorktree.id)}/open`,
          {
            method: 'POST',
            body: JSON.stringify({ sourceTerminalId: contextTerminalId })
          }
        ).then(() => ({ client: 'current' as const }))
      : await openWorkspace(target.href).catch((error) => {
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
      projectKind: registered.project.kind,
      url: target.href,
      client: opened.client
    }
    print(
      result,
      () =>
        `Opened ${registered.project.name} / ${targetWorktree.name} in the ${opened.client === 'desktop' ? 'Treeport desktop app' : opened.client === 'current' ? 'current Treeport client' : 'browser'}\n${target.href}`
    )
  })

  const startCommand = program
    .command('start')
    .description('Ensure the local Treeport daemon is running')
    .option('--host <address>', 'loopback listener address')
    .option('--port <port>', 'listener port')
    .option('--foreground', 'run in the foreground')
    .option('--json', 'emit machine-readable JSON')
  startCommand.action(async () => {
    const lifecycle = await resolveDaemonLifecycle()
    if (lifecycle === 'external') {
      throw new CliError(
        'Cannot run `treeport start` because the daemon lifecycle is externally managed. Control the process that started Treeport instead.',
        5,
        'DAEMON_LIFECYCLE_EXTERNAL'
      )
    }

    const options = startCommand.opts<{
      host?: string
      port?: string
      foreground?: boolean
    }>()
    if (lifecycle === 'service') {
      if (options.foreground || options.host || options.port) {
        throw new CliError(
          'An installed service owns the listener and process mode. Run `treeport service enable` to refresh its configuration, or `treeport service disable` to return to local background mode.',
          5,
          'DAEMON_LIFECYCLE_SERVICE'
        )
      }

      const result = await serviceStart()
      print(result, () => formatServiceStatus(result.status))
      if (result.administratorCommand || !result.status.healthy) {
        requestedExitCode = 1
      }

      return
    }

    const port = options.port === undefined ? undefined : Number(options.port)
    const daemonOptions: Parameters<typeof daemonUp>[0] = {}
    if (options.host !== undefined) {
      daemonOptions.host = options.host
    }

    if (port !== undefined) {
      daemonOptions.port = port
    }

    if (options.foreground !== undefined) {
      daemonOptions.foreground = options.foreground
    }

    const result = await daemonUp(daemonOptions)
    if (options.foreground) {
      return
    }

    print(result, () => `Treeport is running\n${result.apiUrl}`)
  })

  const stopCommand = program
    .command('stop')
    .description('Stop the local daemon and preserve terminal sessions')
    .option(
      '--terminate-terminals',
      'terminate every Treeport-owned tmux server'
    )
    .option('--force', 'confirm termination of all terminals')
    .option('--json', 'emit machine-readable JSON')
  stopCommand.action(async () => {
    const lifecycle = await resolveDaemonLifecycle()
    if (lifecycle === 'external') {
      throw new CliError(
        'Cannot run `treeport stop` because the daemon lifecycle is externally managed. Control the process that started Treeport instead.',
        5,
        'DAEMON_LIFECYCLE_EXTERNAL'
      )
    }

    const options = stopCommand.opts<{
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

    if (lifecycle === 'service') {
      const result = await serviceStop()
      print(result, () => formatServiceStatus(result.status))
      if (result.administratorCommand) {
        requestedExitCode = 1
      }

      return
    }

    const result = await daemonDown()
    print(result, () =>
      result.wasRunning ? 'Treeport is stopped' : 'Treeport is already stopped'
    )
  })

  const serviceCommand = program
    .command('service')
    .description('Manage opt-in OS service supervision')
  serviceCommand.action(() => {
    writeStdout(serviceCommand.helpInformation())
  })

  const serviceEnableCommand = serviceCommand
    .command('enable')
    .description('Enable automatic startup and unexpected-exit restarts')
    .option(
      '--headless',
      'use advanced macOS startup before login (requires an administrator)'
    )
    .option('--json', 'emit machine-readable JSON')
  serviceEnableCommand.action(async () => {
    const options = serviceEnableCommand.opts<{ headless?: boolean }>()
    const result = await serviceEnable(options.headless ? 'headless' : 'user')
    print(result, () => formatServiceStatus(result.status))
    if (result.status.state === 'action_required') {
      requestedExitCode = 1
    }
  })

  const serviceStatusCommand = serviceCommand
    .command('status')
    .description('Show OS service supervision status')
    .option('--json', 'emit machine-readable JSON')
  serviceStatusCommand.action(async () => {
    const result = await serviceStatus()
    print(result, () => formatServiceStatus(result))
    if (
      !['disabled', 'healthy', 'stopped'].includes(result.state) ||
      !result.supported
    ) {
      requestedExitCode = 1
    }
  })

  const serviceDisableCommand = serviceCommand
    .command('disable')
    .description('Stop and unregister OS service supervision')
    .option('--json', 'emit machine-readable JSON')
  serviceDisableCommand.action(async () => {
    const result = await serviceDisable()
    print(result, () => formatServiceStatus(result.status))
    if (result.administratorCommand || result.status.state !== 'disabled') {
      requestedExitCode = 1
    }
  })

  serviceCommand
    .command('run', { hidden: true })
    .action(async () => serviceRun())

  const serviceApplyCommand = serviceCommand
    .command('apply', { hidden: true })
    .requiredOption('--request <absolute-path>', 'prepared request')
  serviceApplyCommand.action(async () => {
    const { request: requestPath } = serviceApplyCommand.opts<{
      request: string
    }>()
    const result = await serviceApply(requestPath)
    print(result, () => `Applied Treeport service ${result.operation} request.`)
  })

  const remoteCommand = program
    .command('remote')
    .description('Expose Treeport privately through Tailscale Serve')
  remoteCommand.action(() => {
    writeStdout(remoteCommand.helpInformation())
  })

  const remoteEnableCommand = remoteCommand
    .command('enable')
    .description('Enable private HTTPS access through Tailscale')
    .option('--port <port>', 'Tailscale HTTPS port (default: 8733)')
    .option('--json', 'emit machine-readable JSON')
  remoteEnableCommand.action(async () => {
    const lifecycle = await resolveDaemonLifecycle()
    if (lifecycle === 'external') {
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

    const serviceDaemon =
      lifecycle === 'service' ? await ensureServiceDaemon() : undefined
    const remoteOptions: Parameters<typeof enableTailscaleRemote>[0] = {}
    if (port !== undefined) {
      remoteOptions.port = port
    }

    if (serviceDaemon !== undefined) {
      remoteOptions.daemon = serviceDaemon
    }

    const result = await enableTailscaleRemote(remoteOptions)
    print(
      result,
      () =>
        `Treeport remote access is ${result.alreadyEnabled ? 'already enabled' : 'enabled'}\n${result.url}\nTailscale authenticates each remote user. Access is limited by your Tailscale policy.`
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
    const supervision = (await serviceInstalled())
      ? await serviceStatus()
      : null
    const projectList = status.verified ? await projects() : []
    const result = {
      ...status,
      service: supervision,
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
        return supervision
          ? formatServiceStatus(supervision)
          : 'Treeport is stopped'
      }

      if (!status.running || !status.verified) {
        return `Treeport is unhealthy (PID ${status.state.pid})\nLogs: ${path.join(status.state.dataDir, 'logs', 'daemon.log')}`
      }

      return `Treeport is running\n${status.state.apiUrl}\nLifecycle: ${status.health?.daemonLifecycle}\nVersion: ${status.health?.version}\nPID: ${status.state.pid}\nProjects: ${result.projects}\nTrees: ${result.worktrees}\nTerminals: ${result.terminals}`
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

    writeStdout(
      (await serviceInstalled())
        ? await readServiceLogs(lines)
        : await readDaemonLogs(lines)
    )
  })

  const doctorCommand = program
    .command('doctor')
    .description('Diagnose local requirements and paths')
    .option('--json', 'emit machine-readable JSON')
  doctorCommand.action(async () => {
    const checks = [...(await runDoctor()), await serviceDoctorCheck()]
    print(checks, () =>
      checks
        .map(
          (check) =>
            `${check.ok ? 'ok' : 'error'}\t${check.name}\t${check.detail}`
        )
        .join('\n')
    )
    if (checks.some((check) => !check.ok)) {
      requestedExitCode = 1
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
    writeStdout(
      (await resolveDaemonLifecycle()) === 'external'
        ? skill.replace(
            '\n# Treeport\n',
            '\n# Treeport\n\n> **Externally managed daemon lifecycle:** Do not run `treeport start`, `treeport stop`, or `treeport remote enable`. The process that started Treeport owns startup, shutdown, remote exposure, and logs. Other Treeport commands continue to use the configured daemon normally.\n'
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
        'Treeport context tree does not belong to the current project',
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
        'Treeport context terminal does not belong to the current tree',
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
        kind: project.kind,
        rootPath: project.rootPath,
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
        kind: worktree.kind
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
        `Treeport context\n\nProject:  ${context.project.name} (${context.project.id})\nTree:     ${context.worktree.name} (${context.worktree.id})\nPath:     ${context.worktree.path}\nTerminal: ${context.terminal.name} (${context.terminal.id}) — ${context.terminal.status}\nAPI:      ${context.apiUrl}\nLifecycle: ${context.daemonLifecycle === 'external' ? 'externally managed' : context.daemonLifecycle === 'service' ? 'managed by the OS service' : 'managed by Treeport'}`
    )
  })

  const browserCommand = program
    .command('browser')
    .description('Manage Browser and its hosted Chromium')
  browserCommand.action(() => {
    writeStdout(browserCommand.helpInformation())
  })

  const browserOpenCommand = browserCommand
    .command('open')
    .description('Open Browser and request client navigation')
    .argument('[url]', 'absolute HTTP or HTTPS URL')
    .requiredOption('--worktree <id-or-path-or-dot>', 'owning tree')
    .option('--json', 'emit machine-readable JSON')
  browserOpenCommand.action(async (url?: string) => {
    const worktree = await resolveWorktree(
      browserOpenCommand.opts<{ worktree: string }>().worktree
    )
    const body = {
      url,
      sourceTerminalId:
        contextWorktreeId === worktree.id ? (contextTerminalId ?? null) : null
    }

    const result = await request<OpenBrowserPanelResult>(
      `/api/worktrees/${encodeURIComponent(worktree.id)}/browser-panels`,
      { method: 'POST', body: JSON.stringify(body) }
    )
    const output = {
      ...result,
      url: panelUrl(worktree, result.panel.id)
    }
    print(
      output,
      () => `Opened ${result.panel.title} (${result.panel.id})\n${output.url}`
    )
  })

  const browserInstallCommand = browserCommand
    .command('install')
    .description('Install the Chromium build used by Browser')
    .option('--json', 'emit machine-readable JSON')
  browserInstallCommand.action(async () => {
    const result = await request<{ message: string }>('/api/browser/install', {
      method: 'POST'
    })
    print(result, () => result.message)
  })

  const browserStatusCommand = browserCommand
    .command('status')
    .description('Show hosted browser installation status')
    .option('--json', 'emit machine-readable JSON')
  browserStatusCommand.action(async () => {
    const result = await request<{
      installed: boolean
      executablePath: string
      playwrightVersion: string
      browserRevision: string
      channel: 'chromium'
      launchReady: boolean
      launchError: string | null
    }>('/api/browser/status')
    print(
      result,
      () =>
        `${result.installed ? 'Chromium is installed' : 'Chromium is not installed'}\nLaunch ready: ${result.launchReady ? 'yes' : 'no'}\nPlaywright: ${result.playwrightVersion}\nBrowser: ${result.channel} ${result.browserRevision}\nExecutable: ${result.executablePath}${result.launchError ? `\nLaunch error: ${result.launchError}` : ''}`
    )
  })

  const browserRemoveCommand = browserCommand
    .command('remove')
    .description("Remove Treeport's hosted Chromium build")
    .option('--json', 'emit machine-readable JSON')
  browserRemoveCommand.action(async () => {
    await request('/api/browser/install', { method: 'DELETE' })
    print({ removed: true }, () => 'Removed Treeport hosted Chromium')
  })

  const browserListCommand = browserCommand
    .command('list')
    .description('List open Browser sessions')
    .option('--json', 'emit machine-readable JSON')
  browserListCommand.action(async () => {
    const panels = (await projects()).flatMap((project) =>
      project.worktrees.flatMap((worktree) =>
        worktree.panels
          .filter((panel): panel is BrowserPanel => panel.kind === 'browser')
          .map((panel) => ({
            panelId: panel.id,
            title: panel.title,
            worktreeId: worktree.id,
            worktree: worktree.name,
            projectId: project.id,
            project: project.name
          }))
      )
    )
    print(panels, () =>
      panels.length
        ? panels
            .map(
              (panel) =>
                `${panel.panelId}\t${panel.project} / ${panel.worktree}\t${panel.title}`
            )
            .join('\n')
        : 'Browser is not open.'
    )
  })

  const printAgentResult = async (
    command: string,
    args: string[],
    panelId?: string
  ) => {
    const result = await runBrowserAgentCommand(command, args, panelId)
    print(result, () => result.output)
  }

  const browserSnapshotCommand = browserCommand
    .command('snapshot')
    .description('Capture an accessibility snapshot of the hosted page')
    .option('--panel <panel-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')
  browserSnapshotCommand.action(async () =>
    printAgentResult(
      'snapshot',
      [],
      browserSnapshotCommand.opts<{ panel?: string }>().panel
    )
  )

  const browserClickCommand = browserCommand
    .command('click')
    .description('Click an element from the latest browser snapshot')
    .argument('<target>', 'Playwright element reference or selector')
    .option('--panel <panel-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')
  browserClickCommand.action(async (target: string) =>
    printAgentResult(
      'click',
      [target],
      browserClickCommand.opts<{ panel?: string }>().panel
    )
  )

  const browserFillCommand = browserCommand
    .command('fill')
    .description('Fill an editable element from the latest browser snapshot')
    .argument('<target>', 'Playwright element reference or selector')
    .argument('<text>', 'text to enter')
    .option('--panel <panel-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')
  browserFillCommand.action(async (target: string, text: string) =>
    printAgentResult(
      'fill',
      [target, text],
      browserFillCommand.opts<{ panel?: string }>().panel
    )
  )

  const browserPressCommand = browserCommand
    .command('press')
    .description('Press a key in the hosted page')
    .argument('<key>', 'Playwright key name')
    .option('--panel <panel-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')
  browserPressCommand.action(async (key: string) =>
    printAgentResult(
      'press',
      [key],
      browserPressCommand.opts<{ panel?: string }>().panel
    )
  )

  const browserGotoCommand = browserCommand
    .command('goto')
    .description('Navigate the hosted page')
    .argument('<url>', 'absolute HTTP or HTTPS URL')
    .option('--panel <panel-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')
  browserGotoCommand.action(async (url: string) =>
    printAgentResult(
      'goto',
      [url],
      browserGotoCommand.opts<{ panel?: string }>().panel
    )
  )

  const browserConsoleCommand = browserCommand
    .command('console')
    .description('List page console messages')
    .argument('[level]', 'minimum console level')
    .option('--panel <panel-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')
  browserConsoleCommand.action(async (level?: string) =>
    printAgentResult(
      'console',
      level ? [level] : [],
      browserConsoleCommand.opts<{ panel?: string }>().panel
    )
  )

  for (const [name, description, agentName] of [
    ['back', 'Go back in the hosted page', 'go-back'],
    ['forward', 'Go forward in the hosted page', 'go-forward'],
    ['reload', 'Reload the hosted page', 'reload'],
    ['network', 'List page network requests', 'requests'],
    ['screenshot', 'Capture a screenshot of the hosted page', 'screenshot']
  ] as const) {
    const command = browserCommand
      .command(name)
      .description(description)
      .option('--panel <panel-id>', 'Browser ID')
      .option('--json', 'emit machine-readable JSON')
    command.action(async () =>
      printAgentResult(agentName, [], command.opts<{ panel?: string }>().panel)
    )
  }

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
    const body: PackageMutationBody = {
      source: await packageSource(source)
    }
    if (options.local) {
      body.projectId = await localPackageProjectId()
    }

    const result = (
      await request<{ result: PackageOperationResult }>(
        '/api/packages/install',
        { method: 'POST', body: JSON.stringify(body) }
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
    const body: PackageMutationBody = {
      source: await packageSource(source)
    }
    if (options.local) {
      body.projectId = await localPackageProjectId()
    }

    const result = (
      await request<{ result: PackageOperationResult }>(
        '/api/packages/remove',
        { method: 'POST', body: JSON.stringify(body) }
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
    .description('Update Treeport or explicitly update configured packages')
    .argument('[source]', 'one configured npm: source')
    .option('--packages', 'update every eligible configured package')
    .option('--json', 'emit machine-readable JSON')
  updatePackagesCommand.action(async (source: string | undefined) => {
    const options = updatePackagesCommand.opts<{ packages?: boolean }>()
    if (source && options.packages) {
      throw new CliError('Specify a package source or --packages, not both.', 2)
    }

    if (!source && !options.packages) {
      if ((await resolveDaemonLifecycle()) === 'external') {
        throw new CliError(
          'Cannot update Treeport because this daemon lifecycle is externally managed.',
          5,
          'UPDATE_EXTERNAL_REFUSED'
        )
      }

      const selfUpdateOptions: LocalUpdateOptions = {
        environment: cliEnvironment
      }
      if (!jsonOutput) {
        selfUpdateOptions.progress = (message) => writeStderr(`${message}\n`)
      }

      const result = await runLocalUpdate(selfUpdateOptions).catch((error) => {
        if (error instanceof LocalUpdateError) {
          throw new CliError(
            error.message,
            error.exitCode,
            error.code,
            error.details
          )
        }

        throw error
      })
      print(result, () => {
        if (result.status === 'current') {
          return `Treeport ${result.toVersion} is current`
        }

        return result.daemon.wasRunning
          ? `Updated Treeport from ${result.fromVersion} to ${result.toVersion} and restarted the ${result.daemon.lifecycle === 'service' ? 'service' : 'daemon'}`
          : `Updated Treeport from ${result.fromVersion} to ${result.toVersion}; Treeport remains stopped`
      })
      return
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
    .description('Register a folder or Git repository')
    .argument('<path>', 'folder path')
    .option('--json', 'emit machine-readable JSON')
  projectAddCommand.action(async (repository: string) => {
    const body = await request<{ project: ProjectRecord }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: await canonical(repository) })
    })
    print(
      body.project,
      () =>
        `Registered ${body.project.name} (${body.project.id})\n${body.project.rootPath}`
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
            `${project.id}\t${project.name}\t${project.kind}\t${project.rootPath}`
        )
        .join('\n')
    )
  })

  const worktreeCommand = program
    .command('worktree')
    .description('List, create, and remove trees')
  worktreeCommand.action(() => {
    throw new CliError(worktreeCommand.helpInformation(), 2)
  })

  const worktreeListCommand = worktreeCommand
    .command('list')
    .description('List discovered trees')
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
            `${worktree.id}\t${worktree.name}\t${worktree.kind === 'folder' ? 'folder' : (worktree.branch ?? `detached@${worktree.head.slice(0, 8)}`)}\t${worktree.path}`
        )
        .join('\n')
    )
  })

  const worktreeCreateCommand = worktreeCommand
    .command('create')
    .description('Create a linked tree')
    .option(
      '--project <id-or-path>',
      'project to create from (default: current folder)'
    )
    .requiredOption('--name <name>', 'Tree name')
    .option('--from-current', 'base the tree on the current tree')
    .option('--json', 'emit machine-readable JSON')
  worktreeCreateCommand.action(async () => {
    const options = worktreeCreateCommand.opts<{
      project?: string
      name: string
      fromCurrent?: boolean
    }>()
    const project = await resolveProject(options.project)
    const sourceWorktreeId = options.fromCurrent
      ? (await resolveWorktree('.')).id
      : undefined
    const request: CreateOperationRequest = {
      name: options.name,
      base: options.fromCurrent ? 'current' : 'default'
    }
    if (sourceWorktreeId) {
      request.sourceWorktreeId = sourceWorktreeId
    }

    const result = await createWorktree(project.id, request)
    print(
      result,
      () =>
        `Created tree ${result.worktree.name} (${result.worktree.id})\n${result.worktree.path}${result.setupError ? `\nSetup error: ${result.setupError}` : ''}`
    )
  })

  const worktreeRemoveCommand = worktreeCommand
    .command('remove')
    .description('Remove a linked tree')
    .argument('<id-or-path-or-dot>', 'Tree to remove')
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

    let operation = (
      await request<{ operation: OperationRecord }>(
        `/api/worktrees/${worktree.id}/remove`,
        {
          method: 'POST',
          body: JSON.stringify({
            confirmationToken: preview.confirmationToken,
            confirmDestructive: preview.warnings.length > 0
          })
        }
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
        operation.error ?? 'Tree removal failed',
        5,
        'WORKTREE_REMOVAL_FAILED'
      )
    }

    if (operation.kind !== 'remove' || !operation.result) {
      throw new CliError(
        'Tree removal returned an unexpected operation result',
        5,
        'INVALID_OPERATION_RESULT'
      )
    }

    print(operation.result, () => {
      const warning = operation.result?.cleanup.warning
      return `Removed tree ${worktree.name} (${worktree.id})${warning ? `\nWarning: ${warning}` : ''}`
    })
  })

  const webPanelCommand = program
    .command('web-panel')
    .description('Open persistent web panels')
  webPanelCommand.action(() => {
    throw new CliError(webPanelCommand.helpInformation(), 2)
  })

  const webPanelOpenCommand = webPanelCommand
    .command('open')
    .description('Create or reuse a web panel and request client navigation')
    .argument('<definition>', 'definition ID or unique short name')
    .requiredOption('--worktree <id-or-path-or-dot>', 'owning tree')
    .option('--input <json>', 'structured panel input as a JSON object')
    .option('--new', 'create a separate panel instance')
    .option('--json', 'emit machine-readable JSON')
  webPanelOpenCommand.action(async (identifier: string) => {
    const options = webPanelOpenCommand.opts<{
      worktree: string
      input?: string
      new?: boolean
    }>()
    const worktree = await resolveWorktree(options.worktree)
    const definition = await webPanelDefinition(worktree.id, identifier)
    const result = await request<OpenWebPanelResult>(
      `/api/worktrees/${encodeURIComponent(worktree.id)}/panels/open`,
      {
        method: 'POST',
        body: JSON.stringify({
          definitionId: definition.id,
          input: parseWebPanelInput(options.input),
          launchCwd: await webPanelLaunchCwd(worktree),
          newInstance: options.new ?? false,
          sourceTerminalId: contextTerminalId ?? null
        })
      }
    )
    const output = {
      ...result,
      url: panelUrl(worktree, result.panel.id)
    }
    print(
      output,
      () =>
        `${result.reused ? 'Reused' : 'Opened'} ${result.panel.title} (${result.panel.id})\n${output.url}`
    )
  })

  const terminalCommand = program
    .command('terminal')
    .description('Manage persistent tree terminals')
  terminalCommand.action(() => {
    throw new CliError(terminalCommand.helpInformation(), 2)
  })

  const terminalListCommand = terminalCommand
    .command('list')
    .description('List terminals')
    .option('--worktree <id-or-path>', 'limit results to a tree')
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
    .requiredOption('--worktree <id-or-path-or-dot>', 'owning tree')
    .requiredOption('--name <name>', 'terminal name')
    .option('--json', 'emit machine-readable JSON')
    .addHelpText('after', '\nCommand arguments may be passed after --.\n')
  terminalCreateCommand.action(async () => {
    const options = terminalCreateCommand.opts<{
      worktree: string
      name: string
    }>()
    const worktree = await resolveWorktree(options.worktree)
    const body: TerminalCreateBody = { name: options.name }
    if (argv) {
      body.argv = argv
    }

    const result = await request<{ terminal: TerminalRecord }>(
      `/api/worktrees/${worktree.id}/terminals`,
      { method: 'POST', body: JSON.stringify(body) }
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
      writeStdout(capture.content)

      if (capture.content && !capture.content.endsWith('\n')) {
        writeStdout('\n')
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
      // SAFETY: The validated CLI or Node contract establishes this asserted value.
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
    .description('Create a tree and its first terminal')
    .usage('[options] [-- <command> args...]')
    .option(
      '--project <id-or-path-or-dot>',
      'project to create from (default: current folder)'
    )
    .requiredOption('--worktree-name <name>', 'Tree name')
    .requiredOption('--name <terminal-name>', 'terminal name')
    .option('--from-current', 'base the tree on the current tree')
    .option('--json', 'emit machine-readable JSON')
    .addHelpText('after', '\nCommand arguments may be passed after --.\n')
  spawnCommand.action(async () => {
    const options = spawnCommand.opts<{
      project?: string
      worktreeName: string
      name: string
      fromCurrent?: boolean
    }>()
    const project = await resolveProject(options.project)
    const sourceWorktreeId = options.fromCurrent
      ? (await resolveWorktree('.')).id
      : undefined
    const initialTerminal: NonNullable<
      CreateOperationRequest['initialTerminal']
    > = { name: options.name }
    if (argv) {
      initialTerminal.argv = argv
    }

    const request: CreateOperationRequest = {
      name: options.worktreeName,
      base: options.fromCurrent ? 'current' : 'default',
      initialTerminal
    }
    if (sourceWorktreeId) {
      request.sourceWorktreeId = sourceWorktreeId
    }

    const result = await createWorktree(project.id, request)
    print(
      result,
      () =>
        `Created tree ${result.worktree.name} (${result.worktree.id})\nPath: ${result.worktree.path}\n${result.terminal ? `Terminal: ${result.terminal.name} (${result.terminal.id}) — ${result.terminal.status}` : 'Terminal: not created'}${result.setupError ? `\nSetup error: ${result.setupError}` : ''}${result.terminalError ? `\nTerminal error: ${result.terminalError}` : ''}`
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

export async function runCliApplication(
  options: CliApplicationOptions
): Promise<number> {
  const environment = options.environment ?? process.env
  cliEnvironment = environment
  configuredApiUrl = environment.TREEPORT_API_URL?.trim()
  apiUrl = (await resolveLocalApiUrl(environment)).replace(/\/$/, '')
  contextProjectId = environment.TREEPORT_PROJECT_ID?.trim() || undefined
  contextWorktreeId = environment.TREEPORT_WORKTREE_ID?.trim() || undefined
  contextTerminalId = environment.TREEPORT_TERMINAL_ID?.trim() || undefined
  configuredDaemonLifecycle = environment.TREEPORT_DAEMON_LIFECYCLE?.trim()
  jsonOutput = extractJsonOutput(options.args)
  workingDirectory = options.cwd ?? process.cwd()
  writeStdout = options.stdout ?? ((value) => process.stdout.write(value))
  writeStderr = options.stderr ?? ((value) => process.stderr.write(value))
  requestedExitCode = 0

  try {
    await main([...options.args])
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError(
            error instanceof Error ? error.message : String(error),
            1
          )
    if (jsonOutput) {
      const body: ApiErrorBody = {
        error: { code: cliError.code, message: cliError.message }
      }
      if (cliError.details !== undefined) {
        body.error.details = cliError.details
      }

      writeStderr(`${JSON.stringify(body)}\n`)
    } else {
      writeStderr(`${cliError.message}\n`)
    }

    requestedExitCode = cliError.exitCode
  }

  return requestedExitCode
}
