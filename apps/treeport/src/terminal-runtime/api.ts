import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type {
  HostedTerminal,
  TerminalHostRuntimeEvent,
  TerminalImageSnapshot,
  TerminalLaunchSpec,
  TerminalProgress,
  TerminalSessionState,
  TerminalSnapshotLink,
  TerminalTitleState,
  TerminalTraceContext
} from './contract'

const TERMINAL_HOST_MAX_FRAME_BYTES = 64 * 1024 * 1024

export class TerminalHostFrameEncodeError extends Data.TaggedError(
  'TerminalHostFrameEncodeError'
)<{ readonly cause: unknown }> {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export class TerminalHostFrameDecodeError extends Data.TaggedError(
  'TerminalHostFrameDecodeError'
)<{ readonly cause: unknown }> {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export class TerminalHostConnectionError extends Data.TaggedError(
  'TerminalHostConnectionError'
)<{ readonly cause: unknown }> {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export class TerminalHostDisconnected extends Data.TaggedError(
  'TerminalHostDisconnected'
)<{ readonly message: string }> {}

export class TerminalHostRequestTimeout extends Data.TaggedError(
  'TerminalHostRequestTimeout'
)<{ readonly method: TerminalHostRequestMethod }> {
  override get message() {
    return `Terminal host request timed out: ${this.method}`
  }
}

export class TerminalHostRequestError extends Data.TaggedError(
  'TerminalHostRequestError'
)<{
  readonly code: string
  readonly message: string
  readonly liveSessionCount?: number | undefined
}> {}

export type TerminalHostClientError =
  | TerminalHostFrameEncodeError
  | TerminalHostFrameDecodeError
  | TerminalHostConnectionError
  | TerminalHostDisconnected
  | TerminalHostRequestTimeout
  | TerminalHostRequestError

const nonEmptyString = Schema.String.pipe(Schema.minLength(1))
const positiveInteger = Schema.Int.pipe(Schema.positive())

const terminalHostRecordFields = {
  hostId: nonEmptyString,
  hostKey: nonEmptyString,
  pid: positiveInteger,
  socketPath: nonEmptyString,
  startedAt: nonEmptyString,
  launcherPath: Schema.optional(nonEmptyString),
  provisional: Schema.optional(Schema.Boolean)
}
const terminalHostRecordSchema = Schema.Struct(terminalHostRecordFields)

export type TerminalHostRecord = typeof terminalHostRecordSchema.Type

const terminalSizeSchema = Schema.Struct({
  cols: positiveInteger,
  rows: positiveInteger
})
const terminalIdSchema = Schema.Struct({ terminalId: nonEmptyString })
const worktreeIdSchema = Schema.Struct({ worktreeId: nonEmptyString })
const setupTaskSchema = Schema.Struct({
  label: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record({ key: Schema.String, value: Schema.String }),
  timeoutMs: Schema.Number.pipe(Schema.positive())
})
const createSchema = Schema.Struct({
  terminalId: nonEmptyString,
  worktreeId: nonEmptyString,
  name: Schema.String,
  createdAt: Schema.String,
  cwd: Schema.String,
  argv: Schema.Array(Schema.String),
  initialTitle: Schema.optional(Schema.String),
  shellCommand: Schema.NullOr(Schema.String),
  interactiveShell: Schema.Boolean,
  fallbackArgv: Schema.optional(Schema.Array(Schema.String)),
  closeOnSuccess: Schema.optional(Schema.Boolean),
  initialSize: Schema.optional(terminalSizeSchema),
  env: Schema.Record({ key: Schema.String, value: Schema.String }),
  setupTasks: Schema.optional(Schema.Array(setupTaskSchema)),
  setupError: Schema.optional(Schema.String)
})

export type TerminalHostCreateInput = typeof createSchema.Type & {
  readonly setupTasks?: TerminalLaunchSpec['setupTasks'] | undefined
}

const terminalHostInputSchemas = {
  handshake: Schema.Struct({
    token: Schema.String,
    hostKey: Schema.String,
    startupTransactionId: Schema.optional(Schema.String),
    readOnly: Schema.optional(Schema.Boolean)
  }),
  commitStartup: Schema.Struct({ startupTransactionId: nonEmptyString }),
  abortStartup: Schema.Struct({ startupTransactionId: nonEmptyString }),
  create: createSchema,
  inventory: worktreeIdSchema,
  state: terminalIdSchema,
  attach: terminalIdSchema,
  unsubscribeOutput: terminalIdSchema,
  subscribeRuntime: terminalIdSchema,
  unsubscribeRuntime: terminalIdSchema,
  runtimeState: terminalIdSchema,
  write: Schema.Struct({
    terminalId: Schema.String,
    data: Schema.String,
    encoding: Schema.Literal('utf8', 'base64'),
    authority: Schema.Struct({
      attachmentId: Schema.String,
      generation: positiveInteger
    })
  }),
  prepareQueryAuthority: terminalIdSchema,
  activateQueryAuthority: Schema.Struct({
    terminalId: nonEmptyString,
    transitionId: Schema.String,
    attachmentId: Schema.String,
    generation: positiveInteger,
    cellSize: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          width: Schema.Number.pipe(Schema.between(1, 100)),
          height: Schema.Number.pipe(Schema.between(1, 200))
        })
      )
    )
  }),
  hostQueryAuthority: terminalIdSchema,
  resize: Schema.Struct({
    terminalId: nonEmptyString,
    cols: positiveInteger,
    rows: positiveInteger
  }),
  capture: Schema.Struct({
    terminalId: nonEmptyString,
    lines: positiveInteger
  }),
  rename: Schema.Struct({
    terminalId: nonEmptyString,
    name: Schema.String,
    updatedAt: Schema.String
  }),
  processes: worktreeIdSchema,
  titleState: terminalIdSchema,
  signal: Schema.Struct({
    terminalId: nonEmptyString,
    signal: Schema.Literal('SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP')
  }),
  kill: terminalIdSchema,
  killWorktree: worktreeIdSchema,
  shutdown: Schema.Struct({ ifEmpty: Schema.Literal(true) })
} as const

const TERMINAL_HOST_REQUEST_METHODS = [
  'handshake',
  'commitStartup',
  'abortStartup',
  'create',
  'inventory',
  'state',
  'attach',
  'unsubscribeOutput',
  'subscribeRuntime',
  'unsubscribeRuntime',
  'runtimeState',
  'write',
  'prepareQueryAuthority',
  'activateQueryAuthority',
  'hostQueryAuthority',
  'resize',
  'capture',
  'rename',
  'processes',
  'titleState',
  'signal',
  'kill',
  'killWorktree',
  'shutdown'
] as const satisfies readonly (keyof typeof terminalHostInputSchemas)[]

export type TerminalHostRequestMethod =
  (typeof TERMINAL_HOST_REQUEST_METHODS)[number]

export function isTerminalHostRequestMethod(
  method: string
): method is TerminalHostRequestMethod {
  // SAFETY: The readonly tuple is widened only to use Array.includes for a string candidate.
  return (TERMINAL_HOST_REQUEST_METHODS as readonly string[]).includes(method)
}
export type TerminalHostRequestInput<
  Method extends TerminalHostRequestMethod = TerminalHostRequestMethod
> = (typeof terminalHostInputSchemas)[Method]['Type']

export interface TerminalHostRequestFrame {
  type: 'request'
  id: string
  method: string
  input: object
  trace?: TerminalTraceContext | undefined
}

export interface TerminalHostResponseFrame {
  type: 'response'
  id: string
  result: TerminalHostResult
  error: {
    code: string
    message: string
    liveSessionCount?: number | undefined
  } | null
}

export type TerminalHostEventFrame =
  | {
      type: 'event'
      event: 'output'
      data: { terminalId: string; output: string; sequence: number }
    }
  | {
      type: 'event'
      event: 'runtime'
      data: { terminalId: string; value: TerminalHostRuntimeEvent }
    }

export type TerminalHostFrame =
  | TerminalHostRequestFrame
  | TerminalHostResponseFrame
  | TerminalHostEventFrame

export interface TerminalHostResults {
  handshake: TerminalHostRecord & {
    liveSessionCount: number
  }
  commitStartup: null
  abortStartup: null
  create: null
  inventory: HostedTerminal[]
  state: TerminalSessionState
  attach: {
    data: string
    links?: TerminalSnapshotLink[] | undefined
    images?: TerminalImageSnapshot | null | undefined
    fence: number
    cols: number
    rows: number
  } | null
  unsubscribeOutput: null
  subscribeRuntime: null
  unsubscribeRuntime: null
  runtimeState: {
    title: string | null
    status: HostedTerminal['status']
    progress: TerminalProgress | null
    bell: { sequence: number; at: string } | null
  } | null
  write: null
  prepareQueryAuthority: { transitionId: string; fence: number }
  activateQueryAuthority: null
  hostQueryAuthority: null
  resize: null
  capture: string | null
  rename: null
  processes: Array<{ pid: number; terminalId: string }>
  titleState: TerminalTitleState | null
  signal: null
  kill: null
  killWorktree: string[]
  shutdown: null
}

export type TerminalHostResult = TerminalHostResults[keyof TerminalHostResults]

const traceSchema = Schema.Struct({
  traceId: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{32}$/)),
  spanId: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{16}$/)),
  sampled: Schema.Boolean
})
const runtimeEventSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  progress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        state: Schema.Literal('normal', 'error', 'indeterminate', 'paused'),
        value: Schema.NullOr(Schema.Int.pipe(Schema.between(0, 100)))
      })
    )
  ),
  bell: Schema.optional(
    Schema.Struct({ sequence: positiveInteger, at: Schema.String })
  ),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  titleState: Schema.optional(
    Schema.Struct({
      terminalTitle: Schema.NullOr(Schema.String),
      currentCommand: Schema.NullOr(Schema.String),
      commandLine: Schema.optional(Schema.NullOr(Schema.String))
    })
  )
})

const terminalProgressSchema = Schema.Struct({
  state: Schema.Literal('normal', 'error', 'indeterminate', 'paused'),
  value: Schema.NullOr(Schema.Int.pipe(Schema.between(0, 100)))
})
const terminalSnapshotLinkSchema = Schema.Struct({
  buffer: Schema.Literal('normal', 'alternate'),
  uri: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  line: Schema.NonNegativeInt,
  startColumn: Schema.NonNegativeInt,
  endColumn: positiveInteger
})
const imageNumber = Schema.Number.pipe(Schema.finite())
const terminalImageCommandSchema = Schema.Struct({
  columns: Schema.optional(imageNumber),
  rows: Schema.optional(imageNumber),
  x: Schema.optional(imageNumber),
  y: Schema.optional(imageNumber),
  sourceWidth: Schema.optional(imageNumber),
  sourceHeight: Schema.optional(imageNumber),
  xOffset: Schema.optional(imageNumber),
  yOffset: Schema.optional(imageNumber),
  zIndex: Schema.optional(imageNumber),
  cursorMovement: Schema.optional(imageNumber),
  placementId: Schema.optional(imageNumber)
})
const terminalImageSnapshotSchema = Schema.Struct({
  nextImageId: positiveInteger,
  images: Schema.Array(
    Schema.Struct({
      id: Schema.NonNegativeInt,
      data: Schema.String.pipe(Schema.maxLength(24 * 1024 * 1024)),
      width: Schema.NonNegativeInt,
      height: Schema.NonNegativeInt,
      format: Schema.Number,
      compression: Schema.String.pipe(Schema.maxLength(1))
    })
  ).pipe(Schema.maxItems(256)),
  placements: Schema.Array(
    Schema.Struct({
      imageId: Schema.NonNegativeInt,
      command: terminalImageCommandSchema,
      cellSize: Schema.Struct({
        width: Schema.Number.pipe(Schema.between(1, 100)),
        height: Schema.Number.pipe(Schema.between(1, 200))
      }),
      buffer: Schema.Literal('normal', 'alternate'),
      tiles: Schema.Array(
        Schema.Tuple(
          Schema.NonNegativeInt,
          Schema.NonNegativeInt,
          Schema.NonNegativeInt,
          positiveInteger
        )
      ).pipe(Schema.maxItems(1_000_000))
    })
  ).pipe(Schema.maxItems(2_048)),
  pending: Schema.String.pipe(Schema.maxLength(24 * 1024 * 1024))
})

const terminalStatusSchema = Schema.Literal('running', 'exited')
const terminalTitleStateSchema = Schema.Struct({
  terminalTitle: Schema.NullOr(Schema.String),
  currentCommand: Schema.NullOr(Schema.String),
  commandLine: Schema.optional(Schema.NullOr(Schema.String))
})
const hostedTerminalSchema = Schema.Struct({
  id: Schema.String,
  worktreeId: Schema.String,
  name: Schema.String,
  argv: Schema.Array(Schema.String),
  shellCommand: Schema.NullOr(Schema.String),
  interactiveShell: Schema.Boolean,
  closeOnSuccess: Schema.Boolean,
  status: terminalStatusSchema,
  exitCode: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  updatedAt: Schema.String
})
const nullResultSchema = Schema.Null
const terminalHostResultSchemas = {
  handshake: Schema.Struct({
    ...terminalHostRecordFields,
    liveSessionCount: Schema.NonNegativeInt
  }),
  commitStartup: nullResultSchema,
  abortStartup: nullResultSchema,
  create: nullResultSchema,
  inventory: Schema.Array(hostedTerminalSchema),
  state: Schema.Struct({
    status: Schema.Literal('running', 'exited', 'missing'),
    exitCode: Schema.NullOr(Schema.Int)
  }),
  attach: Schema.NullOr(
    Schema.Struct({
      data: Schema.String,
      links: Schema.optional(Schema.Array(terminalSnapshotLinkSchema)),
      images: Schema.optional(Schema.NullOr(terminalImageSnapshotSchema)),
      fence: Schema.NonNegativeInt,
      cols: positiveInteger,
      rows: positiveInteger
    })
  ),
  unsubscribeOutput: nullResultSchema,
  subscribeRuntime: nullResultSchema,
  unsubscribeRuntime: nullResultSchema,
  runtimeState: Schema.NullOr(
    Schema.Struct({
      title: Schema.NullOr(Schema.String),
      status: terminalStatusSchema,
      progress: Schema.NullOr(terminalProgressSchema),
      bell: Schema.NullOr(
        Schema.Struct({ sequence: positiveInteger, at: Schema.String })
      )
    })
  ),
  write: nullResultSchema,
  prepareQueryAuthority: Schema.Struct({
    transitionId: Schema.String,
    fence: Schema.NonNegativeInt
  }),
  activateQueryAuthority: nullResultSchema,
  hostQueryAuthority: nullResultSchema,
  resize: nullResultSchema,
  capture: Schema.NullOr(Schema.String),
  rename: nullResultSchema,
  processes: Schema.Array(
    Schema.Struct({ pid: positiveInteger, terminalId: Schema.String })
  ),
  titleState: Schema.NullOr(terminalTitleStateSchema),
  signal: nullResultSchema,
  kill: nullResultSchema,
  killWorktree: Schema.Array(Schema.String),
  shutdown: nullResultSchema
} as const

const terminalHostFrameSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('request'),
    id: Schema.String,
    method: nonEmptyString,
    input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    trace: Schema.optional(traceSchema)
  }),
  Schema.Struct({
    type: Schema.Literal('response'),
    id: Schema.String,
    result: Schema.Unknown,
    error: Schema.NullOr(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        liveSessionCount: Schema.optional(Schema.NonNegativeInt)
      })
    )
  }),
  Schema.Struct({
    type: Schema.Literal('event'),
    event: Schema.Literal('output'),
    data: Schema.Struct({
      terminalId: Schema.String,
      output: Schema.String,
      sequence: positiveInteger
    })
  }),
  Schema.Struct({
    type: Schema.Literal('event'),
    event: Schema.Literal('runtime'),
    data: Schema.Struct({
      terminalId: Schema.String,
      value: runtimeEventSchema
    })
  })
)

// Validate every known field while discarding additive unknown fields.
const decodeFrame = Schema.decodeUnknownSync(terminalHostFrameSchema)

export function decodeTerminalHostInput<
  Method extends TerminalHostRequestMethod
>(
  method: Method,
  // eslint-disable-next-line anti-slop/no-unknown-parameters -- Request payloads are decoded by the selected Effect Schema at this IPC boundary.
  input: unknown
): Effect.Effect<
  TerminalHostRequestInput<Method>,
  TerminalHostFrameDecodeError
> {
  // SAFETY: Every request method maps to the schema for its declared input type.
  const schema = terminalHostInputSchemas[method] as Schema.Schema<unknown>
  // SAFETY: Decoding with the method-indexed schema establishes the generic method input type.
  return Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError((cause) => new TerminalHostFrameDecodeError({ cause }))
  ) as Effect.Effect<
    TerminalHostRequestInput<Method>,
    TerminalHostFrameDecodeError
  >
}

export function decodeTerminalHostResult<
  Method extends TerminalHostRequestMethod
>(
  method: Method,
  // eslint-disable-next-line anti-slop/no-unknown-parameters -- Response payloads are decoded by the selected Effect Schema at this IPC boundary.
  input: unknown
): Effect.Effect<TerminalHostResults[Method], TerminalHostFrameDecodeError> {
  // SAFETY: Every request method maps to the schema for its declared result type.
  const schema = terminalHostResultSchemas[method] as Schema.Schema<unknown>
  // SAFETY: Decoding with the method-indexed schema establishes the generic method result type.
  return Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError((cause) => new TerminalHostFrameDecodeError({ cause }))
  ) as Effect.Effect<TerminalHostResults[Method], TerminalHostFrameDecodeError>
}

export function decodeTerminalHostRecord(
  // eslint-disable-next-line anti-slop/no-unknown-parameters -- Discovery file contents are decoded by Effect Schema at this boundary.
  input: unknown
): Effect.Effect<TerminalHostRecord, TerminalHostFrameDecodeError> {
  return Schema.decodeUnknown(terminalHostRecordSchema)(input).pipe(
    Effect.mapError((cause) => new TerminalHostFrameDecodeError({ cause }))
  )
}

export function encodeTerminalHostFrame(
  frame: TerminalHostFrame
): Effect.Effect<Buffer, TerminalHostFrameEncodeError> {
  return Effect.try({
    try: () => {
      const payload = Buffer.from(JSON.stringify(decodeFrame(frame)), 'utf8')
      if (
        payload.byteLength <= 0 ||
        payload.byteLength > TERMINAL_HOST_MAX_FRAME_BYTES
      ) {
        throw new Error('Terminal host frame exceeds the byte limit')
      }

      const header = Buffer.allocUnsafe(4)
      header.writeUInt32BE(payload.byteLength)
      return Buffer.concat([header, payload])
    },
    catch: (cause) => new TerminalHostFrameEncodeError({ cause })
  })
}

/** A transport-owned incremental decoder. Do not share it across sockets. */
export function makeTerminalHostFrameDecoder(): (
  chunk: Uint8Array
) => Effect.Effect<readonly TerminalHostFrame[], TerminalHostFrameDecodeError> {
  let buffered = Buffer.alloc(0)
  return (chunk) =>
    Effect.try({
      try: () => {
        const next = Buffer.from(chunk)
        buffered = buffered.byteLength ? Buffer.concat([buffered, next]) : next
        const frames: TerminalHostFrame[] = []
        while (buffered.byteLength >= 4) {
          const length = buffered.readUInt32BE(0)
          if (length <= 0 || length > TERMINAL_HOST_MAX_FRAME_BYTES) {
            throw new Error('Invalid terminal host frame length')
          }

          if (buffered.byteLength < length + 4) {
            break
          }

          const payload = buffered.subarray(4, length + 4)
          buffered = buffered.subarray(length + 4)
          // SAFETY: decodeFrame synchronously validates the parsed value against terminalHostFrameSchema.
          frames.push(
            decodeFrame(
              JSON.parse(payload.toString('utf8'))
            ) as TerminalHostFrame
          )
        }
        return frames
      },
      catch: (cause) => new TerminalHostFrameDecodeError({ cause })
    })
}
