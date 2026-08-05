import { z } from 'zod'

export const SOCKET_IO_PATH = '/api/socket.io/'
export const TERMINAL_PROTOCOL_VERSION = 2
export const TERMINAL_CONTROLLER_GRACE_MS = 10_000
export const TERMINAL_OUTPUT_HIGH_WATERMARK = 256 * 1024
export const TERMINAL_OUTPUT_LOW_WATERMARK = 64 * 1024
export const TERMINAL_OUTPUT_STALL_TIMEOUT_MS = 30_000
export const TERMINAL_MAX_CLIENT_MESSAGE_BYTES = 128 * 1024
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024
export const TERMINAL_SCROLL_EXIT_SEQUENCE = '\u001b[9000~'
export const TERMINAL_SELECTION_START_SEQUENCE = '\u001b[9001~'
export const TERMINAL_SELECTION_STOP_SEQUENCE = '\u001b[9002~'
export const TERMINAL_SELECTION_CLEAR_SEQUENCE = '\u001b[9003~'
export const TERMINAL_SELECTION_RESTORE_SEQUENCE = '\u001b[9004~'

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

export const terminalRuntimeMetadataSchema = z.strictObject({
  terminalId: z.string().min(1),
  title: z.string().max(256).nullable(),
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
  value: unknown
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
export const terminalLegacyTakeControlSchema = z.strictObject({ generation })
export const terminalOutputAckSchema = z.strictObject({
  streamId,
  sequence: z.number().int().nonnegative()
})

const terminalReadyBase = {
  connectionId: z.string().min(1).max(128),
  streamId,
  generation,
  controller: z.boolean(),
  reset: z.literal('full')
}

export const terminalLegacyReadySchema = z.strictObject(terminalReadyBase)
export const terminalReadyV2Schema = z.strictObject({
  ...terminalReadyBase,
  ...dimensions,
  revision: z.number().int().positive()
})
export const terminalReadySchema = z.union([
  terminalLegacyReadySchema,
  terminalReadyV2Schema
])
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
export const terminalHistorySchema = z.strictObject({
  viewing: z.boolean()
})
export const terminalControlSchema = z.strictObject({
  generation,
  controller: z.boolean()
})
export const terminalExitSchema = z.strictObject({
  exitCode: z.number().int().nullable()
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
export type TerminalLegacyTakeControl = z.infer<
  typeof terminalLegacyTakeControlSchema
>
export type TerminalTakeControlPayload =
  | TerminalTakeControl
  | TerminalLegacyTakeControl
export type TerminalOutputAck = z.infer<typeof terminalOutputAckSchema>
export type TerminalLegacyReady = z.infer<typeof terminalLegacyReadySchema>
export type TerminalReadyV2 = z.infer<typeof terminalReadyV2Schema>
export type TerminalReady = TerminalLegacyReady | TerminalReadyV2
export type TerminalDimensions = z.infer<typeof terminalDimensionsSchema>
export type TerminalOutput = z.infer<typeof terminalOutputSchema>
export type TerminalTitle = z.infer<typeof terminalTitleSchema>
export type TerminalProgressEvent = z.infer<typeof terminalProgressEventSchema>
export type TerminalHistory = z.infer<typeof terminalHistorySchema>
export type TerminalControl = z.infer<typeof terminalControlSchema>
export type TerminalExit = z.infer<typeof terminalExitSchema>
export type TerminalError = z.infer<typeof terminalErrorSchema>

export interface TerminalClientEventPayloads {
  input: TerminalInput
  binary: TerminalBinary
  resize: TerminalResize
  take_control: TerminalTakeControlPayload
  output_ack: TerminalOutputAck
}

export type TerminalClientEvent = keyof TerminalClientEventPayloads

export interface TerminalClientToServerEvents {
  input: (payload: TerminalInput) => void
  binary: (payload: TerminalBinary) => void
  resize: (payload: TerminalResize) => void
  take_control: (payload: TerminalTakeControlPayload) => void
  output_ack: (payload: TerminalOutputAck) => void
}

export interface TerminalServerEventPayloads {
  ready: TerminalReady
  dimensions: TerminalDimensions
  output: TerminalOutput
  title: TerminalTitle
  progress: TerminalProgressEvent
  history: TerminalHistory
  control: TerminalControl
  exit: TerminalExit
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
  history: (payload: TerminalHistory) => void
  control: (payload: TerminalControl) => void
  exit: (payload: TerminalExit) => void
  terminal_error: (payload: TerminalError) => void
}

export function parseTerminalAuth(value: unknown): TerminalAuth | null {
  const parsed = terminalAuthSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function parseTerminalClientEvent<E extends TerminalClientEvent>(
  event: E,
  value: unknown
): TerminalClientEventPayloads[E] | null {
  const schema = {
    input: terminalInputSchema,
    binary: terminalBinarySchema,
    resize: terminalResizeSchema,
    take_control: z.union([
      terminalLegacyTakeControlSchema,
      terminalTakeControlSchema
    ]),
    output_ack: terminalOutputAckSchema
  }[event]
  const parsed = schema.safeParse(value)
  return parsed.success ? (parsed.data as TerminalClientEventPayloads[E]) : null
}

export function parseTerminalServerEvent<E extends TerminalServerEvent>(
  event: E,
  value: unknown
): TerminalServerEventPayloads[E] | null {
  const schema = {
    ready: terminalReadySchema,
    dimensions: terminalDimensionsSchema,
    output: terminalOutputSchema,
    title: terminalTitleSchema,
    progress: terminalProgressEventSchema,
    history: terminalHistorySchema,
    control: terminalControlSchema,
    exit: terminalExitSchema,
    terminal_error: terminalErrorSchema
  }[event]
  const parsed = schema.safeParse(value)
  return parsed.success ? (parsed.data as TerminalServerEventPayloads[E]) : null
}
