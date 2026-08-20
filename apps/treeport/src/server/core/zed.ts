import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type {
  TerminalPresetDefinition,
  TerminalPresetDefinitionDiagnostic
} from '@treeport/shared'
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
      // SAFETY: The surrounding boundary contract establishes this asserted value.
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
  const name = input
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (!name) {
    throw new Error('Tree name is required')
  }

  if (name.length > 120) {
    throw new Error('Tree name must be 120 characters or fewer')
  }

  return name
}

export function inferWorktreeName(
  mainWorktreePath: string,
  worktreePath: string,
  kind: 'main' | 'linked'
): string {
  if (kind === 'main') {
    return 'main tree'
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
    // SAFETY: The surrounding boundary contract establishes this asserted value.
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

const ZED_TASKS_CONFIG_PATH = path.join('.zed', 'tasks.json')
const zedTaskInputSchema = z.unknown()
type ZedTaskInput = z.input<typeof zedTaskInputSchema>
const zedTaskRecordSchema = z.looseObject({
  command: z.unknown().optional(),
  args: z.unknown().optional(),
  env: z.unknown().optional(),
  cwd: z.unknown().optional(),
  label: z.unknown().optional(),
  hooks: z.unknown().optional()
})

function taskArray(value: ZedTaskInput): ZedTaskInput[] | null {
  const direct = z.array(z.unknown()).safeParse(value)
  if (direct.success) {
    return direct.data
  }

  const wrapped = z.object({ tasks: z.array(z.unknown()) }).safeParse(value)
  return wrapped.success ? wrapped.data.tasks : null
}

function parseTask(
  entry: ZedTaskInput,
  index: number,
  options: { requireLabel: boolean; validateLaunchFields: boolean }
): ZedTask {
  const prefix = `Zed task ${index + 1}`
  const parsedEntry = zedTaskRecordSchema.safeParse(entry)
  if (!parsedEntry.success) {
    throw new Error(`${prefix} must be an object`)
  }

  const {
    args: argsInput,
    command,
    cwd,
    env: environmentInput,
    label
  } = parsedEntry.data
  const parsedLabel = z.string().safeParse(label)
  if (
    (!parsedLabel.success || !parsedLabel.data.trim()) &&
    options.requireLabel
  ) {
    throw new Error(`${prefix} is missing a label`)
  }

  const parsedCommand = z.string().safeParse(command)
  if (!parsedCommand.success || !parsedCommand.data.trim()) {
    throw new Error(`${prefix} is missing a command`)
  }

  if (argsInput !== undefined && !Array.isArray(argsInput)) {
    throw new Error(`${prefix} has invalid args`)
  }

  const parsedArgs = z.array(z.string()).safeParse(argsInput ?? [])
  if (!parsedArgs.success) {
    throw new Error(`${prefix} has a non-string argument`)
  }

  const env: Record<string, string> = {}
  if (environmentInput !== undefined) {
    const parsedEnvironment = z
      .record(z.string(), z.unknown())
      .safeParse(environmentInput)
    if (!parsedEnvironment.success) {
      throw new Error(`${prefix} has invalid env`)
    }

    if (
      options.validateLaunchFields &&
      Object.keys(parsedEnvironment.data).length > 128
    ) {
      throw new Error(`${prefix} has more than 128 environment variables`)
    }

    for (const [key, environmentValue] of Object.entries(
      parsedEnvironment.data
    )) {
      if (
        options.validateLaunchFields &&
        (!key || key.length > 256 || key.includes('=') || key.includes('\0'))
      ) {
        throw new Error(`${prefix} has an invalid env key`)
      }

      const parsedValue = z.string().safeParse(environmentValue)
      if (!parsedValue.success) {
        throw new Error(`${prefix} has a non-string env value`)
      }

      if (
        options.validateLaunchFields &&
        (parsedValue.data.length > 4_096 || parsedValue.data.includes('\0'))
      ) {
        throw new Error(`${prefix} has an invalid env value`)
      }

      env[key] = parsedValue.data
    }
  }

  const parsedCwd = z.string().safeParse(cwd)
  if (cwd !== undefined && !parsedCwd.success) {
    throw new Error(`${prefix} has invalid cwd`)
  }

  if (
    options.validateLaunchFields &&
    parsedCwd.success &&
    (!parsedCwd.data.trim() ||
      parsedCwd.data.length > 4_096 ||
      parsedCwd.data.includes('\0'))
  ) {
    throw new Error(`${prefix} has invalid cwd`)
  }

  const task: ZedTask = {
    label:
      parsedLabel.success && parsedLabel.data.trim()
        ? parsedLabel.data
        : `Task ${index + 1}`,
    command: parsedCommand.data,
    args: parsedArgs.data,
    env
  }
  if (parsedCwd.success) {
    task.cwd = parsedCwd.data
  }

  return task
}

export async function loadCreateWorktreeTasks(
  mainWorktreePath: string
): Promise<ZedTask[]> {
  const tasksFile = await readOptionalJsonc(
    path.join(mainWorktreePath, ZED_TASKS_CONFIG_PATH)
  )
  const entries = taskArray(tasksFile.found ? tasksFile.value : null) ?? []
  return entries.flatMap((entry, index) => {
    const parsedEntry = zedTaskRecordSchema.safeParse(entry)
    const parsedHooks = z
      .array(z.string())
      .safeParse(parsedEntry.success ? parsedEntry.data.hooks : undefined)
    if (!parsedHooks.success || !parsedHooks.data.includes('create_worktree')) {
      return []
    }

    return [
      parseTask(entry, index, {
        requireLabel: false,
        validateLaunchFields: false
      })
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

interface ResolvedZedTask {
  label: string
  argv: string[] | null
  shellCommand: string | null
  cwd: string
  env: Record<string, string>
}

function resolveTask(
  task: ZedTask,
  input: {
    shell: string
    mainWorktreePath: string
    worktreePath: string
  },
  protectCompatibilityEnvironment: boolean
): ResolvedZedTask {
  const compatibilityEnvironment = {
    ZED_WORKTREE_ROOT: input.worktreePath,
    ZED_MAIN_GIT_WORKTREE: input.mainWorktreePath
  }
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
    label: expand(task.label, compatibilityEnvironment),
    argv: useShell ? null : [command, ...args],
    shellCommand: useShell
      ? [command, ...args.map(shellQuote)].join(' ')
      : null,
    cwd,
    env: protectCompatibilityEnvironment
      ? { ...taskEnvironment, ...compatibilityEnvironment }
      : { ...compatibilityEnvironment, ...taskEnvironment }
  }
}

export async function loadZedTerminalPresetDefinitions(input: {
  projectId: string
  shell: string
  mainWorktreePath: string
  worktreePath: string
}): Promise<{
  definitions: TerminalPresetDefinition[]
  diagnostics: TerminalPresetDefinitionDiagnostic[]
}> {
  let tasksFile
  try {
    tasksFile = await readOptionalJsonc(
      path.join(input.mainWorktreePath, ZED_TASKS_CONFIG_PATH)
    )
  } catch (error) {
    return {
      definitions: [],
      diagnostics: [
        {
          path: ZED_TASKS_CONFIG_PATH,
          itemId: null,
          message: `Could not load Zed tasks: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    }
  }

  if (!tasksFile.found) {
    return { definitions: [], diagnostics: [] }
  }

  const entries = taskArray(tasksFile.value)
  if (!entries) {
    return {
      definitions: [],
      diagnostics: [
        {
          path: ZED_TASKS_CONFIG_PATH,
          itemId: null,
          message:
            'Invalid Zed tasks: expected an array or an object with a tasks array'
        }
      ]
    }
  }

  const definitions: TerminalPresetDefinition[] = []
  const diagnostics: TerminalPresetDefinitionDiagnostic[] = []
  for (const [index, entry] of entries.entries()) {
    let task: ZedTask
    try {
      task = parseTask(entry, index, {
        requireLabel: true,
        validateLaunchFields: true
      })
    } catch (error) {
      diagnostics.push({
        path: ZED_TASKS_CONFIG_PATH,
        itemId: String(index + 1),
        message: error instanceof Error ? error.message : String(error)
      })
      continue
    }

    const resolved = resolveTask(task, input, true)
    definitions.push({
      id: `repository:${input.projectId}:zed-task:${index}`,
      name: resolved.label,
      executable: resolved.argv?.[0] ?? null,
      args: resolved.argv?.slice(1) ?? [],
      shellCommand: resolved.shellCommand,
      cwd: resolved.cwd,
      env: resolved.env,
      closeOnSuccess: false,
      source: { type: 'repository', format: 'zed' }
    })
  }

  return { definitions, diagnostics }
}

export async function resolveZedCreateWorktreeSetupTasks(input: {
  shell: string
  mainWorktreePath: string
  worktreePath: string
}): Promise<WorktreeSetupTask[]> {
  const tasks = await loadCreateWorktreeTasks(input.mainWorktreePath)
  return tasks.map((task) => {
    const resolved = resolveTask(task, input, false)
    let argv = resolved.argv
    if (!argv) {
      if (!resolved.shellCommand) {
        throw new Error(`Zed task ${task.label} has no resolved command`)
      }

      argv = [input.shell, '-lc', resolved.shellCommand]
    }

    return {
      label: task.label,
      argv,
      cwd: resolved.cwd,
      env: resolved.env,
      timeoutMs: 30 * 60_000
    }
  })
}
