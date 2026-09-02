import { z } from 'zod'

export const SOCKET_IO_PATH = '/api/socket.io/'
export const TERMINAL_PROTOCOL_VERSION = 6
export const TERMINAL_CONTROLLER_GRACE_MS = 10_000
export const TERMINAL_OUTPUT_HIGH_WATERMARK = 256 * 1024
export const TERMINAL_OUTPUT_LOW_WATERMARK = 64 * 1024
export const TERMINAL_OUTPUT_MAX_UNACKNOWLEDGED_BYTES = 4 * 1024 * 1024
export const TERMINAL_MAX_CLIENT_MESSAGE_BYTES = 128 * 1024
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024

const terminalProtocolInputSchema = z.unknown()
export type TerminalProtocolInput = z.input<typeof terminalProtocolInputSchema>

const terminalId = z.string().min(1).max(128)
const clientId = z.string().min(1).max(128)
const streamId = z.string().min(1).max(128)
const generation = z.number().int().nonnegative()
const dimensions = {
  cols: z.number().int().min(2).max(1_000),
  rows: z.number().int().min(2).max(500)
}

export const terminalSizeSchema = z.strictObject(dimensions)
export type TerminalSize = z.infer<typeof terminalSizeSchema>

export const terminalProgressSchema = z.strictObject({
  state: z.enum(['normal', 'error', 'indeterminate', 'paused']),
  value: z.number().int().min(0).max(100).nullable()
})

export type TerminalProgress = z.infer<typeof terminalProgressSchema>

export const terminalProgramSchema = z.enum(['pi', 'claude', 'codex'])
export type TerminalProgram = z.infer<typeof terminalProgramSchema>

export const terminalRuntimeMetadataSchema = z.strictObject({
  terminalId: z.string().min(1),
  title: z.string().max(256).nullable(),
  program: terminalProgramSchema.nullable().default(null),
  hasForegroundProcess: z.boolean().nullable().optional(),
  progress: terminalProgressSchema.nullable(),
  progressStartedAt: z.string().datetime().nullable().default(null),
  progressClearedAt: z.string().datetime().nullable().default(null),
  bell: z
    .strictObject({
      sequence: z.number().int().positive(),
      at: z.string().datetime(),
      unread: z.boolean()
    })
    .nullable()
    .default(null)
})

export const terminalBellAcknowledgementSchema = z.strictObject({
  sequence: z.number().int().positive()
})

export type TerminalBellAcknowledgement = z.infer<
  typeof terminalBellAcknowledgementSchema
>

export type TerminalRuntimeMetadata = z.infer<
  typeof terminalRuntimeMetadataSchema
>

export function parseTerminalRuntimeMetadata(
  value: TerminalProtocolInput
): TerminalRuntimeMetadata | null {
  const parsed = terminalRuntimeMetadataSchema.safeParse(value)
  return parsed.success ? parsed.data : null
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

export const terminalAuthSchema = z.strictObject({
  terminalId,
  clientId,
  ...dimensions
})
export const terminalInputSchema = z.strictObject({
  generation,
  data: z.string().max(TERMINAL_MAX_INPUT_BYTES)
})
export const terminalBinarySchema = z.strictObject({
  generation,
  data: z.string().max(TERMINAL_MAX_INPUT_BYTES)
})
export const terminalResizeSchema = z.strictObject({
  generation,
  ...dimensions
})
export const terminalTakeControlSchema = z.strictObject({
  generation,
  ...dimensions
})
export const terminalOutputAckSchema = z.strictObject({
  streamId,
  sequence: z.number().int().nonnegative()
})
export const terminalQueryAuthorityRequestSchema = z.strictObject({
  generation,
  transitionId: z.string().min(1).max(128).nullable()
})

const terminalReadyBase = {
  connectionId: z.string().min(1).max(128),
  streamId,
  generation,
  controller: z.boolean(),
  reset: z.literal('full')
}

export const terminalSnapshotLinkSchema = z.strictObject({
  buffer: z.enum(['normal', 'alternate']),
  uri: z.string().min(1).max(4_096),
  line: z.number().int().nonnegative(),
  startColumn: z.number().int().nonnegative(),
  endColumn: z.number().int().positive()
})
export type TerminalSnapshotLink = z.infer<typeof terminalSnapshotLinkSchema>

export const terminalReadySchema = z.strictObject({
  ...terminalReadyBase,
  ...dimensions,
  revision: z.number().int().positive(),
  snapshot: z.string(),
  snapshotLinks: z.array(terminalSnapshotLinkSchema).max(10_000).default([])
})
export const terminalDimensionsSchema = z.strictObject({
  ...dimensions,
  revision: z.number().int().positive()
})
export const terminalOutputSchema = z.strictObject({
  streamId,
  sequence: z.number().int().positive(),
  data: z.string()
})
export const terminalTitleSchema = z.strictObject({
  title: z.string().max(256)
})
export const terminalProgressEventSchema = z.strictObject({
  progress: terminalProgressSchema.nullable()
})
export const terminalControlSchema = z.strictObject({
  generation,
  controller: z.boolean()
})
export const terminalExitSchema = z.strictObject({
  exitCode: z.number().int().nullable()
})
export const terminalQueryAuthoritySchema = z.strictObject({
  generation,
  transitionId: z.string().min(1).max(128).nullable(),
  active: z.boolean()
})
export const terminalErrorSchema = z.strictObject({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(1_000),
  retryable: z.boolean()
})

export type TerminalAuth = z.infer<typeof terminalAuthSchema>
export type TerminalInput = z.infer<typeof terminalInputSchema>
export type TerminalBinary = z.infer<typeof terminalBinarySchema>
export type TerminalResize = z.infer<typeof terminalResizeSchema>
export type TerminalTakeControl = z.infer<typeof terminalTakeControlSchema>
export type TerminalTakeControlPayload = TerminalTakeControl
export type TerminalOutputAck = z.infer<typeof terminalOutputAckSchema>
export type TerminalQueryAuthorityRequest = z.infer<
  typeof terminalQueryAuthorityRequestSchema
>
export type TerminalReady = z.infer<typeof terminalReadySchema>
export type TerminalDimensions = z.infer<typeof terminalDimensionsSchema>
export type TerminalOutput = z.infer<typeof terminalOutputSchema>
export type TerminalTitle = z.infer<typeof terminalTitleSchema>
export type TerminalProgressEvent = z.infer<typeof terminalProgressEventSchema>
export type TerminalControl = z.infer<typeof terminalControlSchema>
export type TerminalExit = z.infer<typeof terminalExitSchema>
export type TerminalQueryAuthority = z.infer<
  typeof terminalQueryAuthoritySchema
>
export type TerminalError = z.infer<typeof terminalErrorSchema>

export interface TerminalClientEventPayloads {
  input: TerminalInput
  binary: TerminalBinary
  resize: TerminalResize
  take_control: TerminalTakeControlPayload
  output_ack: TerminalOutputAck
  query_authority: TerminalQueryAuthorityRequest
}

export type TerminalClientEvent = keyof TerminalClientEventPayloads

export interface TerminalClientToServerEvents {
  input: (payload: TerminalInput) => void
  binary: (payload: TerminalBinary) => void
  resize: (payload: TerminalResize) => void
  take_control: (payload: TerminalTakeControlPayload) => void
  output_ack: (payload: TerminalOutputAck) => void
  query_authority: (payload: TerminalQueryAuthorityRequest) => void
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

export interface TerminalServerToClientEvents {
  ready: (payload: TerminalReady) => void
  dimensions: (payload: TerminalDimensions) => void
  output: (payload: TerminalOutput) => void
  title: (payload: TerminalTitle) => void
  progress: (payload: TerminalProgressEvent) => void
  control: (payload: TerminalControl) => void
  exit: (payload: TerminalExit) => void
  query_authority: (payload: TerminalQueryAuthority) => void
  terminal_error: (payload: TerminalError) => void
}

export function parseTerminalAuth(
  value: TerminalProtocolInput
): TerminalAuth | null {
  const parsed = terminalAuthSchema.safeParse(value)
  return parsed.success ? parsed.data : null
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
  const parsed = schema.safeParse(value)
  // SAFETY: The Zod schema validated the event payload before this assertion.
  return parsed.success ? (parsed.data as TerminalClientEventPayloads[E]) : null
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
  const parsed = schema.safeParse(value)
  // SAFETY: The Zod schema validated the event payload before this assertion.
  return parsed.success ? (parsed.data as TerminalServerEventPayloads[E]) : null
}
