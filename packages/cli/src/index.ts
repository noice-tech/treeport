#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ApiErrorBody,
  ProjectRecord,
  RemovePreview,
  TerminalRecord,
  WorktreeRecord
} from '@tasktty/shared'
import { extractJsonOutput } from './args.js'

const apiUrl = (process.env.TASKTTY_API_URL || 'http://127.0.0.1:4780').replace(
  /\/$/,
  ''
)
const token = process.env.TASKTTY_AUTH_TOKEN
const rawArgs = process.argv.slice(2)
const jsonOutput = extractJsonOutput(rawArgs)

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number
  ) {
    super(message)
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
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers
      }
    })
    const body = (await response.json().catch(() => ({}))) as T | ApiErrorBody
    if (!response.ok) {
      const error = (body as ApiErrorBody).error
      throw new CliError(
        error?.message || `HTTP ${response.status}`,
        response.status === 401 ? 4 : 5
      )
    }

    return body as T
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }

    throw new CliError(
      `Cannot reach TaskTTY daemon at ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`,
      3
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
    console.log(JSON.stringify(value, null, 2))
  } else {
    console.log(human ? human() : JSON.stringify(value, null, 2))
  }
}

function usage(): never {
  throw new CliError(
    `Usage:
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
        `Created ${result.worktree.name}\n${result.worktree.path}${result.setupError ? `\nSetup error: ${result.setupError}` : ''}`
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
        `Created ${result.worktree.name}${result.terminal ? ` with ${result.terminal.name}` : ''}${result.setupError ? `\nSetup error: ${result.setupError}` : ''}${result.terminalError ? `\nTerminal error: ${result.terminalError}` : ''}`
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
  process.stderr.write(`${cliError.message}\n`)
  process.exitCode = cliError.exitCode
})
