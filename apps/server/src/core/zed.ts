import fs from 'node:fs/promises'
import path from 'node:path'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { CommandRunner } from './command'
import type { WorktreeSetupTask } from './setup'

const DEFAULT_WORKTREE_DIRECTORY = '../worktrees'
const MAX_HOOK_OUTPUT = 4_000

export interface ZedTask {
  label: string
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
}

export interface ZedHookResult {
  label: string
  error: string | null
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

async function assertNoSymlinkComponents(
  parent: string,
  candidate: string
): Promise<void> {
  if (!isPathWithin(candidate, parent)) {
    throw new Error(
      'Zed worktree path must stay inside the repository or its parent'
    )
  }

  const relative = path.relative(parent, candidate)
  let current = parent
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }

      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Zed worktree path cannot contain a symbolic link: ${current}`
      )
    }
  }
}

async function readJsonc(filePath: string): Promise<unknown | null> {
  let source: string
  try {
    source = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
  const errors: ParseError[] = []
  const value = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false
  })
  if (errors.length) {
    const first = errors[0]!
    throw new Error(
      `Invalid JSONC in ${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    )
  }

  return value
}

export function normalizeWorktreeName(input: string): string {
  const name = input.trim().replace(/\s+/g, '-')
  if (!name || name === '.' || name === '..') {
    throw new Error('Worktree name is required')
  }

  if (name.length > 120) {
    throw new Error('Worktree name must be 120 characters or fewer')
  }

  if (
    /[\\/]/u.test(name) ||
    [...name].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 32 || codePoint === 127
    })
  ) {
    throw new Error(
      'Worktree name cannot contain path separators or control characters'
    )
  }

  return name
}

export function inferWorktreeName(
  mainWorktreePath: string,
  worktreePath: string,
  kind: 'main' | 'linked'
): string {
  if (kind === 'main') {
    return 'main worktree'
  }

  const checkoutName = path.basename(worktreePath)
  return checkoutName === path.basename(mainWorktreePath)
    ? path.basename(path.dirname(worktreePath))
    : checkoutName
}

export async function resolveZedWorktreePath(
  mainWorktreePath: string,
  inputName: string
): Promise<{
  name: string
  path: string
  wrapperPath: string
  directorySetting: string
}> {
  const name = normalizeWorktreeName(inputName)
  const settings = await readJsonc(
    path.join(mainWorktreePath, '.zed', 'settings.json')
  )
  const record =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : {}
  const git =
    record.git && typeof record.git === 'object'
      ? (record.git as Record<string, unknown>)
      : {}
  const configured = record['git.worktree_directory'] ?? git.worktree_directory
  const directorySetting =
    configured === undefined
      ? DEFAULT_WORKTREE_DIRECTORY
      : typeof configured === 'string'
        ? configured.trim()
        : (() => {
            throw new Error('Zed git.worktree_directory must be a string')
          })()
  if (
    !directorySetting ||
    directorySetting === '..' ||
    path.isAbsolute(directorySetting)
  ) {
    throw new Error('Zed git.worktree_directory must be a safe relative path')
  }

  const main = await fs.realpath(mainWorktreePath)
  const parent = path.dirname(main)
  const resolved = path.resolve(main, directorySetting)
  if (resolved === parent || !isPathWithin(resolved, parent)) {
    throw new Error(
      'Zed git.worktree_directory must stay inside the repository or its parent'
    )
  }

  await assertNoSymlinkComponents(parent, resolved)

  const repositoryBase = isPathWithin(resolved, main)
    ? resolved
    : path.join(resolved, path.basename(main))
  await assertNoSymlinkComponents(parent, repositoryBase)
  const wrapperPath = path.join(repositoryBase, name)
  return {
    name,
    path: path.join(wrapperPath, path.basename(main)),
    wrapperPath,
    directorySetting
  }
}

export async function prepareZedWorktreeWrapper(
  mainWorktreePath: string,
  wrapperPath: string
): Promise<{ created: boolean; path: string }> {
  const main = await fs.realpath(mainWorktreePath)
  const parent = path.dirname(main)
  const wrapper = path.resolve(wrapperPath)
  await assertNoSymlinkComponents(parent, wrapper)

  let created = false
  try {
    const stat = await fs.lstat(wrapper)
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Zed worktree wrapper cannot be a symbolic link: ${wrapper}`
      )
    }

    if (!stat.isDirectory()) {
      throw new Error(`Zed worktree wrapper is not a directory: ${wrapper}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }

    created = (await fs.mkdir(wrapper, { recursive: true })) !== undefined
  }

  const stat = await fs.lstat(wrapper)
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Zed worktree wrapper cannot be a symbolic link: ${wrapper}`
    )
  }

  const canonical = await fs.realpath(wrapper)
  if (!isPathWithin(canonical, parent)) {
    throw new Error('Zed worktree wrapper escaped the repository parent')
  }

  return { created, path: canonical }
}

function taskArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }

  if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as Record<string, unknown>).tasks)
  ) {
    return (value as { tasks: unknown[] }).tasks
  }

  return []
}

export async function loadCreateWorktreeTasks(
  mainWorktreePath: string
): Promise<ZedTask[]> {
  const value = await readJsonc(
    path.join(mainWorktreePath, '.zed', 'tasks.json')
  )
  return taskArray(value).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }

    const task = entry as Record<string, unknown>
    if (!Array.isArray(task.hooks) || !task.hooks.includes('create_worktree')) {
      return []
    }

    if (typeof task.command !== 'string' || !task.command.trim()) {
      throw new Error(
        `Zed create_worktree task ${index + 1} is missing a command`
      )
    }

    if (task.args !== undefined && !Array.isArray(task.args)) {
      throw new Error(`Zed create_worktree task ${index + 1} has invalid args`)
    }

    const args = (task.args ?? []).map((argument) => {
      if (typeof argument !== 'string') {
        throw new Error(
          `Zed create_worktree task ${index + 1} has a non-string argument`
        )
      }

      return argument
    })
    const env: Record<string, string> = {}
    if (task.env !== undefined) {
      if (
        !task.env ||
        typeof task.env !== 'object' ||
        Array.isArray(task.env)
      ) {
        throw new Error(`Zed create_worktree task ${index + 1} has invalid env`)
      }

      for (const [key, environmentValue] of Object.entries(task.env)) {
        if (typeof environmentValue !== 'string') {
          throw new Error(
            `Zed create_worktree task ${index + 1} has a non-string env value`
          )
        }

        env[key] = environmentValue
      }
    }

    if (task.cwd !== undefined && typeof task.cwd !== 'string') {
      throw new Error(`Zed create_worktree task ${index + 1} has invalid cwd`)
    }

    return [
      {
        label:
          typeof task.label === 'string' && task.label.trim()
            ? task.label
            : `Task ${index + 1}`,
        command: task.command,
        args,
        ...(typeof task.cwd === 'string' ? { cwd: task.cwd } : {}),
        env
      }
    ]
  })
}

function expand(value: string, environment: Record<string, string>): string {
  return value.replace(
    /\$\{(ZED_WORKTREE_ROOT|ZED_MAIN_GIT_WORKTREE)\}|\$(ZED_WORKTREE_ROOT|ZED_MAIN_GIT_WORKTREE)\b/g,
    (_match, braced: string | undefined, plain: string | undefined) =>
      environment[braced ?? plain!] ?? ''
  )
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export async function resolveCreateWorktreeSetupTasks(input: {
  shell: string
  mainWorktreePath: string
  worktreePath: string
}): Promise<WorktreeSetupTask[]> {
  const tasks = await loadCreateWorktreeTasks(input.mainWorktreePath)
  const compatibilityEnvironment = {
    ZED_WORKTREE_ROOT: input.worktreePath,
    ZED_MAIN_GIT_WORKTREE: input.mainWorktreePath
  }
  return tasks.map((task) => {
    const command = expand(task.command, compatibilityEnvironment)
    const args = task.args.map((argument) =>
      expand(argument, compatibilityEnvironment)
    )
    const expandedCwd = task.cwd
      ? expand(task.cwd, compatibilityEnvironment)
      : input.worktreePath
    const cwd = path.isAbsolute(expandedCwd)
      ? expandedCwd
      : path.resolve(input.worktreePath, expandedCwd)
    const taskEnvironment = Object.fromEntries(
      Object.entries(task.env).map(([key, value]) => [
        key,
        expand(value, compatibilityEnvironment)
      ])
    )
    const useShell = /[\s;&|<>`$()]/u.test(command)
    return {
      label: task.label,
      argv: useShell
        ? [input.shell, '-lc', [command, ...args.map(shellQuote)].join(' ')]
        : [command, ...args],
      cwd,
      env: { ...compatibilityEnvironment, ...taskEnvironment },
      timeoutMs: 30 * 60_000
    }
  })
}

export async function runCreateWorktreeTasks(input: {
  runner: CommandRunner
  shell: string
  mainWorktreePath: string
  worktreePath: string
}): Promise<ZedHookResult[]> {
  const tasks = await resolveCreateWorktreeSetupTasks(input)
  const results: ZedHookResult[] = []
  for (const task of tasks) {
    const [executable, ...args] = task.argv
    if (!executable) {
      continue
    }

    try {
      const result = await input.runner.run({
        executable,
        args,
        cwd: task.cwd,
        env: { ...process.env, ...task.env },
        timeoutMs: task.timeoutMs
      })
      if (result.exitCode !== 0) {
        const detail = (
          result.stderr.trim() ||
          result.stdout.trim() ||
          `exit ${result.exitCode}`
        ).slice(0, MAX_HOOK_OUTPUT)
        results.push({ label: task.label, error: detail })
        break
      }

      results.push({ label: task.label, error: null })
    } catch (error) {
      results.push({
        label: task.label,
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          MAX_HOOK_OUTPUT
        )
      })
      break
    }
  }
  return results
}
