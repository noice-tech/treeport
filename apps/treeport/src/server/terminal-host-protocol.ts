import {
  terminalImageSnapshotSchema,
  terminalProgressSchema,
  terminalSnapshotLinkSchema,
  type TerminalImageSnapshot,
  type TerminalProgress,
  type TerminalSnapshotLink
} from '@treeport/shared'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type {
  HostedTerminal,
  TerminalLaunchSpec,
  TerminalSessionState,
  TerminalTitleState,
  TerminalTraceContext
} from './core/terminal'
import type { TerminalHostRuntimeEvent } from './core/terminal'

export const TERMINAL_HOST_PROTOCOL_VERSION = 4
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
  readonly hostProtocolVersion?: number | undefined
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
  protocolVersion: positiveInteger,
  hostId: nonEmptyString,
  hostKey: nonEmptyString,
  pid: positiveInteger,
  socketPath: nonEmptyString,
  startedAt: nonEmptyString
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
    protocolVersion: Schema.Int
  }),
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
    cellSize: Schema.NullOr(
      Schema.Struct({
        width: Schema.Number.pipe(Schema.between(1, 100)),
        height: Schema.Number.pipe(Schema.between(1, 200))
      })
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
export type TerminalHostRequestInput<
  Method extends TerminalHostRequestMethod = TerminalHostRequestMethod
> = (typeof terminalHostInputSchemas)[Method]['Type']

export interface TerminalHostRequestFrame {
  protocolVersion: number
  type: 'request'
  id: string
  method: TerminalHostRequestMethod
  input: object
  trace?: TerminalTraceContext | undefined
}

export interface TerminalHostResponseFrame {
  protocolVersion: number
  type: 'response'
  id: string
  /** Older hosts may omit result on a structured protocol failure. */
  result?: TerminalHostResult
  error: {
    code: string
    message: string
    hostProtocolVersion?: number | undefined
    liveSessionCount?: number | undefined
  } | null
}

export type TerminalHostEventFrame =
  | {
      protocolVersion: number
      type: 'event'
      event: 'output'
      data: { terminalId: string; output: string; sequence: number }
    }
  | {
      protocolVersion: number
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
    traceContext?: boolean
  }
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
    liveSessionCount: Schema.NonNegativeInt,
    traceContext: Schema.optional(Schema.Boolean)
  }),
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
    protocolVersion: Schema.Int,
    type: Schema.Literal('request'),
    id: Schema.String,
    method: Schema.Literal(...TERMINAL_HOST_REQUEST_METHODS),
    input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    trace: Schema.optional(traceSchema)
  }),
  Schema.Struct({
    protocolVersion: Schema.Int,
    type: Schema.Literal('response'),
    id: Schema.String,
    result: Schema.optional(Schema.Unknown),
    error: Schema.NullOr(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        hostProtocolVersion: Schema.optional(Schema.Int),
        liveSessionCount: Schema.optional(Schema.NonNegativeInt)
      })
    )
  }),
  Schema.Struct({
    protocolVersion: Schema.Int,
    type: Schema.Literal('event'),
    event: Schema.Literal('output'),
    data: Schema.Struct({
      terminalId: Schema.String,
      output: Schema.String,
      sequence: positiveInteger
    })
  }),
  Schema.Struct({
    protocolVersion: Schema.Int,
    type: Schema.Literal('event'),
    event: Schema.Literal('runtime'),
    data: Schema.Struct({
      terminalId: Schema.String,
      value: runtimeEventSchema
    })
  })
)

const decodeFrame = Schema.decodeUnknownSync(terminalHostFrameSchema, {
  onExcessProperty: 'error'
})

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
  return Schema.decodeUnknown(schema, {
    onExcessProperty: 'error'
  })(input).pipe(
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
  return Schema.decodeUnknown(schema, {
    onExcessProperty: 'error'
  })(input).pipe(
    Effect.mapError((cause) => new TerminalHostFrameDecodeError({ cause }))
  ) as Effect.Effect<TerminalHostResults[Method], TerminalHostFrameDecodeError>
}

export function decodeTerminalHostRecord(
  // eslint-disable-next-line anti-slop/no-unknown-parameters -- Discovery file contents are decoded by Effect Schema at this boundary.
  input: unknown
): Effect.Effect<TerminalHostRecord, TerminalHostFrameDecodeError> {
  return Schema.decodeUnknown(terminalHostRecordSchema, {
    onExcessProperty: 'error'
  })(input).pipe(
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
