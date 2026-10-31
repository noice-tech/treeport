import * as Schema from 'effect/Schema'
import {
  TERMINAL_ARGV_MAX_COUNT,
  TERMINAL_ARGUMENT_MAX_LENGTH,
  TERMINAL_EXECUTABLE_MAX_LENGTH,
  terminalNameSchema
} from './terminal.ts'
import { WORKTREE_TITLE_MAX_LENGTH } from './worktree.ts'

const stringArraySchema = Schema.Array(Schema.String)

const nullableStringSchema = Schema.NullOr(Schema.String)
export const LAUNCHER_ARGUMENT_MAX_COUNT = TERMINAL_ARGV_MAX_COUNT - 1

export type LauncherCommand = typeof launcherCommandSchema.Type

export type Launcher = typeof launcherSchema.Type

export type LauncherDefinitionDiagnostic =
  typeof launcherDefinitionDiagnosticSchema.Type

export type LauncherDefinition = typeof launcherDefinitionSchema.Type

export type LauncherDefinitionListing =
  typeof launcherDefinitionListingSchema.Type

const launcherArgumentSchema = Schema.String.pipe(
  Schema.maxLength(TERMINAL_ARGUMENT_MAX_LENGTH)
)

const launcherExecutableSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(TERMINAL_EXECUTABLE_MAX_LENGTH),
  Schema.filter((value) => value.trim().length > 0, {
    message: () => 'Executable cannot be blank'
  })
)

const launcherArgsSchema = Schema.Array(launcherArgumentSchema).pipe(
  Schema.maxItems(LAUNCHER_ARGUMENT_MAX_COUNT)
)

const launcherTreeTitleSchema = Schema.NullOr(
  Schema.Struct({
    executable: launcherExecutableSchema,
    args: launcherArgsSchema
  })
)

const launcherFields = {
  name: terminalNameSchema,
  executable: launcherExecutableSchema,
  args: launcherArgsSchema,
  closeOnSuccess: Schema.optionalWith(Schema.Boolean, {
    default: () => false
  }),
  treeTitle: Schema.optionalWith(launcherTreeTitleSchema, {
    default: () => null
  })
}

export const repositoryLauncherSchema = Schema.Struct(launcherFields)

const repositoryLauncherIdSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]{0,119}$/, {
    message: () =>
      'Launcher IDs must contain only lowercase letters, numbers, dots, underscores, and hyphens'
  })
)

export const repositoryLaunchersSettingsSchema = Schema.Struct({
  launchers: Schema.optionalWith(
    Schema.Record({
      key: repositoryLauncherIdSchema,
      value: Schema.Unknown
    }),
    { default: () => ({}) }
  )
})

const launcherRevisionSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64)
)

const LAUNCHER_INPUT_PATTERN = /\$\{([a-z][a-z0-9_]*)\}/g
const LAUNCHER_WHOLE_INPUT_PATTERN = /^\$\{([a-z][a-z0-9_]*)\}$/

/** Input names referenced as `${name}` in launcher arguments, in first-use order. */
export function launcherInputNames(args: readonly string[]): string[] {
  return [
    ...new Set(
      args.flatMap((arg) =>
        [...arg.matchAll(LAUNCHER_INPUT_PATTERN)].map((match) => match[1]!)
      )
    )
  ]
}

/**
 * Substitutes inputs inside each argument without shell parsing, so values
 * never split into extra arguments. An argument that is exactly one empty
 * input is omitted, letting `["pi", "${prompt}"]` also start without a prompt.
 */
export function resolveLauncherArgs(
  args: readonly string[],
  inputs: Readonly<Record<string, string>>
): string[] {
  return args.flatMap((arg) => {
    const whole = LAUNCHER_WHOLE_INPUT_PATTERN.exec(arg)

    if (whole && !inputs[whole[1]!]) {
      return []
    }

    return [
      arg.replace(
        LAUNCHER_INPUT_PATTERN,
        (_match, name: string) => inputs[name] ?? ''
      )
    ]
  })
}

export interface LauncherTreeTitle {
  readonly command: readonly string[]
  readonly pendingTitle: string
}

/** The tree title command, plus the launcher's first input to show until it finishes. */
export function resolveLauncherTreeTitle(
  launcher: { name: string; treeTitle: LauncherCommand | null },
  inputs: Readonly<Record<string, string>>
): LauncherTreeTitle | null {
  if (!launcher.treeTitle) {
    return null
  }

  const input = launcherInputNames(launcher.treeTitle.args)
    .map((name) => inputs[name]?.replace(/\s+/gu, ' ').trim())
    .find(Boolean)

  return {
    command: [
      launcher.treeTitle.executable,
      ...resolveLauncherArgs(launcher.treeTitle.args, inputs)
    ],
    pendingTitle: (input ?? launcher.name)
      .slice(0, WORKTREE_TITLE_MAX_LENGTH)
      .trim()
  }
}

export const createLauncherSchema = Schema.Struct(launcherFields)

export const updateLauncherSchema = Schema.Struct({
  ...launcherFields,
  closeOnSuccess: Schema.optional(Schema.Boolean),
  treeTitle: Schema.optional(launcherTreeTitleSchema),
  expectedUpdatedAt: launcherRevisionSchema
})

export const deleteLauncherSchema = Schema.Struct({
  expectedUpdatedAt: launcherRevisionSchema
})

export const launcherDefinitionsQuerySchema = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  worktreeId: Schema.optional(Schema.String)
})

const launcherCommandSchema = Schema.Struct({
  executable: Schema.String,
  args: stringArraySchema
})

const launcherSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  executable: Schema.String,
  args: stringArraySchema,
  closeOnSuccess: Schema.Boolean,
  /** Runs after a new tree starts; its first output line becomes the tree title. */
  treeTitle: Schema.NullOr(launcherCommandSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String
})

const launcherDefinitionSourceSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal('user') }),
  Schema.Struct({
    type: Schema.Literal('repository'),
    format: Schema.Literal('treeport', 'zed')
  }),
  Schema.Struct({
    type: Schema.Literal('package'),
    packageId: Schema.String,
    source: Schema.String,
    scope: Schema.Literal('global', 'project')
  })
)

const launcherDefinitionSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    executable: nullableStringSchema,
    args: stringArraySchema,
    shellCommand: nullableStringSchema,
    cwd: nullableStringSchema,
    env: Schema.Record({ key: Schema.String, value: Schema.String }),
    closeOnSuccess: Schema.Boolean,
    treeTitle: Schema.NullOr(launcherCommandSchema),
    source: launcherDefinitionSourceSchema
  })
)

const launcherDefinitionDiagnosticSchema = Schema.Struct({
  path: Schema.String,
  itemId: nullableStringSchema,
  message: Schema.String
})

export const launcherDefinitionListingSchema = Schema.Struct({
  definitions: Schema.mutable(Schema.Array(launcherDefinitionSchema)),
  diagnostics: Schema.mutable(Schema.Array(launcherDefinitionDiagnosticSchema))
})

export const launchersResponseSchema = Schema.Struct({
  launchers: Schema.Array(launcherSchema)
})

export const launcherResponseSchema = Schema.Struct({
  launcher: launcherSchema
})
