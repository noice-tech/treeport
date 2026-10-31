#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { Command, CommanderError } from 'commander'
import { RpcClient } from '@effect/rpc'
import {
  apiErrorBodySchema,
  availableTreeName,
  browserAgentResponseSchema,
  browserInstallResponseSchema,
  browserInstallStatusSchema,
  decodeUnknownOrNull,
  EVENT_PROTOCOL_VERSION,
  formatCommandLine,
  launcherDefinitionListingSchema,
  launcherInputNames,
  launcherResponseSchema,
  launchersResponseSchema,
  repositoryLauncherSchema,
  resolveLauncherArgs,
  resolveLauncherTreeTitle,
  TreeportRpcs,
  treeportRpcClientLayer,
  okResponseSchema,
  openBrowserAppResponseSchema,
  openWebAppResponseSchema,
  operationResponseSchema,
  packageListingResponseSchema,
  packageOperationResponseSchema,
  packageProjectResponseSchema,
  packageReloadResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  removePreviewResponseSchema,
  terminalCaptureResponseSchema,
  TERMINAL_CAPTURE_DEFAULT_LINES,
  TERMINAL_CAPTURE_MAX_LINES,
  TERMINAL_INPUT_KEYS,
  TERMINAL_INPUT_MAX_STEPS,
  TREE_DECORATION_TONES,
  terminalObservationResponseSchema,
  terminalResponseSchema,
  terminatedTerminalsResponseSchema,
  WEB_APP_INPUT_MAX_BYTES,
  webAppDefinitionsResponseSchema,
  webAppInputSchema,
  worktreeResponseSchema,
  type ApiErrorBody,
  type BrowserApp,
  type CreateOperationRequest,
  type EventsSnapshot,
  type NetworkProductEvent,
  type ProjectRecord,
  type TreeportContext,
  type TerminalAfterExit,
  type TerminalRecord,
  type TerminalRuntimeMetadata,
  type TerminalSendInput,
  type WebAppDefinition,
  type WebAppInput,
  type WorktreeRecord
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { parseDurationMs } from '../duration.js'
import { extractJsonOutput } from './args.js'
import { OpenWorkspaceError, openWorkspace } from './open.js'
import {
  daemonDown,
  daemonHealth,
  daemonStatus,
  daemonUp,
  readDaemonLogs,
  resolveLocalApiUrl,
  resolvePackagePath,
  treeportVersion
} from './lifecycle.js'
import { humanOutput, stateName } from './output.js'

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
let output = humanOutput()
let errorOutput = humanOutput()

interface PackageMutationBody {
  source: string
  projectId?: string
}

interface TerminalCreateBody {
  name: string
  command?: string
  afterExit?: TerminalAfterExit
  cwd?: string
  env?: Record<string, string>
  parentTerminalId?: string
}

export interface CliApplicationOptions {
  args: string[]
  environment?: NodeJS.ProcessEnv
  cwd?: string
  stdout?: (value: string) => void
  stderr?: (value: string) => void
  stdoutIsTTY?: boolean
  stderrIsTTY?: boolean
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

async function resolveDaemonLifecycle(): Promise<'treeport' | 'external'> {
  if (configuredDaemonLifecycle === 'external') {
    return 'external'
  }

  if (configuredApiUrl) {
    const observed = await daemonHealth(apiUrl)

    if (observed) {
      return observed.daemonLifecycle
    }
  }

  return 'treeport'
}

type MutableSchemaType<Value> = Value extends readonly (infer Item)[]
  ? MutableSchemaType<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: MutableSchemaType<Value[Key]> }
    : Value

async function request<S extends Schema.Schema<any, any, never>>(
  pathname: string,
  schema: S,
  options: RequestInit = {},
  timeoutMs = 90_000
): Promise<MutableSchemaType<Schema.Schema.Type<S>>> {
  const controller = new AbortController()
  const externalSignal = options.signal
  const abort = () => controller.abort()

  if (externalSignal?.aborted) {
    controller.abort()
  } else {
    externalSignal?.addEventListener('abort', abort, { once: true })
  }

  const timeout = setTimeout(abort, timeoutMs)

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

    const body: unknown = await response.json().catch(() => ({}))

    if (!response.ok) {
      const failure = decodeUnknownOrNull(apiErrorBodySchema, body)
      throw new CliError(
        failure?.error.message || `HTTP ${response.status}`,
        5,
        failure?.error.code || 'API_ERROR',
        failure?.error.details
      )
    }

    const decoded = decodeUnknownOrNull(schema, body)

    if (decoded === null) {
      throw new CliError(
        `Treeport daemon returned an invalid response for ${pathname}`,
        3,
        'DAEMON_PROTOCOL_ERROR',
        { pathname }
      )
    }

    // SAFETY: Effect Schema decoded the complete value above.
    return decoded as MutableSchemaType<Schema.Schema.Type<S>>
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
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktree-operations`,
      operationResponseSchema,
      { method: 'POST', body: JSON.stringify(input) }
    )
  ).operation

  while (operation.status === 'pending' || operation.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 100))
    operation = (
      await request(
        `/api/operations/${encodeURIComponent(operation.id)}`,
        operationResponseSchema
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
    await request(
      `/api/projects/${encodeURIComponent(projectId)}`,
      projectResponseSchema
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
  return (await request('/api/projects', projectsResponseSchema)).projects
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
    await request(
      `/api/packages/project?${search.toString()}`,
      packageProjectResponseSchema
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

function parseWebAppInput(value: string | undefined): WebAppInput | null {
  if (value === undefined) {
    return null
  }

  if (Buffer.byteLength(value) > WEB_APP_INPUT_MAX_BYTES) {
    throw new CliError('Web app input is limited to 64 KiB', 2)
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

  const validated = decodeUnknownOrNull(webAppInputSchema, parsed)

  if (!validated) {
    throw new CliError('--input must contain a JSON object', 2)
  }

  return validated
}

async function webAppDefinition(
  worktreeId: string,
  identifier: string
): Promise<WebAppDefinition> {
  const definitions = (
    await request(
      `/api/worktrees/${encodeURIComponent(worktreeId)}/web-app-definitions`,
      webAppDefinitionsResponseSchema
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
      `Web app name ${identifier} is ambiguous: ${matches.map((match) => match.id).join(', ')}`,
      5,
      'WEB_APP_DEFINITION_AMBIGUOUS',
      { definitionIds: matches.map((match) => match.id) }
    )
  }

  throw new CliError(
    `Web app ${identifier} is not available in this tree`,
    5,
    'WEB_APP_DEFINITION_NOT_FOUND'
  )
}

async function webAppLaunchCwd(worktree: WorktreeRecord): Promise<string> {
  const [cwd, worktreeRoot] = await Promise.all([
    canonical(workingDirectory),
    canonical(worktree.path)
  ])

  if (!pathContains(cwd, worktreeRoot)) {
    throw new CliError(
      `The current directory is outside tree ${worktree.name}`,
      5,
      'INVALID_WEB_APP_LAUNCH_CWD',
      { cwd, worktreeId: worktree.id, worktreePath: worktree.path }
    )
  }

  return path.relative(worktreeRoot, cwd) || '.'
}

async function resolveBrowserApp(
  appId?: string
): Promise<{ app: BrowserApp; worktree: WorktreeRecord }> {
  const projectList = await projects()

  const candidates = projectList.flatMap((project) =>
    project.worktrees.flatMap((worktree) =>
      worktree.workspaceItems
        .filter((app): app is BrowserApp => app.kind === 'browser')
        .map((app) => ({ app, worktree }))
    )
  )

  if (appId) {
    const match = candidates.find((candidate) => candidate.app.id === appId)

    if (!match) {
      throw new CliError(`Browser ${appId} was not found`, 5)
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
      'BROWSER_APP_NOT_FOUND'
    )
  }

  throw new CliError(
    `More than one Browser is open in worktree ${worktree.name}; specify --app`,
    5,
    'BROWSER_APP_AMBIGUOUS',
    { appIds: matches.map((candidate) => candidate.app.id) }
  )
}

async function runBrowserAgentCommand(
  command: string,
  args: string[],
  appId?: string
): Promise<{ appId: string; output: string }> {
  const { app } = await resolveBrowserApp(appId)

  const result = await request(
    `/api/apps/${encodeURIComponent(app.id)}/browser-agent`,
    browserAgentResponseSchema,
    {
      method: 'POST',
      body: JSON.stringify({ command, args })
    }
  )

  return { appId: app.id, output: result.output }
}

function appUrl(worktree: WorktreeRecord, appId: string): string {
  const target = new URL(apiUrl)
  target.pathname = `/projects/${encodeURIComponent(worktree.projectId)}/worktrees/${encodeURIComponent(worktree.id)}/apps/${encodeURIComponent(appId)}`
  target.search = ''
  target.hash = ''

  return target.href
}

const WAIT_CONDITIONS = ['idle', 'working', 'attention', 'exit'] as const

type WaitCondition = (typeof WAIT_CONDITIONS)[number]

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
  return request(
    `/api/terminals/${encodeURIComponent(terminalId)}`,
    terminalObservationResponseSchema,
    signal ? { signal } : {}
  )
}

async function waitForTerminal(
  terminalId: string,
  condition: WaitCondition,
  timeoutMs?: number
): Promise<TerminalWaitResult> {
  let observation: TerminalObservation | null = null
  let attentionBaseline: number | null = null

  const matched = (observedAt: string): TerminalWaitResult | null => {
    if (!observation) {
      return null
    }

    const matches =
      (condition === 'idle' &&
        observation.metadata.activity.state !== 'working') ||
      (condition === 'working' &&
        observation.metadata.activity.state === 'working') ||
      (condition === 'exit' &&
        (observation.terminal.commandExitCode != null ||
          observation.terminal.status === 'exited')) ||
      (condition === 'attention' &&
        attentionBaseline !== null &&
        (observation.metadata.attention?.sequence ?? 0) > attentionBaseline)

    if (!matches) {
      return null
    }

    return {
      condition,
      observedAt:
        condition === 'attention'
          ? (observation.metadata.attention?.at ?? observedAt)
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
  let events: Fiber.RuntimeFiber<void, unknown> | null = null

  try {
    observation = await inspectTerminal(terminalId, controller.signal)

    if (condition === 'attention') {
      attentionBaseline = observation.metadata.attention?.sequence ?? 0
    }

    const immediate = matched(new Date().toISOString())

    if (immediate) {
      return immediate
    }

    return await new Promise<TerminalWaitResult>((resolve, reject) => {
      let settled = false
      let connected = false
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

      const snapshot = async (value: EventsSnapshot) => {
        if (!observation) {
          throw new CliError(
            'Treeport daemon sent an invalid event snapshot',
            3,
            'DAEMON_PROTOCOL_ERROR'
          )
        }

        connected = true

        const metadata = value.terminalMetadata.find(
          (item) => item.terminalId === terminalId
        )

        if (metadata) {
          observation = { ...observation, metadata }
        }

        const snapshotMatch = matched(value.at)

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
      }

      const productEvent = async (event: NetworkProductEvent) => {
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
      }

      controller.signal.addEventListener(
        'abort',
        () => fail(new Error('Terminal wait cancelled')),
        { once: true }
      )

      const program = Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(TreeportRpcs)
          yield* client
            .WatchProjectEvents({
              protocol: EVENT_PROTOCOL_VERSION
            })
            .pipe(
              Stream.runForEach((item) =>
                Effect.sync(() => {
                  if (item._tag === 'Snapshot') {
                    enqueue(() => snapshot(item.snapshot))
                  } else {
                    enqueue(() => productEvent(item.event))
                  }
                })
              )
            )
        })
      ).pipe(
        Effect.provide(treeportRpcClientLayer(`${apiUrl}/api/rpc`)),
        Effect.onExit(() =>
          Effect.sync(() =>
            fail(
              connected
                ? new CliError(
                    'Treeport daemon event channel disconnected before the condition was observed',
                    3,
                    'DAEMON_DISCONNECTED'
                  )
                : new CliError(
                    `Cannot reach Treeport daemon at ${apiUrl}`,
                    3,
                    'DAEMON_UNREACHABLE'
                  )
            )
          )
        )
      )

      events = Effect.runFork(program)
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

    if (events) {
      Effect.runFork(Fiber.interrupt(events))
    }
  }
}

function print<Value>(value: Value, human?: () => string): void {
  writeStdout(
    `${jsonOutput ? JSON.stringify(value) : human ? human() : JSON.stringify(value, null, 2)}\n`
  )
}

async function main(args: string[]): Promise<void> {
  const argv =
    args[0] === 'spawn' ||
    (args[0] === 'terminal' && args[1] === 'create') ||
    (args[0] === 'launcher' && args[1] === 'add')
      ? commandArgv(args)
      : undefined

  let parserError = ''

  const program = new Command()
    .name('treeport')
    .usage('[options] [folder] [command]')
    .description('Manage Treeport projects, trees, and terminals.')
    .version(
      output.heading(await treeportVersion()),
      '-v, --version',
      'show installed CLI version'
    )
    .argument('[folder]', 'folder or folder inside a Git repository to open')
    .option('--json', 'emit machine-readable JSON')
    .configureOutput({
      getOutHasColors: () => output.enabled,
      getErrHasColors: () => errorOutput.enabled,
      writeOut: writeStdout,
      writeErr: (value) => {
        parserError += value
      }
    })
    .showHelpAfterError(jsonOutput)
    .configureHelp({
      styleTitle: output.heading,
      styleCommandText: output.heading
    })
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
    } else {
      await daemonUp({})
    }

    const registered = await request('/api/projects', projectResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ path: canonicalFolder })
    })

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

    const opened = contextTerminalId
      ? await request(
          `/api/worktrees/${encodeURIComponent(targetWorktree.id)}/open`,
          okResponseSchema,
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
      daemonOptions.output = output
    }

    const result = await daemonUp(daemonOptions)

    if (options.foreground) {
      return
    }

    print(result, () =>
      output.blocks(
        output.summary('Treeport is running', 'success'),
        output.rows([['URL', result.apiUrl]])
      )
    )
  })

  const stopCommand = program
    .command('stop')
    .description('Stop the local daemon and preserve terminal sessions')
    .option(
      '--terminate-terminals',
      'terminate every Treeport-owned terminal process'
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
      await request(
        '/api/admin/terminate-terminals',
        terminatedTerminalsResponseSchema,
        { method: 'POST' }
      )
    }

    const result = await daemonDown()
    print(result, () =>
      output.summary(
        result.wasRunning
          ? 'Treeport is stopped'
          : 'Treeport is already stopped',
        'success'
      )
    )
  })

  const statusCommand = program
    .command('status')
    .description('Show local daemon status')
    .option('--json', 'emit machine-readable JSON')

  statusCommand.action(async () => {
    const [cliVersion, status] = await Promise.all([
      treeportVersion(),
      daemonStatus()
    ])

    const observed = status

    const daemonVersion =
      observed.running && observed.verified
        ? (observed.health?.version ?? null)
        : null

    const projectList = status.verified ? await projects() : []

    const result = {
      ...status,
      cliVersion,
      daemonVersion,
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
      const healthy = observed.running && observed.verified

      return output.blocks(
        output.heading('Treeport status'),
        output.summary(
          !observed.state
            ? 'Treeport is stopped'
            : healthy
              ? 'Treeport is running'
              : 'Treeport is unhealthy',
          !observed.state ? 'neutral' : healthy ? 'success' : 'failure'
        ),
        output.rows([
          ['CLI version', cliVersion],
          ['Daemon version', daemonVersion ?? 'Unavailable'],
          observed.state ? ['URL', observed.state.apiUrl] : null
        ]),
        daemonVersion !== null &&
          daemonVersion !== cliVersion &&
          output.summary(
            'Version mismatch: CLI and daemon versions differ',
            'warning'
          ),
        healthy &&
          output.detail(
            output.rows([
              [
                'Lifecycle',
                observed.health?.daemonLifecycle === 'external'
                  ? 'Externally managed'
                  : 'Treeport'
              ],
              ['PID', observed.state!.pid],
              status.verified
                ? [
                    'Workspace',
                    `${result.projects} projects · ${result.worktrees} trees · ${result.terminals} terminals`
                  ]
                : null
            ])
          ),
        !healthy &&
          observed.state !== null &&
          output.rows([
            ['PID', observed.state.pid],
            ['Logs', path.join(observed.state.dataDir, 'logs', 'daemon.log')]
          ])
      )
    })
  })

  const logsCommand = program
    .command('logs')
    .description('Show recent daemon logs')
    .option(
      '--lines <count>',
      'number of lines per source, including retained history',
      '100'
    )

  logsCommand.action(async () => {
    const lines = Number(logsCommand.opts<{ lines: string }>().lines)

    if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) {
      throw new CliError('--lines must be an integer between 1 and 10000', 2)
    }

    const targetApiUrl =
      configuredApiUrl &&
      configuredApiUrl !== process.env.TREEPORT_MANAGED_API_URL?.trim()
        ? apiUrl
        : undefined

    writeStdout(await readDaemonLogs(lines, targetApiUrl))
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

    print(result, () =>
      output.blocks(
        output.heading('Treeport version'),
        output.rows([
          ['CLI', result.cli],
          ['Daemon', result.daemon ?? 'Unavailable']
        ]),
        result.daemon !== null &&
          result.daemon !== result.cli &&
          output.summary(
            'Version mismatch: CLI and daemon versions differ',
            'warning'
          )
      )
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
            '\n# Treeport\n\n> **Externally managed daemon lifecycle:** Do not run `treeport start` or `treeport stop`. The process that started Treeport owns startup, shutdown, remote exposure, and logs. Other Treeport commands continue to use the configured daemon normally.\n'
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

      print(context, () =>
        output.blocks(
          output.heading('Treeport context'),
          'Not running in a Treeport-managed terminal.'
        )
      )

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
      await request(
        `/api/projects/${encodeURIComponent(projectId!)}?freshGitWorktreeId=${encodeURIComponent(worktreeId!)}`,
        projectResponseSchema
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

    print(context, () =>
      output.blocks(
        output.heading('Treeport context'),
        output.rows([
          ['Project', `${context.project.name} (${context.project.id})`],
          ['Tree', `${context.worktree.name} (${context.worktree.id})`],
          ['Path', context.worktree.path],
          [
            'Terminal',
            `${context.terminal.name} (${context.terminal.id}) — ${stateName(context.terminal.status)}`
          ]
        ]),
        output.detail(
          output.rows([
            ['API', context.apiUrl],
            [
              'Lifecycle',
              context.daemonLifecycle === 'external'
                ? 'Externally managed'
                : 'Treeport'
            ]
          ])
        )
      )
    )
  })

  const browserCommand = program
    .command('browser')
    .description('Manage Browser and its hosted runtime')

  browserCommand.action(() => {
    writeStdout(browserCommand.helpInformation())
  })

  const browserOpenCommand = browserCommand
    .command('open')
    .description('Open Browser and request client navigation')
    .argument(
      '[url]',
      'absolute HTTP, HTTPS, or file URL (files must exist on the browser runtime’s filesystem)'
    )
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

    const result = await request(
      `/api/worktrees/${encodeURIComponent(worktree.id)}/browser-apps`,
      openBrowserAppResponseSchema,
      { method: 'POST', body: JSON.stringify(body) }
    )

    const output = {
      ...result,
      url: appUrl(worktree, result.app.id)
    }

    print(
      output,
      () => `Opened ${result.app.title} (${result.app.id})\n${output.url}`
    )
  })

  const browserInstallCommand = browserCommand
    .command('install')
    .description('Show native browser installation guidance')
    .option('--json', 'emit machine-readable JSON')

  browserInstallCommand.action(async () => {
    const result = await request(
      '/api/browser/install',
      browserInstallResponseSchema,
      { method: 'POST' },
      660_000
    )

    print(result, () => result.message)
  })

  const browserStatusCommand = browserCommand
    .command('status')
    .description('Show hosted browser installation status')
    .option('--json', 'emit machine-readable JSON')

  browserStatusCommand.action(async () => {
    const result = await request(
      '/api/browser/status',
      browserInstallStatusSchema
    )

    print(
      result,
      () =>
        `${result.installed ? 'Browser is installed' : 'Browser is not installed'}\nLaunch ready: ${result.launchReady ? 'yes' : 'no'}\nPlaywright: ${result.playwrightVersion}\nBrowser: ${result.channel} ${result.browserRevision}\nExecutable: ${result.executablePath ?? 'not found'}${result.launchError ? `\nLaunch error: ${result.launchError}` : ''}`
    )
  })

  const browserListCommand = browserCommand
    .command('list')
    .description('List open Browser sessions')
    .option('--json', 'emit machine-readable JSON')

  browserListCommand.action(async () => {
    const apps = (await projects()).flatMap((project) =>
      project.worktrees.flatMap((worktree) =>
        worktree.workspaceItems
          .filter((app): app is BrowserApp => app.kind === 'browser')
          .map((app) => ({
            appId: app.id,
            title: app.title,
            worktreeId: worktree.id,
            worktree: worktree.name,
            projectId: project.id,
            project: project.name
          }))
      )
    )

    print(apps, () =>
      apps.length
        ? apps
            .map(
              (app) =>
                `${app.appId}\t${app.project} / ${app.worktree}\t${app.title}`
            )
            .join('\n')
        : 'Browser is not open.'
    )
  })

  const printAgentResult = async (
    command: string,
    args: string[],
    appId?: string
  ) => {
    const result = await runBrowserAgentCommand(command, args, appId)
    print(result, () => result.output)
  }

  const browserSnapshotCommand = browserCommand
    .command('snapshot')
    .description('Capture an accessibility snapshot of the hosted page')
    .option('--app <app-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')

  browserSnapshotCommand.action(async () =>
    printAgentResult(
      'snapshot',
      [],
      browserSnapshotCommand.opts<{ app?: string }>().app
    )
  )

  const browserClickCommand = browserCommand
    .command('click')
    .description('Click an element from the latest browser snapshot')
    .argument('<target>', 'Playwright element reference or selector')
    .option('--app <app-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')

  browserClickCommand.action(async (target: string) =>
    printAgentResult(
      'click',
      [target],
      browserClickCommand.opts<{ app?: string }>().app
    )
  )

  const browserFillCommand = browserCommand
    .command('fill')
    .description('Fill an editable element from the latest browser snapshot')
    .argument('<target>', 'Playwright element reference or selector')
    .argument('<text>', 'text to enter')
    .option('--app <app-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')

  browserFillCommand.action(async (target: string, text: string) =>
    printAgentResult(
      'fill',
      [target, text],
      browserFillCommand.opts<{ app?: string }>().app
    )
  )

  const browserPressCommand = browserCommand
    .command('press')
    .description('Press a key in the hosted page')
    .argument('<key>', 'Playwright key name')
    .option('--app <app-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')

  browserPressCommand.action(async (key: string) =>
    printAgentResult(
      'press',
      [key],
      browserPressCommand.opts<{ app?: string }>().app
    )
  )

  const browserGotoCommand = browserCommand
    .command('goto')
    .description('Navigate the hosted page')
    .argument(
      '<url>',
      'absolute HTTP, HTTPS, or file URL (files must exist on the browser runtime’s filesystem)'
    )
    .option('--app <app-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')

  browserGotoCommand.action(async (url: string) =>
    printAgentResult(
      'goto',
      [url],
      browserGotoCommand.opts<{ app?: string }>().app
    )
  )

  const browserConsoleCommand = browserCommand
    .command('console')
    .description('List page console messages')
    .argument('[level]', 'minimum console level')
    .option('--app <app-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')

  browserConsoleCommand.action(async (level?: string) =>
    printAgentResult(
      'console',
      level ? [level] : [],
      browserConsoleCommand.opts<{ app?: string }>().app
    )
  )

  const browserRunCommand = browserCommand
    .command('run')
    .description(
      'Run Playwright code against the hosted page; `page` and `context` are in scope, and returned values and console output are printed'
    )
    .argument(
      '[code]',
      'async function body, for example "return await page.title()"; read from stdin when omitted or -'
    )
    .option('--app <app-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')

  browserRunCommand.action(async (code?: string) => {
    let script = code ?? '-'

    if (script === '-') {
      const chunks: Buffer[] = []

      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk))
      }

      script = Buffer.concat(chunks).toString('utf8')
    }

    if (!script.trim()) {
      throw new CliError('Provide browser script code or pipe it on stdin.', 2)
    }

    await printAgentResult(
      'run',
      [script],
      browserRunCommand.opts<{ app?: string }>().app
    )
  })

  const browserDialogAcceptCommand = browserCommand
    .command('dialog-accept')
    .description('Accept the open page dialog')
    .argument('[prompt]', 'text to enter in a prompt dialog')
    .option('--app <app-id>', 'Browser ID')
    .option('--json', 'emit machine-readable JSON')

  browserDialogAcceptCommand.action(async (prompt?: string) =>
    printAgentResult(
      'dialog-accept',
      prompt === undefined ? [] : [prompt],
      browserDialogAcceptCommand.opts<{ app?: string }>().app
    )
  )

  for (const [name, description, agentName] of [
    ['dialog-dismiss', 'Dismiss the open page dialog', 'dialog-dismiss'],
    ['back', 'Go back in the hosted page', 'go-back'],
    ['forward', 'Go forward in the hosted page', 'go-forward'],
    ['reload', 'Reload the hosted page', 'reload'],
    ['network', 'List page network requests', 'requests'],
    ['screenshot', 'Capture a screenshot of the hosted page', 'screenshot']
  ] as const) {
    const command = browserCommand
      .command(name)
      .description(description)
      .option('--app <app-id>', 'Browser ID')
      .option('--json', 'emit machine-readable JSON')

    command.action(async () =>
      printAgentResult(agentName, [], command.opts<{ app?: string }>().app)
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
      await request('/api/packages/install', packageOperationResponseSchema, {
        method: 'POST',
        body: JSON.stringify(body)
      })
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
      await request('/api/packages/remove', packageOperationResponseSchema, {
        method: 'POST',
        body: JSON.stringify(body)
      })
    ).result

    print(result, () => `Removed ${result.source}`)
  })

  const listPackagesCommand = program
    .command('list')
    .description('List configured Treeport packages')
    .option('--json', 'emit machine-readable JSON')

  listPackagesCommand.action(async () => {
    const result = await request('/api/packages', packageListingResponseSchema)
    print(result, () => {
      const lines = result.packages.map((pkg) => {
        const scope =
          pkg.scope === 'global'
            ? 'global'
            : `project:${pkg.projectName ?? pkg.projectId}`

        return `${scope}\t${pkg.source}\t${pkg.resources.webApps} web apps, ${pkg.resources.launchers} launchers`
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

    const result = await request(
      '/api/packages/reload',
      packageReloadResponseSchema,
      {
        method: 'POST',
        body: JSON.stringify(
          options.local ? { projectId: await localPackageProjectId() } : {}
        )
      }
    )

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
    const body = await request('/api/projects', projectResponseSchema, {
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

  const worktreeTitleCommand = worktreeCommand
    .command('title')
    .description('Set the title shown for a tree; its folder name stays')
    .argument('[title]', 'title to show')
    .option('--worktree <id-or-path-or-dot>', 'tree to title', '.')
    .option('--clear', 'remove the title and show the tree name again')
    .option('--json', 'emit machine-readable JSON')

  worktreeTitleCommand.action(async (title: string | undefined) => {
    const options = worktreeTitleCommand.opts<{
      worktree: string
      clear?: boolean
    }>()

    if (!options.clear && !title?.trim()) {
      throw new CliError('Expected a title, or --clear', 2)
    }

    const worktree = await resolveWorktree(options.worktree)

    const result = await request(
      `/api/worktrees/${encodeURIComponent(worktree.id)}`,
      worktreeResponseSchema,
      {
        method: 'PATCH',
        body: JSON.stringify({ title: options.clear ? null : title })
      }
    )

    print(result.worktree, () =>
      result.worktree.title
        ? `Titled ${result.worktree.name}: ${result.worktree.title}`
        : `Cleared the title of ${result.worktree.name}`
    )
  })

  const worktreeDecorationCommand = worktreeCommand
    .command('decorate')
    .description(
      'Show a short marker beside a tree, such as a pull request state'
    )
    .argument('<key>', 'decoration identity; setting the same key replaces it')
    .argument('[text]', 'short text to show, such as #123')
    .option('--tone <tone>', TREE_DECORATION_TONES.join(', '), 'neutral')
    .option('--url <url>', 'http or https link opened from the tree menu')
    .option(
      '--title <text>',
      'what it means, shown on hover and in the tree menu'
    )
    .option(
      '--icon <svg-file>',
      'SVG icon shown before the text, in the tone color'
    )
    .option('--worktree <id-or-path-or-dot>', 'tree to decorate', '.')
    .option('--clear', 'remove the decoration')
    .option('--json', 'emit machine-readable JSON')

  worktreeDecorationCommand.action(
    async (key: string, text: string | undefined) => {
      const options = worktreeDecorationCommand.opts<{
        tone: string
        url?: string
        title?: string
        icon?: string
        worktree: string
        clear?: boolean
      }>()

      if (!options.clear && (!text?.trim() || !options.title?.trim())) {
        throw new CliError(
          'Expected decoration text and --title, or --clear',
          2
        )
      }

      const worktree = await resolveWorktree(options.worktree)

      const result = await request(
        `/api/worktrees/${encodeURIComponent(worktree.id)}/decorations/${encodeURIComponent(key)}`,
        worktreeResponseSchema,
        options.clear
          ? { method: 'DELETE' }
          : {
              method: 'PUT',
              body: JSON.stringify({
                text,
                tone: options.tone,
                url: options.url ?? null,
                title: options.title,
                icon: options.icon
                  ? await fs.readFile(options.icon, 'utf8')
                  : null
              })
            }
      )

      print(result.worktree, () =>
        options.clear
          ? `Cleared decoration ${key} on ${result.worktree.name}`
          : `Set decoration ${key} on ${result.worktree.name}: ${text}`
      )
    }
  )

  const worktreeRemoveCommand = worktreeCommand
    .command('remove')
    .description('Remove a linked tree')
    .argument('<id-or-path-or-dot>', 'Tree to remove')
    .option('--force', 'confirm destructive removal warnings')
    .option('--skip-cleanup', 'remove without configured project cleanup')
    .option('--json', 'emit machine-readable JSON')

  worktreeRemoveCommand.action(async (identifier: string) => {
    const { force: confirmed, skipCleanup: requestedSkipCleanup } =
      worktreeRemoveCommand.opts<{
        force?: boolean
        skipCleanup?: boolean
      }>()

    const worktree = await resolveWorktree(identifier)

    const preview = (
      await request(
        `/api/worktrees/${worktree.id}/remove-preview`,
        removePreviewResponseSchema
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

    const skipCleanup =
      Boolean(requestedSkipCleanup) && preview.cleanup.commands.length > 0

    if (skipCleanup && !confirmed) {
      throw new CliError(
        'Skipping project cleanup can leave project resources behind.\nRe-run with --force --skip-cleanup to confirm removal.',
        5
      )
    }

    let operation = (
      await request(
        `/api/worktrees/${worktree.id}/remove`,
        operationResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            confirmationToken: preview.confirmationToken,
            confirmDestructive: preview.warnings.length > 0 || skipCleanup,
            skipCleanup
          })
        }
      )
    ).operation

    const displayedCleanupCommands = new Set<number>()

    const displayFinishedCleanup = () => {
      if (jsonOutput || operation.kind !== 'remove') {
        return
      }

      operation.request.cleanupCommands.commands.forEach((command, index) => {
        if (
          displayedCleanupCommands.has(index) ||
          (command.status !== 'completed' && command.status !== 'failed')
        ) {
          return
        }

        displayedCleanupCommands.add(index)

        const lines = [
          `Cleanup: ${command.name}${command.status === 'failed' ? ' (failed)' : ''}`
        ]

        if (command.stdout) {
          lines.push(command.stdout.replace(/\n$/u, ''))
        }

        if (command.stderr) {
          lines.push(command.stderr.replace(/\n$/u, ''))
        }

        if (command.outputTruncated) {
          lines.push('Cleanup output was truncated.')
        }

        writeStdout(`${lines.join('\n')}\n`)
      })
    }

    displayFinishedCleanup()

    while (operation.status === 'pending' || operation.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 100))
      operation = (
        await request(
          `/api/operations/${encodeURIComponent(operation.id)}`,
          operationResponseSchema
        )
      ).operation
      displayFinishedCleanup()
    }

    if (operation.status === 'failed') {
      const cleanup =
        operation.kind === 'remove'
          ? operation.request.cleanupCommands.commands.find(
              (command) => command.status === 'failed'
            )
          : null

      throw new CliError(
        operation.error ?? 'Tree removal failed; Git kept the tree.',
        5,
        'WORKTREE_REMOVAL_FAILED',
        cleanup ?? undefined
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

  const webAppCommand = program
    .command('app')
    .description('Open persistent web apps')

  webAppCommand.action(() => {
    throw new CliError(webAppCommand.helpInformation(), 2)
  })

  const webAppOpenCommand = webAppCommand
    .command('open')
    .description('Create or reuse a web app and request client navigation')
    .argument('<definition>', 'definition ID or unique short name')
    .requiredOption('--worktree <id-or-path-or-dot>', 'owning tree')
    .option('--input <json>', 'structured app input as a JSON object')
    .option('--new', 'create a separate app instance')
    .option('--json', 'emit machine-readable JSON')

  webAppOpenCommand.action(async (identifier: string) => {
    const options = webAppOpenCommand.opts<{
      worktree: string
      input?: string
      new?: boolean
    }>()

    const worktree = await resolveWorktree(options.worktree)
    const definition = await webAppDefinition(worktree.id, identifier)

    const result = await request(
      `/api/worktrees/${encodeURIComponent(worktree.id)}/apps/open`,
      openWebAppResponseSchema,
      {
        method: 'POST',
        body: JSON.stringify({
          definitionId: definition.id,
          input: parseWebAppInput(options.input),
          launchCwd: await webAppLaunchCwd(worktree),
          newInstance: options.new ?? false,
          sourceTerminalId: contextTerminalId ?? null
        })
      }
    )

    const output = {
      ...result,
      url: appUrl(worktree, result.app.id)
    }

    print(
      output,
      () =>
        `${result.reused ? 'Reused' : 'Opened'} ${result.app.title} (${result.app.id})\n${output.url}`
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
            `${terminal.id}\t${terminal.name}\t${terminal.status}\t${terminal.command ?? ''}${terminal.parentTerminalId ? `\tparent ${terminal.parentTerminalId}` : ''}`
        )
        .join('\n')
    )
  })

  const terminalCreateCommand = terminalCommand
    .command('create')
    .description('Create a terminal')
    .usage('[options] [-- <command> args...]')
    .requiredOption('--worktree <id-or-path-or-dot>', 'owning tree')
    .requiredOption('--name <name>', 'terminal name')
    .option(
      '--close-on-exit',
      'close the terminal when its command exits, even on failure'
    )
    .option('--json', 'emit machine-readable JSON')
    .addHelpText(
      'after',
      '\nCommand arguments may be passed after --.\nAuto-close removes terminal output.\n'
    )

  terminalCreateCommand.action(async () => {
    const options = terminalCreateCommand.opts<{
      worktree: string
      name: string
      closeOnExit?: boolean
    }>()

    const worktree = await resolveWorktree(options.worktree)
    const body: TerminalCreateBody = { name: options.name }

    if (argv) {
      body.command = argv.join(' ')
    }

    if (options.closeOnExit) {
      body.afterExit = 'close'
    }

    if (contextTerminalId && contextWorktreeId === worktree.id) {
      body.parentTerminalId = contextTerminalId
    }

    const result = await request(
      `/api/worktrees/${worktree.id}/terminals`,
      terminalResponseSchema,
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
      const { activity, attention } = metadata

      const details = [
        activity.kind,
        activity.progress === null ? null : `${activity.progress}%`,
        activity.message
      ].filter(Boolean)

      const status =
        terminal.status === 'exited'
          ? `exited${terminal.exitCode === null ? '' : ` (${terminal.exitCode})`}`
          : terminal.status

      const command =
        terminal.commandExitCode == null
          ? ''
          : `\nCommand:  exited (${terminal.commandExitCode})`

      return `Terminal: ${terminal.name} (${terminal.id})\nStatus:   ${status}${command}\nTitle:    ${metadata.title ?? '—'}\nActivity: ${activity.state}${details.length ? ` (${details.join(', ')})` : ''}\nSince:    ${activity.since ?? '—'}\nAttention: ${attention ? `${attention.reason} at ${attention.at} (#${attention.sequence}${attention.unread ? ', unread' : ''})` : '—'}`
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

    const capture = await request(
      `/api/terminals/${encodeURIComponent(terminalId)}/capture?lines=${lines}`,
      terminalCaptureResponseSchema
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
    .requiredOption(
      '--until <idle|working|attention|exit>',
      'condition to wait for (exit: initial launched process or terminal session)'
    )
    .option('--timeout <duration>', 'maximum wait, such as 30s or 5m')
    .option('--json', 'emit machine-readable JSON')

  terminalWaitCommand.action(async (identifier: string) => {
    const options = terminalWaitCommand.opts<{
      until: string
      timeout?: string
    }>()

    const until = WAIT_CONDITIONS.find(
      (condition) => condition === options.until
    )

    if (!until) {
      throw new CliError(
        '--until must be one of idle, working, attention, or exit',
        2
      )
    }

    const result = await waitForTerminal(
      resolveTerminalId(identifier),
      until,
      options.timeout === undefined ? undefined : parseDuration(options.timeout)
    )

    print(
      result,
      () =>
        `${result.terminal.name} (${result.terminal.id}) reached ${result.condition} at ${result.observedAt}`
    )
  })

  const terminalSendKeysCommand = terminalCommand
    .command('send-keys')
    .description('Send keys to a terminal, like tmux send-keys')
    .argument('<terminal-id-or-dot>', 'terminal to receive input')
    .argument(
      '<key...>',
      'key names such as Enter, C-c, or Up; other text is typed literally'
    )
    .option('-l, --literal', 'type every argument literally')
    .option('-N, --repeat <count>', 'send the keys this many times')
    .option('--json', 'emit machine-readable JSON')
    .addHelpText(
      'after',
      `\nKeys: ${TERMINAL_INPUT_KEYS.join(' ')}.\nPrefix C-, M-, or S- for Ctrl, Alt, or Shift, as in C-c or M-Left.\n`
    )

  terminalSendKeysCommand.action(async (identifier: string, keys: string[]) => {
    const options = terminalSendKeysCommand.opts<{
      literal?: boolean
      repeat?: string
    }>()

    const repeat = Number(options.repeat ?? '1')

    if (
      !/^[1-9]\d*$/.test(options.repeat ?? '1') ||
      repeat * keys.length > TERMINAL_INPUT_MAX_STEPS
    ) {
      throw new CliError(
        `-N must be a positive integer, with at most ${TERMINAL_INPUT_MAX_STEPS} keys in total`,
        2
      )
    }

    const steps: TerminalSendInput['steps'][number][] = keys.map((argument) => {
      const text = { type: 'text' as const, text: argument, paste: false }

      if (options.literal) {
        return text
      }

      // EXTERNAL: As in tmux, C-, M-, and S- prefixes apply only when the rest names a key.
      const match = /^((?:[CMS]-)*)(.+)$/i.exec(argument)!
      const name = match[2]!.toLowerCase()

      const key =
        TERMINAL_INPUT_KEYS.find(
          (candidate) => candidate.toLowerCase() === name
        ) ??
        {
          ppage: 'PageUp',
          pgup: 'PageUp',
          npage: 'PageDown',
          pgdn: 'PageDown',
          insert: 'IC',
          delete: 'DC'
        }[name] ??
        (match[2]!.length === 1 ? match[2]! : null)

      if (!key) {
        return text
      }

      const modifiers = match[1]!.toUpperCase()

      return {
        type: 'key' as const,
        key,
        ctrl: modifiers.includes('C'),
        alt: modifiers.includes('M'),
        shift: modifiers.includes('S')
      }
    })

    const terminalId = resolveTerminalId(identifier)

    await request(
      `/api/terminals/${encodeURIComponent(terminalId)}/input`,
      okResponseSchema,
      {
        method: 'POST',
        body: JSON.stringify({
          steps: Array.from({ length: repeat }, () => steps).flat()
        } satisfies TerminalSendInput)
      }
    )

    if (jsonOutput) {
      print({ ok: true, terminalId })
    }
  })

  const terminalSendTextCommand = terminalCommand
    .command('send-text')
    .description('Paste text into a terminal, like wezterm cli send-text')
    .argument('<terminal-id-or-dot>', 'terminal to receive input')
    .argument('[text]', 'text to send; read from stdin when omitted or -')
    .option('--no-paste', 'type the text instead of using bracketed paste')
    .option('--json', 'emit machine-readable JSON')

  terminalSendTextCommand.action(async (identifier: string, value?: string) => {
    const { paste } = terminalSendTextCommand.opts<{ paste: boolean }>()
    let text = value ?? '-'

    if (text === '-') {
      const chunks: Buffer[] = []

      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk))
      }

      text = Buffer.concat(chunks).toString('utf8')
    }

    if (!text) {
      throw new CliError('Provide text or pipe it on stdin.', 2)
    }

    const terminalId = resolveTerminalId(identifier)

    await request(
      `/api/terminals/${encodeURIComponent(terminalId)}/input`,
      okResponseSchema,
      {
        method: 'POST',
        body: JSON.stringify({
          steps: [{ type: 'text', text, paste }]
        } satisfies TerminalSendInput)
      }
    )

    if (jsonOutput) {
      print({ ok: true, terminalId })
    }
  })

  const terminalDeleteCommand = terminalCommand
    .command('delete')
    .description('Delete a terminal')
    .argument('<terminal-id>', 'terminal to delete')
    .option('--json', 'emit machine-readable JSON')

  terminalDeleteCommand.action(async (terminalId: string) => {
    await request(`/api/terminals/${terminalId}`, okResponseSchema, {
      method: 'DELETE'
    })
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
      initialTerminal.command = argv.join(' ')
    }

    const request: CreateOperationRequest = {
      name: options.worktreeName,
      base: options.fromCurrent ? 'current' : 'default',
      initialTerminal
    }

    if (sourceWorktreeId) {
      request.sourceWorktreeId = sourceWorktreeId
    }

    if (contextWorktreeId) {
      request.originWorktreeId = contextWorktreeId
    }

    const result = await createWorktree(project.id, request)
    print(
      result,
      () =>
        `Created tree ${result.worktree.name} (${result.worktree.id})\nPath: ${result.worktree.path}\n${result.terminal ? `Terminal: ${result.terminal.name} (${result.terminal.id}) — ${result.terminal.status}` : 'Terminal: not created'}${result.setupError ? `\nSetup error: ${result.setupError}` : ''}${result.terminalError ? `\nTerminal error: ${result.terminalError}` : ''}`
    )
  })

  const launcherCommand = program
    .command('launcher')
    .description('List, add, and remove launchers')

  launcherCommand.action(() => {
    throw new CliError(launcherCommand.helpInformation(), 2)
  })

  const launcherListCommand = launcherCommand
    .command('list')
    .description('List launchers and the inputs they accept')
    .option(
      '--worktree <id-or-path-or-dot>',
      'include repository and package launchers of a tree (default: current tree)'
    )
    .option('--json', 'emit machine-readable JSON')

  launcherListCommand.action(async () => {
    const { worktree: identifier } = launcherListCommand.opts<{
      worktree?: string
    }>()

    const worktree =
      identifier === undefined
        ? await resolveWorktree('.').catch(() => null)
        : await resolveWorktree(identifier)

    const listing = await request(
      `/api/launcher-definitions${worktree ? `?worktreeId=${encodeURIComponent(worktree.id)}` : ''}`,
      launcherDefinitionListingSchema
    )

    print(listing, () =>
      [
        ...listing.definitions.map((launcher) => {
          const inputs = launcherInputNames([
            ...launcher.args,
            ...(launcher.treeTitle?.args ?? [])
          ])

          return `${launcher.id}\t${launcher.name}\t${launcher.shellCommand ?? JSON.stringify([launcher.executable, ...launcher.args])}${inputs.length ? `\tinputs: ${inputs.join(', ')}` : ''}${launcher.treeTitle ? `\ttree title: ${JSON.stringify([launcher.treeTitle.executable, ...launcher.treeTitle.args])}` : ''}`
        }),
        ...listing.diagnostics.map(
          (diagnostic) => `warning\t${diagnostic.path}\t${diagnostic.message}`
        )
      ].join('\n')
    )
  })

  const launcherAddCommand = launcherCommand
    .command('add')
    .description('Save a launcher for all projects, or for this repository')
    .usage('[options] -- <command> args...')
    .requiredOption('--name <name>', 'launcher name')
    .option('--repo', 'save in the current tree’s .treeport/settings.json')
    .option(
      '--tree-title <json-argv>',
      'command whose first output line titles new trees, as a JSON array'
    )
    .option(
      '--close-on-success',
      'close the terminal when its command succeeds'
    )
    .option('--json', 'emit machine-readable JSON')
    .addHelpText(
      'after',
      '\nWrite ${name} inside an argument to accept an input. An argument that is\nexactly one input is omitted when that input is empty. The tree title\ncommand runs after a new tree starts and can use the same inputs.\n\n  treeport launcher add --name Pi -- pi \'${prompt}\'\n  treeport launcher add --name Claude \\\n    --tree-title \'["claude","-p","Reply with a 3-5 word title for: ${task}"]\' \\\n    -- claude \'${task}\'\n'
    )

  launcherAddCommand.action(async () => {
    const options = launcherAddCommand.opts<{
      name: string
      repo?: boolean
      closeOnSuccess?: boolean
      treeTitle?: string
    }>()

    if (!argv) {
      throw new CliError('Expected a command after --', 2)
    }

    const treeTitleArgv =
      options.treeTitle === undefined
        ? null
        : decodeUnknownOrNull(
            Schema.parseJson(
              Schema.Array(Schema.String).pipe(Schema.minItems(1))
            ),
            options.treeTitle
          )

    if (options.treeTitle !== undefined && !treeTitleArgv) {
      throw new CliError(
        '--tree-title must be a JSON array such as ["claude","-p","Title for: ${task}"]',
        2
      )
    }

    const [executable = '', ...args] = argv
    const [treeTitleExecutable = '', ...treeTitleArgs] = treeTitleArgv ?? []

    const launcher = decodeUnknownOrNull(repositoryLauncherSchema, {
      name: options.name,
      executable,
      args,
      closeOnSuccess: Boolean(options.closeOnSuccess),
      treeTitle: treeTitleArgv
        ? { executable: treeTitleExecutable, args: treeTitleArgs }
        : null
    })

    if (!launcher) {
      throw new CliError('Invalid launcher name or command', 2)
    }

    if (!options.repo) {
      const result = await request('/api/launchers', launcherResponseSchema, {
        method: 'POST',
        body: JSON.stringify(launcher)
      })

      print(
        result.launcher,
        () => `Saved ${result.launcher.name} (${result.launcher.id})`
      )

      return
    }

    const worktree = await resolveWorktree('.')
    const settingsPath = path.join(worktree.path, '.treeport', 'settings.json')

    const content = await fs
      .readFile(settingsPath, 'utf8')
      .catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? '{}' : Promise.reject(error)
      )

    const jsonObjectSchema = Schema.Record({
      key: Schema.String,
      value: Schema.Unknown
    })

    const settings = decodeUnknownOrNull(
      Schema.parseJson(jsonObjectSchema),
      content
    )

    if (!settings) {
      throw new CliError(`${settingsPath} must contain a JSON object`, 5)
    }

    const id =
      launcher.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'launcher'

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          ...settings,
          launchers: {
            ...decodeUnknownOrNull(jsonObjectSchema, settings.launchers),
            [id]: launcher
          }
        },
        null,
        2
      )}\n`
    )
    print(
      { id, path: settingsPath, launcher },
      () => `Saved ${launcher.name} as ${id} in ${settingsPath}`
    )
  })

  const launcherRemoveCommand = launcherCommand
    .command('remove')
    .description('Remove a launcher saved with `treeport launcher add`')
    .argument('<launcher-id>', 'saved launcher to remove')
    .option('--json', 'emit machine-readable JSON')

  launcherRemoveCommand.action(async (launcherId: string) => {
    const saved = (
      await request('/api/launchers', launchersResponseSchema)
    ).launchers.find((launcher) => launcher.id === launcherId)

    if (!saved) {
      throw new CliError(
        `No saved launcher ${launcherId}. Repository launchers live in .treeport/settings.json.`,
        5
      )
    }

    await request(
      `/api/launchers/${encodeURIComponent(saved.id)}`,
      okResponseSchema,
      {
        method: 'DELETE',
        body: JSON.stringify({ expectedUpdatedAt: saved.updatedAt })
      }
    )
    print({ ok: true, launcherId }, () => `Removed ${saved.name}`)
  })

  const launchCommand = program
    .command('launch')
    .description('Start a launcher in a tree, optionally with inputs')
    .argument('<launcher>', 'launcher ID or name')
    .option(
      '--input <name=value>',
      'set an input (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      []
    )
    .option('--worktree <id-or-path-or-dot>', 'tree to start in', '.')
    .option('--new-tree', 'create a tree and start the launcher there')
    .option(
      '--tree-name <name>',
      'name for the new tree (default: tree, tree-2, …)'
    )
    .option('--from-current', 'base the new tree on the current tree')
    .option(
      '--project <id-or-path-or-dot>',
      'project for the new tree (default: current folder)'
    )
    .option('--json', 'emit machine-readable JSON')

  launchCommand.action(async (identifier: string) => {
    const options = launchCommand.opts<{
      input: string[]
      worktree: string
      newTree?: boolean
      treeName?: string
      fromCurrent?: boolean
      project?: string
    }>()

    const inputs: Record<string, string> = {}

    for (const entry of options.input) {
      const separator = entry.indexOf('=')

      if (separator < 1) {
        throw new CliError(`--input must look like name=value: ${entry}`, 2)
      }

      inputs[entry.slice(0, separator)] = entry.slice(separator + 1)
    }

    const project = options.newTree
      ? await resolveProject(options.project)
      : null

    const worktree = project ? null : await resolveWorktree(options.worktree)

    const listing = await request(
      `/api/launcher-definitions?${project ? `projectId=${encodeURIComponent(project.id)}` : `worktreeId=${encodeURIComponent(worktree!.id)}`}`,
      launcherDefinitionListingSchema
    )

    const matches = listing.definitions.filter(
      (launcher) =>
        launcher.id.endsWith(`:launcher:${identifier}`) ||
        launcher.name.toLowerCase() === identifier.toLowerCase()
    )

    const launcher =
      listing.definitions.find((candidate) => candidate.id === identifier) ??
      (matches.length === 1 ? matches[0] : undefined)

    if (!launcher) {
      throw new CliError(
        matches.length > 1
          ? `Launcher ${identifier} is ambiguous: ${matches.map((match) => match.id).join(', ')}`
          : `No launcher matches ${identifier}. Run \`treeport launcher list\`.`,
        5
      )
    }

    const treeTitle = project ? launcher.treeTitle : null

    const accepted = launcherInputNames([
      ...launcher.args,
      ...(treeTitle?.args ?? [])
    ])

    const unknown = Object.keys(inputs).filter(
      (name) => !accepted.includes(name)
    )

    if (unknown.length > 0) {
      throw new CliError(
        `${launcher.name} does not accept ${unknown.join(', ')}${accepted.length ? `; it accepts ${accepted.join(', ')}` : ''}`,
        2
      )
    }

    const commandLine =
      launcher.shellCommand ??
      (launcher.executable
        ? formatCommandLine([
            launcher.executable,
            ...resolveLauncherArgs(launcher.args, inputs)
          ])
        : null)

    if (project) {
      if (!commandLine || launcher.closeOnSuccess) {
        throw new CliError(
          `${launcher.name} cannot start a new tree; start it in an existing tree instead`,
          2
        )
      }

      const createRequest: CreateOperationRequest = {
        name:
          options.treeName ??
          availableTreeName(
            project.worktrees.map((candidate) => candidate.name)
          ),
        base: options.fromCurrent ? 'current' : 'default',
        initialTerminal: {
          name: launcher.name,
          command: commandLine
        }
      }

      if (options.fromCurrent) {
        createRequest.sourceWorktreeId = (await resolveWorktree('.')).id
      }

      if (contextWorktreeId) {
        createRequest.originWorktreeId = contextWorktreeId
      }

      const resolvedTreeTitle = resolveLauncherTreeTitle(
        { name: launcher.name, treeTitle },
        inputs
      )

      if (resolvedTreeTitle) {
        createRequest.treeTitle = resolvedTreeTitle
      }

      const result = await createWorktree(project.id, createRequest)
      print(
        result,
        () =>
          `Created tree ${result.worktree.name} (${result.worktree.id})\nPath: ${result.worktree.path}\n${result.terminal ? `Terminal: ${result.terminal.name} (${result.terminal.id}) — ${result.terminal.status}` : 'Terminal: not created'}${result.setupError ? `\nSetup error: ${result.setupError}` : ''}${result.terminalError ? `\nTerminal error: ${result.terminalError}` : ''}`
      )

      return
    }

    const body: TerminalCreateBody = { name: launcher.name }

    if (commandLine) {
      body.command = commandLine
    }

    if (launcher.cwd) {
      body.cwd = launcher.cwd
    }

    if (Object.keys(launcher.env).length > 0) {
      body.env = launcher.env
    }

    if (launcher.closeOnSuccess) {
      body.afterExit = 'closeOnSuccess'
    }

    if (contextTerminalId && contextWorktreeId === worktree!.id) {
      body.parentTerminalId = contextTerminalId
    }

    const result = await request(
      `/api/worktrees/${worktree!.id}/terminals`,
      terminalResponseSchema,
      { method: 'POST', body: JSON.stringify(body) }
    )

    print(
      result.terminal,
      () => `Started ${result.terminal.name} (${result.terminal.id})`
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
  output = humanOutput(
    environment,
    options.stdoutIsTTY ?? (!options.stdout && Boolean(process.stdout.isTTY)),
    jsonOutput
  )
  errorOutput = humanOutput(
    environment,
    options.stderrIsTTY ?? (!options.stderr && Boolean(process.stderr.isTTY)),
    jsonOutput
  )

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
      const errorBody =
        cliError.details === undefined
          ? { code: cliError.code, message: cliError.message }
          : {
              code: cliError.code,
              message: cliError.message,
              details: cliError.details
            }

      const body: ApiErrorBody = { error: errorBody }

      writeStderr(`${JSON.stringify(body)}\n`)
    } else {
      const text = errorOutput.blocks(
        errorOutput.summary(
          cliError.code === 'USAGE_ERROR'
            ? 'Invalid command'
            : 'Command failed',
          'failure'
        ),
        errorOutput.indent(cliError.message.replace(/^error: /, '')),
        cliError.code === 'USAGE_ERROR' && errorOutput.next(['treeport --help'])
      )

      writeStderr(`${text}\n`)
    }

    requestedExitCode = cliError.exitCode
  }

  return requestedExitCode
}
