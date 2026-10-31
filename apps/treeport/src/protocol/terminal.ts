import * as Schema from 'effect/Schema'
import {
  terminalSizeSchema,
  terminalRuntimeMetadataSchema
} from './terminal-session.ts'

const nullableStringSchema = Schema.NullOr(Schema.String)

export const TERMINAL_MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024
export const TERMINAL_NAME_MAX_LENGTH = 120
export const TERMINAL_ARGV_MAX_COUNT = 128
export const TERMINAL_EXECUTABLE_MAX_LENGTH = 4_096
export const TERMINAL_ARGUMENT_MAX_LENGTH = 4_096
export const TERMINAL_CAPTURE_DEFAULT_LINES = 200
export const TERMINAL_CAPTURE_MAX_LINES = 5_000
export const TERMINAL_INPUT_MAX_STEPS = 1_024
const TERMINAL_INPUT_TEXT_MAX_LENGTH = 1_048_576

// EXTERNAL: Key names follow tmux send-keys so agents can reuse its syntax.
export const TERMINAL_INPUT_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'BTab',
  'BSpace',
  'Space',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'IC',
  'DC',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12'
] as const

export function formatCommandLine(argv: readonly string[]): string {
  return argv
    .map((value) =>
      /^[\w@%+=:,./-]+$/u.test(value)
        ? value
        : `'${value.replaceAll("'", `'\\''`)}'`
    )
    .join(' ')
}

export type TerminalRecord = typeof terminalRecordSchema.Type

export const terminalCaptureQuerySchema = Schema.Struct({
  lines: Schema.optionalWith(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.between(1, TERMINAL_CAPTURE_MAX_LINES)
    ),
    { default: () => TERMINAL_CAPTURE_DEFAULT_LINES }
  )
})

export const terminalSendInputSchema = Schema.Struct({
  steps: Schema.Array(
    Schema.Union(
      Schema.Struct({
        type: Schema.Literal('text'),
        text: Schema.String.pipe(
          Schema.minLength(1),
          Schema.maxLength(TERMINAL_INPUT_TEXT_MAX_LENGTH)
        ),
        paste: Schema.Boolean
      }),
      Schema.Struct({
        type: Schema.Literal('key'),
        key: Schema.Union(
          Schema.Literal(...TERMINAL_INPUT_KEYS),
          Schema.String.pipe(Schema.length(1))
        ),
        ctrl: Schema.Boolean,
        alt: Schema.Boolean,
        shift: Schema.Boolean
      })
    )
  ).pipe(Schema.minItems(1), Schema.maxItems(TERMINAL_INPUT_MAX_STEPS))
})

export type TerminalSendInput = typeof terminalSendInputSchema.Type

export const terminalNameSchema = Schema.Trim.pipe(
  Schema.minLength(1),
  Schema.maxLength(TERMINAL_NAME_MAX_LENGTH)
)

export const terminalArgvSchema = Schema.Array(Schema.String).pipe(
  Schema.minItems(1),
  Schema.maxItems(TERMINAL_ARGV_MAX_COUNT)
)

export const terminalCommandSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(TERMINAL_ARGUMENT_MAX_LENGTH),
  Schema.filter((value) => value.trim().length > 0 && !value.includes('\0'), {
    message: () => 'Command cannot be blank or contain NUL'
  })
)

export const terminalAfterExitSchema = Schema.Literal(
  'shell',
  'close',
  'closeOnSuccess'
)

export type TerminalAfterExit = typeof terminalAfterExitSchema.Type

const terminalCwdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.filter((value) => value.trim().length > 0 && !value.includes('\0'), {
    message: () => 'Working directory cannot be blank or contain NUL'
  })
)

const terminalEnvironmentKeySchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
  Schema.filter((value) => !value.includes('=') && !value.includes('\0'), {
    message: () => 'Environment keys cannot contain equals or NUL'
  })
)

const terminalEnvironmentSchema = Schema.Record({
  key: terminalEnvironmentKeySchema,
  value: Schema.String.pipe(
    Schema.maxLength(TERMINAL_ARGUMENT_MAX_LENGTH),
    Schema.filter((value) => !value.includes('\0'), {
      message: () => 'Environment values cannot contain NUL'
    })
  )
}).pipe(
  Schema.filter((value) => Object.keys(value).length <= 128, {
    message: () => 'Environment cannot contain more than 128 variables'
  })
)

export const createTerminalSchema = Schema.Struct({
  name: terminalNameSchema,
  command: Schema.optional(terminalCommandSchema),
  afterExit: Schema.optional(terminalAfterExitSchema),
  cwd: Schema.optional(terminalCwdSchema),
  env: Schema.optional(terminalEnvironmentSchema),
  initialSize: Schema.optional(terminalSizeSchema),
  parentTerminalId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})

export const updateTerminalSchema = Schema.Struct({ name: terminalNameSchema })

export const terminalRecordSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    worktreeId: Schema.String,
    name: Schema.String,
    command: nullableStringSchema,
    status: Schema.Literal('running', 'exited', 'missing', 'unavailable'),
    exitCode: Schema.NullOr(Schema.Int),
    unavailableReason: Schema.optional(Schema.NullOr(Schema.String)),
    recoveryPending: Schema.optional(Schema.Boolean),
    commandExitCode: Schema.optional(Schema.NullOr(Schema.Int)),
    parentTerminalId: nullableStringSchema,
    createdAt: Schema.String,
    updatedAt: Schema.String
  })
)

export const terminalResponseSchema = Schema.Struct({
  terminal: terminalRecordSchema
})

export const terminalObservationResponseSchema = Schema.Struct({
  terminal: terminalRecordSchema,
  metadata: terminalRuntimeMetadataSchema
})

export const terminalCaptureResponseSchema = Schema.Struct({
  terminalId: Schema.String,
  capturedAt: Schema.String,
  lineLimit: Schema.Int.pipe(Schema.positive()),
  content: Schema.String
})

export const terminatedTerminalsResponseSchema = Schema.Struct({
  terminated: Schema.NonNegativeInt
})
