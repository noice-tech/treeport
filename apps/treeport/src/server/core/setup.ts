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

const setupCommandSchema = z
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
    commands: z.array(setupCommandSchema)
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

export async function resolveWorktreeSetupTasks(input: {
  shell: string
  mainWorktreePath: string
  worktreePath: string
}): Promise<WorktreeSetupTask[]> {
  const [mainWorktreePath, worktreePath] = await Promise.all([
    fs.realpath(input.mainWorktreePath),
    fs.realpath(input.worktreePath)
  ])
  const filePath = path.join(mainWorktreePath, TREEPORT_SETUP_PATH)
  const file = await readOptionalJsonc(filePath)
  if (!file.found) {
    return resolveZedCreateWorktreeSetupTasks({
      ...input,
      mainWorktreePath,
      worktreePath
    })
  }

  const parsed = setupFileSchema.safeParse(file.value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new Error(
      `Invalid Treeport setup in ${filePath}: ${formatIssuePath(issue.path)}: ${issue.message}`
    )
  }

  const environment = {
    TREEPORT_WORKTREE_PATH: worktreePath,
    TREEPORT_MAIN_WORKTREE_PATH: mainWorktreePath
  }

  return parsed.data.commands.map((command, index) => {
    const expandedCwd = expandTreeportPaths(
      command.cwd ?? worktreePath,
      environment
    )
    const cwd = path.isAbsolute(expandedCwd)
      ? path.resolve(expandedCwd)
      : path.resolve(worktreePath, expandedCwd)
    if (!isPathWithin(cwd, worktreePath)) {
      throw new Error(
        `Invalid Treeport setup in ${filePath}: commands[${index}].cwd must stay inside the new worktree`
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
