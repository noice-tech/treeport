/* eslint-disable anti-slop/no-unknown-parameters -- Effect Schema decoders validate untrusted protocol input at this boundary. */
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'

export const SOCKET_PATH = '/api/socket'
export const TERMINAL_PROTOCOL_VERSION = 7
export const TERMINAL_CONTROLLER_GRACE_MS = 10_000
export const TERMINAL_OUTPUT_HIGH_WATERMARK = 256 * 1024
export const TERMINAL_OUTPUT_LOW_WATERMARK = 64 * 1024
export const TERMINAL_OUTPUT_MAX_UNACKNOWLEDGED_BYTES = 4 * 1024 * 1024
export const TERMINAL_MAX_CLIENT_MESSAGE_BYTES = 128 * 1024
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024

export type TerminalProtocolInput =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<TerminalProtocolInput>
  | { readonly [key: string]: TerminalProtocolInput }

const terminalId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)
const clientId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
const streamId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
const generation = Schema.NonNegativeInt
const positiveInt = Schema.Int.pipe(Schema.positive())
const columns = Schema.Int.pipe(Schema.between(2, 1_000))
const rows = Schema.Int.pipe(Schema.between(2, 500))
const dimensions = { cols: columns, rows }
const dateTimeString = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value)), {
    message: () => 'Expected an ISO date and time'
  })
)

export const terminalSizeSchema = Schema.Struct(dimensions)
export type TerminalSize = Schema.Schema.Type<typeof terminalSizeSchema>

export const terminalProgressSchema = Schema.Struct({
  state: Schema.Literal('normal', 'error', 'indeterminate', 'paused'),
  value: Schema.NullOr(Schema.Int.pipe(Schema.between(0, 100)))
})
export type TerminalProgress = Schema.Schema.Type<typeof terminalProgressSchema>

export const terminalProgramSchema = Schema.Literal('pi', 'claude', 'codex')
export type TerminalProgram = Schema.Schema.Type<typeof terminalProgramSchema>

export const terminalRuntimeMetadataFields = {
  terminalId: Schema.String.pipe(Schema.minLength(1)),
  title: Schema.NullOr(Schema.String.pipe(Schema.maxLength(256))),
  program: Schema.optionalWith(Schema.NullOr(terminalProgramSchema), {
    default: () => null
  }),
  hasForegroundProcess: Schema.optional(Schema.NullOr(Schema.Boolean)),
  progress: Schema.NullOr(terminalProgressSchema),
  progressStartedAt: Schema.optionalWith(Schema.NullOr(dateTimeString), {
    default: () => null
  }),
  progressClearedAt: Schema.optionalWith(Schema.NullOr(dateTimeString), {
    default: () => null
  }),
  bell: Schema.optionalWith(
    Schema.NullOr(
      Schema.Struct({
        sequence: positiveInt,
        at: dateTimeString,
        unread: Schema.Boolean
      })
    ),
    { default: () => null }
  )
} as const

export const terminalRuntimeMetadataSchema = Schema.mutable(
  Schema.Struct(terminalRuntimeMetadataFields)
)

export const terminalBellAcknowledgementSchema = Schema.Struct({
  sequence: positiveInt
})
export type TerminalBellAcknowledgement = Schema.Schema.Type<
  typeof terminalBellAcknowledgementSchema
>
export type TerminalRuntimeMetadata = Schema.Schema.Type<
  typeof terminalRuntimeMetadataSchema
>

function decodeOrNull<S extends Schema.Schema<any, any, never>>(
  schema: S,
  value: unknown
): Schema.Schema.Type<S> | null {
  const parsed = Schema.decodeUnknownEither(schema, {
    onExcessProperty: 'error'
  })(value)
  return Either.isRight(parsed) ? parsed.right : null
}

export function parseTerminalRuntimeMetadata(
  value: TerminalProtocolInput
): TerminalRuntimeMetadata | null {
  return decodeOrNull(terminalRuntimeMetadataSchema, value)
}

export function parseTerminalProgress(
  data: string
): TerminalProgress | null | undefined {
  const [command, rawState, rawValue, ...extra] = data.split(';')
  if (command !== '4' || extra.length > 0 || !/^[0-4]$/.test(rawState ?? '')) {
    return undefined
  }

  const state = Number(rawState)
  if (state === 0) {
    return null
  }

  if (
    rawValue !== undefined &&
    rawValue !== '' &&
    !/^\d{1,3}$/.test(rawValue)
  ) {
    return undefined
  }

  const value =
    rawValue === undefined || rawValue === '' ? null : Number(rawValue)
  if (value !== null && value > 100) {
    return undefined
  }

  const states = [
    undefined,
    'normal',
    'error',
    'indeterminate',
    'paused'
  ] as const
  return { state: states[state]!, value }
}

export const terminalAuthSchema = Schema.Struct({
  terminalId,
  clientId,
  ...dimensions
})
export const terminalInputSchema = Schema.Struct({
  generation,
  data: Schema.String.pipe(Schema.maxLength(TERMINAL_MAX_INPUT_BYTES))
})
export const terminalBinarySchema = Schema.Struct({
  generation,
  data: Schema.String.pipe(Schema.maxLength(TERMINAL_MAX_INPUT_BYTES))
})
export const terminalResizeSchema = Schema.Struct({ generation, ...dimensions })
export const terminalTakeControlSchema = Schema.Struct({
  generation,
  ...dimensions
})
export const terminalOutputAckSchema = Schema.Struct({
  streamId,
  sequence: Schema.NonNegativeInt
})
export const terminalQueryAuthorityRequestSchema = Schema.Struct({
  generation,
  transitionId: Schema.NullOr(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
  )
})

const terminalReadyBase = {
  connectionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  streamId,
  generation,
  controller: Schema.Boolean,
  reset: Schema.Literal('full')
}

export const terminalSnapshotLinkSchema = Schema.Struct({
  buffer: Schema.Literal('normal', 'alternate'),
  uri: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  line: Schema.NonNegativeInt,
  startColumn: Schema.NonNegativeInt,
  endColumn: positiveInt
})
export type TerminalSnapshotLink = Schema.Schema.Type<
  typeof terminalSnapshotLinkSchema
>

export const terminalReadySchema = Schema.Struct({
  ...terminalReadyBase,
  ...dimensions,
  revision: positiveInt,
  snapshot: Schema.String,
  snapshotLinks: Schema.optionalWith(
    Schema.Array(terminalSnapshotLinkSchema).pipe(Schema.maxItems(10_000)),
    { default: () => [] }
  )
})
export const terminalDimensionsSchema = Schema.Struct({
  ...dimensions,
  revision: positiveInt
})
export const terminalOutputSchema = Schema.Struct({
  streamId,
  sequence: positiveInt,
  data: Schema.String
})
export const terminalTitleSchema = Schema.Struct({
  title: Schema.String.pipe(Schema.maxLength(256))
})
export const terminalProgressEventSchema = Schema.Struct({
  progress: Schema.NullOr(terminalProgressSchema)
})
export const terminalControlSchema = Schema.Struct({
  generation,
  controller: Schema.Boolean
})
export const terminalExitSchema = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int)
})
export const terminalQueryAuthoritySchema = Schema.Struct({
  generation,
  transitionId: Schema.NullOr(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
  ),
  active: Schema.Boolean
})
export const terminalErrorSchema = Schema.Struct({
  code: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  message: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000)),
  retryable: Schema.Boolean
})

export type TerminalAuth = Schema.Schema.Type<typeof terminalAuthSchema>
export type TerminalInput = Schema.Schema.Type<typeof terminalInputSchema>
export type TerminalBinary = Schema.Schema.Type<typeof terminalBinarySchema>
export type TerminalResize = Schema.Schema.Type<typeof terminalResizeSchema>
export type TerminalTakeControl = Schema.Schema.Type<
  typeof terminalTakeControlSchema
>
export type TerminalTakeControlPayload = TerminalTakeControl
export type TerminalOutputAck = Schema.Schema.Type<
  typeof terminalOutputAckSchema
>
export type TerminalQueryAuthorityRequest = Schema.Schema.Type<
  typeof terminalQueryAuthorityRequestSchema
>
export type TerminalReady = Schema.Schema.Type<typeof terminalReadySchema>
export type TerminalDimensions = Schema.Schema.Type<
  typeof terminalDimensionsSchema
>
export type TerminalOutput = Schema.Schema.Type<typeof terminalOutputSchema>
export type TerminalTitle = Schema.Schema.Type<typeof terminalTitleSchema>
export type TerminalProgressEvent = Schema.Schema.Type<
  typeof terminalProgressEventSchema
>
export type TerminalControl = Schema.Schema.Type<typeof terminalControlSchema>
export type TerminalExit = Schema.Schema.Type<typeof terminalExitSchema>
export type TerminalQueryAuthority = Schema.Schema.Type<
  typeof terminalQueryAuthoritySchema
>
export type TerminalError = Schema.Schema.Type<typeof terminalErrorSchema>

export interface TerminalClientEventPayloads {
  input: TerminalInput
  binary: TerminalBinary
  resize: TerminalResize
  take_control: TerminalTakeControlPayload
  output_ack: TerminalOutputAck
  query_authority: TerminalQueryAuthorityRequest
}
export type TerminalClientEvent = keyof TerminalClientEventPayloads
export type TerminalClientToServerEvents = {
  [Event in TerminalClientEvent]: (
    payload: TerminalClientEventPayloads[Event]
  ) => void
}

export interface TerminalServerEventPayloads {
  ready: TerminalReady
  dimensions: TerminalDimensions
  output: TerminalOutput
  title: TerminalTitle
  progress: TerminalProgressEvent
  control: TerminalControl
  exit: TerminalExit
  query_authority: TerminalQueryAuthority
  terminal_error: TerminalError
}
export type TerminalServerEvent = keyof TerminalServerEventPayloads
export type TerminalServerPayload =
  TerminalServerEventPayloads[TerminalServerEvent]
export type TerminalServerToClientEvents = {
  [Event in TerminalServerEvent]: (
    payload: TerminalServerEventPayloads[Event]
  ) => void
}

export function parseTerminalAuth(
  value: TerminalProtocolInput
): TerminalAuth | null {
  return decodeOrNull(terminalAuthSchema, value)
}

export function parseTerminalClientEvent<E extends TerminalClientEvent>(
  event: E,
  value: TerminalProtocolInput
): TerminalClientEventPayloads[E] | null {
  const schema = {
    input: terminalInputSchema,
    binary: terminalBinarySchema,
    resize: terminalResizeSchema,
    take_control: terminalTakeControlSchema,
    output_ack: terminalOutputAckSchema,
    query_authority: terminalQueryAuthorityRequestSchema
  }[event]
  // SAFETY: The event key selects one schema from the client payload map.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- TypeScript cannot correlate a generic key with an indexed schema map.
  const selected = schema as unknown as Schema.Schema<unknown, unknown, never>
  const parsed = Schema.decodeUnknownEither(selected, {
    onExcessProperty: 'error'
  })(value)
  // SAFETY: The event key selects the corresponding payload schema above.
  return Either.isRight(parsed)
    ? (parsed.right as TerminalClientEventPayloads[E])
    : null
}

export function parseTerminalServerEvent<E extends TerminalServerEvent>(
  event: E,
  value: TerminalProtocolInput
): TerminalServerEventPayloads[E] | null {
  const schema = {
    ready: terminalReadySchema,
    dimensions: terminalDimensionsSchema,
    output: terminalOutputSchema,
    title: terminalTitleSchema,
    progress: terminalProgressEventSchema,
    control: terminalControlSchema,
    exit: terminalExitSchema,
    query_authority: terminalQueryAuthoritySchema,
    terminal_error: terminalErrorSchema
  }[event]
  // SAFETY: The event key selects one schema from the server payload map.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- TypeScript cannot correlate a generic key with an indexed schema map.
  const selected = schema as unknown as Schema.Schema<unknown, unknown, never>
  const parsed = Schema.decodeUnknownEither(selected, {
    onExcessProperty: 'error'
  })(value)
  // SAFETY: The event key selects the corresponding payload schema above.
  return Either.isRight(parsed)
    ? (parsed.right as TerminalServerEventPayloads[E])
    : null
}
