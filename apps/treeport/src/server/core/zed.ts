import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { readOptionalJsonc } from './jsonc'
import type { WorktreeSetupTask } from './setup'

const DEFAULT_WORKTREE_DIRECTORY = '../worktrees'
const zedSettingsSchema = z.looseObject({
  'git.worktree_directory': z.string().optional(),
  git: z
    .looseObject({
      worktree_directory: z.string().optional()
    })
    .optional()
})

export interface ZedTask {
  label: string
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
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
  const settingsFile = await readOptionalJsonc(
    path.join(mainWorktreePath, '.zed', 'settings.json')
  )
  const settings = zedSettingsSchema.safeParse(
    settingsFile.found ? settingsFile.value : {}
  )
  if (!settings.success) {
    throw new Error('Zed git.worktree_directory must be a string')
  }

  const configured =
    settings.data['git.worktree_directory'] ??
    settings.data.git?.worktree_directory
  const directorySetting =
    configured === undefined ? DEFAULT_WORKTREE_DIRECTORY : configured.trim()
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

  if (value && typeof value === 'object') {
    const tasks: unknown = Reflect.get(value, 'tasks')
    if (Array.isArray(tasks)) {
      return tasks
    }
  }

  return []
}

export async function loadCreateWorktreeTasks(
  mainWorktreePath: string
): Promise<ZedTask[]> {
  const tasksFile = await readOptionalJsonc(
    path.join(mainWorktreePath, '.zed', 'tasks.json')
  )
  const value = tasksFile.found ? tasksFile.value : null
  return taskArray(value).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }

    const hooks: unknown = Reflect.get(entry, 'hooks')
    if (!Array.isArray(hooks) || !hooks.includes('create_worktree')) {
      return []
    }

    const command: unknown = Reflect.get(entry, 'command')
    const argsInput: unknown = Reflect.get(entry, 'args')
    const environmentInput: unknown = Reflect.get(entry, 'env')
    const cwd: unknown = Reflect.get(entry, 'cwd')
    const label: unknown = Reflect.get(entry, 'label')
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error(
        `Zed create_worktree task ${index + 1} is missing a command`
      )
    }

    if (argsInput !== undefined && !Array.isArray(argsInput)) {
      throw new Error(`Zed create_worktree task ${index + 1} has invalid args`)
    }

    const args = (argsInput ?? []).map((argument) => {
      if (typeof argument !== 'string') {
        throw new Error(
          `Zed create_worktree task ${index + 1} has a non-string argument`
        )
      }

      return argument
    })
    const env: Record<string, string> = {}
    if (environmentInput !== undefined) {
      if (
        !environmentInput ||
        typeof environmentInput !== 'object' ||
        Array.isArray(environmentInput)
      ) {
        throw new Error(`Zed create_worktree task ${index + 1} has invalid env`)
      }

      for (const [key, environmentValue] of Object.entries(environmentInput)) {
        if (typeof environmentValue !== 'string') {
          throw new Error(
            `Zed create_worktree task ${index + 1} has a non-string env value`
          )
        }

        env[key] = environmentValue
      }
    }

    if (cwd !== undefined && typeof cwd !== 'string') {
      throw new Error(`Zed create_worktree task ${index + 1} has invalid cwd`)
    }

    return [
      {
        label:
          typeof label === 'string' && label.trim()
            ? label
            : `Task ${index + 1}`,
        command,
        args,
        ...(typeof cwd === 'string' ? { cwd } : {}),
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

export async function resolveZedCreateWorktreeSetupTasks(input: {
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
