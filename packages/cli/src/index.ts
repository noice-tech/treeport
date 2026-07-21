#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ApiErrorBody,
  ProjectRecord,
  RemovePreview,
  TaskTTYContext,
  TerminalRecord,
  WorktreeRecord
} from '@tasktty/shared'
import { extractJsonOutput } from './args.js'

const apiUrl = (process.env.TASKTTY_API_URL || 'http://127.0.0.1:4780').replace(
  /\/$/,
  ''
)
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
  const timeout = setTimeout(() => controller.abort(), 90_000)
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
      `Cannot reach TaskTTY daemon at ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`,
      3,
      'DAEMON_UNREACHABLE'
    )
  } finally {
    clearTimeout(timeout)
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

  if (identifier === '.' && process.env.TASKTTY_PROJECT_ID) {
    const environmentMatch = list.find(
      (project) => project.id === process.env.TASKTTY_PROJECT_ID
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

  if (identifier === '.' && process.env.TASKTTY_WORKTREE_ID) {
    const environmentMatch = all.find(
      (worktree) => worktree.id === process.env.TASKTTY_WORKTREE_ID
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
  tasktty context [--json]
  tasktty project add <path> [--json]
  tasktty project list [--json]
  tasktty worktree list [--project <id-or-path>] [--json]
  tasktty worktree create --project <id-or-path> --name <name> [--from-current] [--json]
  tasktty worktree remove <id-or-path-or-dot> [--force] [--json]
  tasktty terminal list [--worktree <id-or-path>] [--json]
  tasktty terminal create --worktree <id-or-path-or-dot> --name <name> [-- <command> args...] [--json]
  tasktty terminal delete <terminal-id> [--json]
  tasktty spawn --project <id-or-path-or-dot> --worktree-name <name> --name <terminal-name> [--from-current] [-- <command> args...] [--json]`,
    2
  )
}

async function main(args: string[]): Promise<void> {
  const [group, action] = args.splice(0, 2)
  if (group === 'context') {
    if (action || args.length) {
      usage()
    }

    const projectId = process.env.TASKTTY_PROJECT_ID?.trim()
    const worktreeId = process.env.TASKTTY_WORKTREE_ID?.trim()
    const terminalId = process.env.TASKTTY_TERMINAL_ID?.trim()
    const presentIds = [projectId, worktreeId, terminalId].filter(Boolean)
    if (!presentIds.length) {
      const context: TaskTTYContext = {
        managed: false,
        reason: 'outside_tasktty'
      }
      print(context, () => 'Not running in a TaskTTY-managed terminal.')
      return
    }

    const missing = [
      ...(!process.env.TASKTTY_API_URL?.trim() ? ['TASKTTY_API_URL'] : []),
      ...(!projectId ? ['TASKTTY_PROJECT_ID'] : []),
      ...(!worktreeId ? ['TASKTTY_WORKTREE_ID'] : []),
      ...(!terminalId ? ['TASKTTY_TERMINAL_ID'] : [])
    ]
    if (missing.length) {
      throw new CliError(
        `Incomplete TaskTTY context; missing ${missing.join(', ')}`,
        5,
        'TASKTTY_CONTEXT_INCOMPLETE',
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
        'TaskTTY context worktree does not belong to the current project',
        5,
        'TASKTTY_CONTEXT_INVALID',
        { projectId, worktreeId }
      )
    }

    const terminal = worktree.terminals.find(
      (candidate) => candidate.id === terminalId
    )
    if (!terminal) {
      throw new CliError(
        'TaskTTY context terminal does not belong to the current worktree',
        5,
        'TASKTTY_CONTEXT_INVALID',
        { worktreeId, terminalId }
      )
    }

    const context: TaskTTYContext = {
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
        `TaskTTY context\n\nProject:  ${context.project.name} (${context.project.id})\nWorktree: ${context.worktree.name} (${context.worktree.id})\nPath:     ${context.worktree.path}\nTerminal: ${context.terminal.name} (${context.terminal.id}) — ${context.terminal.status}\nAPI:      ${context.apiUrl}`
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
