#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { io, type Socket } from 'socket.io-client'
import {
  parseEventsSnapshot,
  parseProductEvent,
  parseTerminalRuntimeMetadata,
  SOCKET_IO_PATH,
  type ApiErrorBody,
  type EventsClientToServerEvents,
  type EventsServerToClientEvents,
  type ProjectRecord,
  type RemovePreview,
  type TreeportContext,
  type TerminalRecord,
  type TerminalRuntimeMetadata,
  type WorktreeRecord
} from '@treeport/shared'
import { extractJsonOutput } from './args.js'

const configuredApiUrl = process.env.TREEPORT_API_URL?.trim()
const apiUrl = (configuredApiUrl || 'http://127.0.0.1:4780').replace(/\/$/, '')
const contextPrefix = 'TREEPORT'
const contextProjectId = process.env.TREEPORT_PROJECT_ID?.trim()
const contextWorktreeId = process.env.TREEPORT_WORKTREE_ID?.trim()
const contextTerminalId = process.env.TREEPORT_TERMINAL_ID?.trim()
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

function removeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag)
  if (index === -1) {
    return false
  }

  args.splice(index, 1)
  return true
}

function option(
  args: string[],
  name: string,
  required = false
): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) {
    if (required) {
      throw new CliError(`Missing required option ${name}`, 2)
    }

    return undefined
  }

  const value = args[index + 1]
  if (!value || value === '--') {
    throw new CliError(`Missing value for ${name}`, 2)
  }

  args.splice(index, 2)
  return value
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

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value)
  if (!match) {
    throw new CliError(
      'Timeout must be a positive duration such as 500ms, 30s, 5m, or 1h',
      2
    )
  }

  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const
  const amount = Number(match[1])
  const timeoutMs = amount * units[match[2] as keyof typeof units]
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new CliError('Timeout must be between 1ms and 2147483647ms', 2)
  }

  return timeoutMs
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

function usage(): never {
  throw new CliError(
    `Usage:
  treeport context [--json]
  treeport project add <path> [--json]
  treeport project list [--json]
  treeport worktree list [--project <id-or-path>] [--json]
  treeport worktree create --project <id-or-path> --name <name> [--from-current] [--json]
  treeport worktree remove <id-or-path-or-dot> [--force] [--json]
  treeport terminal list [--worktree <id-or-path>] [--json]
  treeport terminal create --worktree <id-or-path-or-dot> --name <name> [-- <command> args...] [--json]
  treeport terminal inspect <terminal-id-or-dot> [--json]
  treeport terminal wait <terminal-id-or-dot> --until <idle|working|bell|exit> [--timeout <duration>] [--json]
  treeport terminal delete <terminal-id> [--json]
  treeport spawn --project <id-or-path-or-dot> --worktree-name <name> --name <terminal-name> [--from-current] [-- <command> args...] [--json]`,
    2
  )
}

async function main(args: string[]): Promise<void> {
  const [group, action] = args.splice(0, 2)
  if (group === 'context') {
    if (action || args.length) {
      usage()
    }

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
        `Treeport context\n\nProject:  ${context.project.name} (${context.project.id})\nWorktree: ${context.worktree.name} (${context.worktree.id})\nPath:     ${context.worktree.path}\nTerminal: ${context.terminal.name} (${context.terminal.id}) — ${context.terminal.status}\nAPI:      ${context.apiUrl}`
    )
    return
  }

  if (group === 'project' && action === 'add') {
    const repository = args.shift()
    if (!repository) {
      usage()
    }

    const body = await request<{ project: ProjectRecord }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: await canonical(repository) })
    })
    print(
      body.project,
      () =>
        `Registered ${body.project.name} (${body.project.id})\n${body.project.repositoryPath}`
    )
    return
  }

  if (group === 'project' && action === 'list') {
    const list = await projects()
    print(list, () =>
      list
        .map(
          (project) =>
            `${project.id}\t${project.name}\t${project.repositoryPath}`
        )
        .join('\n')
    )
    return
  }

  if (group === 'worktree' && action === 'list') {
    const projectIdentifier = option(args, '--project')
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
    return
  }

  if (group === 'worktree' && action === 'create') {
    const projectIdentifier = option(args, '--project', true)!
    const name = option(args, '--name', true)!
    const fromCurrent = removeFlag(args, '--from-current')
    const project = await resolveProject(projectIdentifier)
    const sourceWorktreeId = fromCurrent
      ? (await resolveWorktree('.')).id
      : undefined
    const result = await request<{
      worktree: WorktreeRecord
      setupError: string | null
    }>(`/api/projects/${project.id}/worktrees`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        base: fromCurrent ? 'current' : 'default',
        ...(sourceWorktreeId ? { sourceWorktreeId } : {})
      })
    })
    print(
      result,
      () =>
        `Created ${result.worktree.name} (${result.worktree.id})\n${result.worktree.path}${result.setupError ? `\nSetup error: ${result.setupError}` : ''}`
    )
    return
  }

  if (group === 'worktree' && action === 'remove') {
    const identifier = args.shift()
    if (!identifier) {
      usage()
    }

    const confirmed = removeFlag(args, '--force')
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
    return
  }

  if (group === 'terminal' && action === 'list') {
    const identifier = option(args, '--worktree')
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
    return
  }

  if (group === 'terminal' && action === 'create') {
    const argv = commandArgv(args)
    const identifier = option(args, '--worktree', true)!
    const name = option(args, '--name', true)!
    const worktree = await resolveWorktree(identifier)
    const result = await request<{ terminal: TerminalRecord }>(
      `/api/worktrees/${worktree.id}/terminals`,
      {
        method: 'POST',
        body: JSON.stringify({ name, ...(argv ? { argv } : {}) })
      }
    )
    print(
      result.terminal,
      () => `Created ${result.terminal.name} (${result.terminal.id})`
    )
    return
  }

  if (group === 'terminal' && action === 'inspect') {
    const identifier = args.shift()
    if (!identifier || args.length) {
      usage()
    }

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
    return
  }

  if (group === 'terminal' && action === 'wait') {
    const identifier = args.shift()
    if (
      !identifier ||
      args.filter((value) => value === '--until').length !== 1 ||
      args.filter((value) => value === '--timeout').length > 1
    ) {
      usage()
    }

    const rawCondition = option(args, '--until', true)!
    const rawTimeout = option(args, '--timeout')
    if (args.length) {
      usage()
    }

    if (!['idle', 'working', 'bell', 'exit'].includes(rawCondition)) {
      throw new CliError(
        '--until must be one of idle, working, bell, or exit',
        2
      )
    }

    const result = await waitForTerminal(
      resolveTerminalId(identifier),
      rawCondition as WaitCondition,
      rawTimeout === undefined ? undefined : parseDuration(rawTimeout)
    )
    print(
      result,
      () =>
        `${result.terminal.name} (${result.terminal.id}) reached ${result.condition} at ${result.observedAt}`
    )
    return
  }

  if (group === 'terminal' && action === 'delete') {
    const terminalId = args.shift()
    if (!terminalId) {
      usage()
    }

    await request(`/api/terminals/${terminalId}`, { method: 'DELETE' })
    print({ ok: true, terminalId }, () => `Deleted ${terminalId}`)
    return
  }

  if (group === 'spawn') {
    args.unshift(action ?? '')
    if (!args[0]) {
      args.shift()
    }

    const argv = commandArgv(args)
    const projectIdentifier = option(args, '--project', true)!
    const worktreeName = option(args, '--worktree-name', true)!
    const name = option(args, '--name', true)!
    const fromCurrent = removeFlag(args, '--from-current')
    const project = await resolveProject(projectIdentifier)
    const sourceWorktreeId = fromCurrent
      ? (await resolveWorktree('.')).id
      : undefined
    const result = await request<{
      worktree: WorktreeRecord
      terminal: TerminalRecord | null
      terminalError: string | null
      setupError: string | null
    }>('/api/spawn', {
      method: 'POST',
      body: JSON.stringify({
        project: project.id,
        worktreeName,
        name,
        base: fromCurrent ? 'current' : 'default',
        ...(sourceWorktreeId ? { sourceWorktreeId } : {}),
        ...(argv ? { argv } : {})
      })
    })
    print(
      result,
      () =>
        `Created worktree ${result.worktree.name} (${result.worktree.id})\nPath: ${result.worktree.path}\n${result.terminal ? `Terminal: ${result.terminal.name} (${result.terminal.id}) — ${result.terminal.status}` : 'Terminal: not created'}${result.setupError ? `\nSetup error: ${result.setupError}` : ''}${result.terminalError ? `\nTerminal error: ${result.terminalError}` : ''}`
    )
    return
  }

  usage()
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
