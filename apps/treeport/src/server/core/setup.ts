import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { parseDurationMs } from '../../duration'
import type { CommandRunner } from './command'
import { readOptionalJsonc } from './jsonc'
import { resolveZedCreateWorktreeSetupTasks } from './zed'

const DEFAULT_SETUP_TIMEOUT_MS = 30 * 60_000
const MAX_SETUP_OUTPUT = 4_000
const TREEPORT_SETUP_PATH = path.join('.treeport', 'setup.json')
const TREEPORT_PATH_VARIABLES = [
  'TREEPORT_WORKTREE_PATH',
  'TREEPORT_MAIN_WORKTREE_PATH'
] as const
const TREEPORT_PATH_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  TREEPORT_PATH_VARIABLES
)

const environmentSchema = z
  .record(z.string(), z.string())
  .superRefine((environment, context) => {
    for (const [name, value] of Object.entries(environment)) {
      if (!name || name.includes('=') || name.includes('\0')) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message:
            'Environment names must be non-empty and cannot contain = or NUL'
        })
      }

      if (TREEPORT_PATH_VARIABLE_NAMES.has(name)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} is reserved by Treeport`
        })
      }

      if (value.includes('\0')) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'Environment values cannot contain NUL'
        })
      }
    }
  })

const timeoutSchema = z.string().superRefine((value, context) => {
  try {
    parseDurationMs(value)
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error)
    })
  }
})

const lifecycleCommandSchema = z
  .object({
    name: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1)),
    argv: z
      .array(z.string())
      .min(1)
      .refine((argv) => Boolean(argv[0]?.trim()), {
        message: 'The executable argv element must not be empty'
      }),
    cwd: z
      .string()
      .refine((value) => Boolean(value.trim()), {
        message: 'cwd must not be empty'
      })
      .optional(),
    env: environmentSchema.optional(),
    timeout: timeoutSchema.optional()
  })
  .strict()

const setupFileSchema = z
  .object({
    version: z.literal(1),
    commands: z.array(lifecycleCommandSchema),
    cleanup: z.array(lifecycleCommandSchema).optional()
  })
  .strict()

export interface WorktreeSetupTask {
  label: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
}

export interface WorktreeSetupResult {
  label: string
  error: string | null
}

export interface WorktreeCleanupResolution {
  tasks: WorktreeSetupTask[]
  definitionHash: string | null
}

function formatIssuePath(issuePath: PropertyKey[]): string {
  if (!issuePath.length) {
    return 'configuration'
  }

  return issuePath.reduce<string>((formatted, component) => {
    const parsedIndex = z.number().safeParse(component)
    if (parsedIndex.success) {
      return `${formatted}[${parsedIndex.data}]`
    }

    return formatted ? `${formatted}.${String(component)}` : String(component)
  }, '')
}

function expandTreeportPaths(
  value: string,
  environment: Record<(typeof TREEPORT_PATH_VARIABLES)[number], string>
): string {
  return value.replace(
    /\$\{(TREEPORT_WORKTREE_PATH|TREEPORT_MAIN_WORKTREE_PATH)\}/g,
    (_match, name: (typeof TREEPORT_PATH_VARIABLES)[number]) =>
      environment[name]
  )
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

async function readNativeSetup(mainWorktreePath: string) {
  const filePath = path.join(mainWorktreePath, TREEPORT_SETUP_PATH)
  const file = await readOptionalJsonc(filePath)
  if (!file.found) {
    return { filePath, setup: null }
  }

  const parsed = setupFileSchema.safeParse(file.value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new Error(
      `Invalid Treeport setup in ${filePath}: ${formatIssuePath(issue.path)}: ${issue.message}`
    )
  }

  return { filePath, setup: parsed.data }
}

async function resolveNativeTasks(input: {
  mainWorktreePath: string
  worktreePath: string
  commands: z.infer<typeof lifecycleCommandSchema>[]
  commandPath: 'commands' | 'cleanup'
  filePath: string
}): Promise<WorktreeSetupTask[]> {
  const worktreePath = await fs.realpath(input.worktreePath)
  const environment = {
    TREEPORT_WORKTREE_PATH: worktreePath,
    TREEPORT_MAIN_WORKTREE_PATH: input.mainWorktreePath
  }

  return input.commands.map((command, index) => {
    const expandedCwd = expandTreeportPaths(
      command.cwd ?? worktreePath,
      environment
    )
    const cwd = path.isAbsolute(expandedCwd)
      ? path.resolve(expandedCwd)
      : path.resolve(worktreePath, expandedCwd)
    if (!isPathWithin(cwd, worktreePath)) {
      throw new Error(
        `Invalid Treeport setup in ${input.filePath}: ${input.commandPath}[${index}].cwd must stay inside the tree`
      )
    }

    const configuredEnvironment = Object.fromEntries(
      Object.entries(command.env ?? {}).map(([name, value]) => [
        name,
        expandTreeportPaths(value, environment)
      ])
    )
    return {
      label: command.name,
      argv: command.argv.map((argument) =>
        expandTreeportPaths(argument, environment)
      ),
      cwd,
      env: { ...configuredEnvironment, ...environment },
      timeoutMs: command.timeout
        ? parseDurationMs(command.timeout)
        : DEFAULT_SETUP_TIMEOUT_MS
    }
  })
}

export async function resolveWorktreeSetupTasks(input: {
  shell: string
  mainWorktreePath: string
  worktreePath: string
}): Promise<WorktreeSetupTask[]> {
  const mainWorktreePath = await fs.realpath(input.mainWorktreePath)
  const native = await readNativeSetup(mainWorktreePath)
  if (!native.setup) {
    return resolveZedCreateWorktreeSetupTasks({
      ...input,
      mainWorktreePath,
      worktreePath: await fs.realpath(input.worktreePath)
    })
  }

  return resolveNativeTasks({
    mainWorktreePath,
    worktreePath: input.worktreePath,
    commands: native.setup.commands,
    commandPath: 'commands',
    filePath: native.filePath
  })
}

export async function resolveWorktreeCleanupTasks(input: {
  mainWorktreePath: string
  worktreePath: string
}): Promise<WorktreeCleanupResolution> {
  const mainWorktreePath = await fs.realpath(input.mainWorktreePath)
  const native = await readNativeSetup(mainWorktreePath)
  const commands = native.setup?.cleanup ?? []
  if (commands.length === 0) {
    return { tasks: [], definitionHash: null }
  }

  const tasks = await resolveNativeTasks({
    mainWorktreePath,
    worktreePath: input.worktreePath,
    commands,
    commandPath: 'cleanup',
    filePath: native.filePath
  })
  const definitionHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        tasks.map((task) => ({
          argv: task.argv,
          cwd: task.cwd,
          env: Object.fromEntries(
            Object.entries(task.env).sort(([a], [b]) => a.localeCompare(b))
          ),
          timeoutMs: task.timeoutMs
        }))
      )
    )
    .digest('hex')
  return { tasks, definitionHash }
}

export async function runWorktreeSetupTasks(input: {
  runner: CommandRunner
  tasks: WorktreeSetupTask[]
}): Promise<WorktreeSetupResult[]> {
  const results: WorktreeSetupResult[] = []
  for (const task of input.tasks) {
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
        ).slice(0, MAX_SETUP_OUTPUT)
        results.push({ label: task.label, error: detail })
        break
      }

      results.push({ label: task.label, error: null })
    } catch (error) {
      results.push({
        label: task.label,
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          MAX_SETUP_OUTPUT
        )
      })
      break
    }
  }
  return results
}
