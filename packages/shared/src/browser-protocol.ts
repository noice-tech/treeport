/* eslint-disable anti-slop/no-unknown-parameters -- Effect Schema decoders validate untrusted protocol input at this boundary. */
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'

export const BROWSER_PROTOCOL_VERSION = 5
export const BROWSER_MAX_FRAME_BYTES = 8 * 1024 * 1024
export const BROWSER_MAX_MESSAGE_BYTES = 128 * 1024

export type BrowserMouseButton = 'left' | 'right' | 'middle'

const opaqueTokenSchema = Schema.String.pipe(
  Schema.minLength(32),
  Schema.maxLength(256)
)
export const browserPanelIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)
const browserRequestIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)
const browserGenerationSchema = Schema.Int.pipe(Schema.positive())
const browserRevisionSchema = Schema.NonNegativeInt

export const browserUrlSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.filter(
    (value) => {
      if (!URL.canParse(value)) {
        return false
      }

      const url = new URL(value)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' &&
        url.password === ''
      )
    },
    {
      message: () =>
        'Expected an absolute HTTP or HTTPS URL without credentials'
    }
  )
)

export const browserClientMessageSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal('navigate'), url: browserUrlSchema }),
  Schema.Struct({ type: Schema.Literal('back') }),
  Schema.Struct({ type: Schema.Literal('forward') }),
  Schema.Struct({ type: Schema.Literal('reload') }),
  Schema.Struct({ type: Schema.Literal('stop') }),
  Schema.Struct({
    type: Schema.Literal('resize'),
    width: Schema.Int.pipe(Schema.between(320, 3_840)),
    height: Schema.Int.pipe(Schema.between(200, 2_160))
  }),
  Schema.Struct({
    type: Schema.Literal('pointer'),
    phase: Schema.Literal('move', 'down', 'up'),
    x: Schema.Finite.pipe(Schema.between(0, 3_840)),
    y: Schema.Finite.pipe(Schema.between(0, 2_160)),
    button: Schema.optional(Schema.Literal('left', 'right', 'middle'))
  }),
  Schema.Struct({
    type: Schema.Literal('wheel'),
    deltaX: Schema.Finite.pipe(Schema.between(-10_000, 10_000)),
    deltaY: Schema.Finite.pipe(Schema.between(-10_000, 10_000))
  }),
  Schema.Struct({
    type: Schema.Literal('key'),
    phase: Schema.Literal('down', 'up'),
    key: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
  }),
  Schema.Struct({
    type: Schema.Literal('insertText'),
    text: Schema.String.pipe(Schema.maxLength(64 * 1024))
  }),
  Schema.Struct({
    type: Schema.Literal('find'),
    text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
    forward: Schema.Boolean,
    findNext: Schema.Boolean
  }),
  Schema.Struct({ type: Schema.Literal('stopFind') }),
  Schema.Struct({ type: Schema.Literal('takeControl') }),
  Schema.Struct({
    type: Schema.Literal('setVisible'),
    visible: Schema.Boolean
  }),
  Schema.Struct({
    type: Schema.Literal('frameAck'),
    sequence: Schema.Int.pipe(Schema.positive())
  })
)
export type BrowserClientMessage = Schema.Schema.Type<
  typeof browserClientMessageSchema
>

export const browserRuntimeStateSchema = Schema.Struct({
  url: Schema.Union(Schema.Literal('about:blank'), browserUrlSchema),
  title: Schema.String.pipe(Schema.maxLength(256)),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  viewport: Schema.Struct({
    width: Schema.Finite.pipe(Schema.between(0, 3_840)),
    height: Schema.Finite.pipe(Schema.between(0, 2_160))
  })
})
export type BrowserRuntimeState = Schema.Schema.Type<
  typeof browserRuntimeStateSchema
>

export const browserSessionStateSchema = Schema.Struct({
  ...browserRuntimeStateSchema.fields,
  controlled: Schema.Boolean,
  hasController: Schema.Boolean,
  controller: Schema.Literal('you', 'agent', 'other', 'none')
})
export type BrowserSessionState = Schema.Schema.Type<
  typeof browserSessionStateSchema
>

export const browserServerMessageSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('ready'),
    state: browserSessionStateSchema
  }),
  Schema.Struct({
    type: Schema.Literal('state'),
    state: browserSessionStateSchema
  }),
  Schema.Struct({
    type: Schema.Literal('controlChanged'),
    state: browserSessionStateSchema
  }),
  Schema.Struct({
    type: Schema.Literal('navigationError'),
    message: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal('browserUnavailable'),
    message: Schema.String,
    installCommand: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal('browserCrashed'),
    message: Schema.String
  }),
  Schema.Struct({ type: Schema.Literal('closed'), reason: Schema.String })
)
export type BrowserServerMessage = Schema.Schema.Type<
  typeof browserServerMessageSchema
>

export const browserFrameMetadataSchema = Schema.Struct({
  sequence: Schema.Int.pipe(Schema.positive()),
  mimeType: Schema.Literal('image/jpeg'),
  timestamp: Schema.Number,
  width: Schema.Int.pipe(Schema.positive()),
  height: Schema.Int.pipe(Schema.positive()),
  byteLength: Schema.Int.pipe(Schema.between(0, BROWSER_MAX_FRAME_BYTES))
})
export type BrowserFrameMetadata = Schema.Schema.Type<
  typeof browserFrameMetadataSchema
>

const browserFrameDataSchema = Schema.Union(
  Schema.Uint8ArrayFromSelf,
  Schema.declare(
    (value): value is ArrayBuffer => value instanceof ArrayBuffer,
    { identifier: 'ArrayBufferFromSelf' }
  )
).pipe(
  Schema.transform(Schema.Uint8ArrayFromSelf, {
    strict: true,
    decode: (value) =>
      value instanceof Uint8Array ? value : new Uint8Array(value),
    encode: (value) => value
  }),
  Schema.filter((value) => value.byteLength <= BROWSER_MAX_FRAME_BYTES, {
    message: () =>
      `Browser frames cannot exceed ${BROWSER_MAX_FRAME_BYTES} bytes`
  })
)

export const browserFrameSchema = Schema.Struct({
  sequence: Schema.Int.pipe(Schema.positive()),
  mimeType: Schema.Literal('image/jpeg'),
  timestamp: Schema.Number,
  width: Schema.Int.pipe(Schema.positive()),
  height: Schema.Int.pipe(Schema.positive()),
  data: browserFrameDataSchema
})
export type BrowserFrame = Schema.Schema.Type<typeof browserFrameSchema>

export const browserTicketRequestSchema = Schema.Struct({
  clientId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  visible: Schema.Boolean
})
export const browserOwnerTicketRequestSchema = Schema.Struct({
  clientId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
})
export const browserTicketResponseSchema = Schema.Struct({
  ticket: opaqueTokenSchema
})
export const browserOwnerTicketResponseSchema = Schema.Struct({
  ticket: opaqueTokenSchema,
  challenge: opaqueTokenSchema
})
export const browserOwnerIdentitySchema = Schema.Struct({
  panelId: browserPanelIdSchema,
  challenge: opaqueTokenSchema
})

export const browserOwnerEndpointSchema = Schema.String.pipe(
  Schema.maxLength(1_024),
  Schema.filter(
    (value) => {
      if (!URL.canParse(value)) {
        return false
      }

      const url = new URL(value)
      return (
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === '' &&
        url.pathname !== '/'
      )
    },
    { message: () => 'Expected a private loopback Browser endpoint' }
  )
)

const browserAgentArgumentSchema = Schema.String.pipe(Schema.maxLength(4_096))
export const browserAgentCommandSchema = Schema.Union(
  Schema.Struct({ command: Schema.Literal('snapshot'), args: Schema.Tuple() }),
  Schema.Struct({
    command: Schema.Literal('click'),
    args: Schema.Tuple(browserAgentArgumentSchema)
  }),
  Schema.Struct({
    command: Schema.Literal('fill'),
    args: Schema.Tuple(browserAgentArgumentSchema, browserAgentArgumentSchema)
  }),
  Schema.Struct({
    command: Schema.Literal('press'),
    args: Schema.Tuple(browserAgentArgumentSchema)
  }),
  Schema.Struct({
    command: Schema.Literal('console'),
    args: Schema.Union(
      Schema.Tuple(),
      Schema.Tuple(browserAgentArgumentSchema.pipe(Schema.maxLength(32)))
    )
  }),
  Schema.Struct({ command: Schema.Literal('requests'), args: Schema.Tuple() }),
  Schema.Struct({
    command: Schema.Literal('screenshot'),
    args: Schema.Tuple()
  }),
  Schema.Struct({
    command: Schema.Literal('goto'),
    args: Schema.Tuple(browserUrlSchema)
  }),
  Schema.Struct({ command: Schema.Literal('go-back'), args: Schema.Tuple() }),
  Schema.Struct({
    command: Schema.Literal('go-forward'),
    args: Schema.Tuple()
  }),
  Schema.Struct({ command: Schema.Literal('reload'), args: Schema.Tuple() })
)
export type BrowserAgentCommand = Schema.Schema.Type<
  typeof browserAgentCommandSchema
>

export const browserAuthSchema = Schema.Struct({
  ticket: opaqueTokenSchema,
  protocolVersion: Schema.Literal(BROWSER_PROTOCOL_VERSION)
})
export type BrowserAuth = Schema.Schema.Type<typeof browserAuthSchema>

export const browserOwnerAuthSchema = Schema.Struct({
  ticket: opaqueTokenSchema,
  protocolVersion: Schema.Literal(BROWSER_PROTOCOL_VERSION),
  endpoint: browserOwnerEndpointSchema,
  challenge: opaqueTokenSchema
})
export type BrowserOwnerAuth = Schema.Schema.Type<typeof browserOwnerAuthSchema>

export const browserOwnerClientMessageSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('ready'),
    generation: browserGenerationSchema,
    revision: browserRevisionSchema,
    state: browserRuntimeStateSchema
  }),
  Schema.Struct({
    type: Schema.Literal('state'),
    generation: browserGenerationSchema,
    revision: browserRevisionSchema,
    state: browserRuntimeStateSchema
  }),
  Schema.Struct({
    type: Schema.Literal('popup'),
    generation: browserGenerationSchema,
    url: browserUrlSchema
  }),
  Schema.Struct({
    type: Schema.Literal('crashed'),
    generation: browserGenerationSchema,
    message: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_024))
  }),
  Schema.Struct({
    type: Schema.Literal('runtimeControlResult'),
    generation: browserGenerationSchema,
    requestId: browserRequestIdSchema,
    accepted: Schema.Boolean
  }),
  Schema.Struct({
    type: Schema.Literal('takeControl'),
    generation: browserGenerationSchema
  }),
  Schema.Struct({
    type: Schema.Literal('released'),
    generation: browserGenerationSchema
  }),
  Schema.Struct({
    type: Schema.Literal('closeResult'),
    generation: browserGenerationSchema,
    requestId: browserRequestIdSchema,
    canClose: Schema.Boolean
  })
)
export type BrowserOwnerClientMessage = Schema.Schema.Type<
  typeof browserOwnerClientMessageSchema
>

export const browserOwnerServerMessageSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('claimGranted'),
    panelId: browserPanelIdSchema,
    generation: browserGenerationSchema,
    resumed: Schema.Boolean,
    state: browserRuntimeStateSchema
  }),
  Schema.Struct({
    type: Schema.Literal('claimRejected'),
    message: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_024))
  }),
  Schema.Struct({
    type: Schema.Literal('runtimeControl'),
    generation: browserGenerationSchema,
    requestId: browserRequestIdSchema,
    controller: Schema.Literal('agent', 'other', 'none'),
    retainPaint: Schema.Boolean
  }),
  Schema.Struct({
    type: Schema.Literal('closeRequest'),
    generation: browserGenerationSchema,
    requestId: browserRequestIdSchema,
    force: Schema.Boolean
  }),
  Schema.Struct({
    type: Schema.Literal('closed'),
    reason: Schema.String.pipe(Schema.maxLength(1_024))
  })
)
export type BrowserOwnerServerMessage = Schema.Schema.Type<
  typeof browserOwnerServerMessageSchema
>

export interface BrowserClientToServerEvents {
  command: (message: BrowserClientMessage) => void
}
export interface BrowserServerToClientEvents {
  message: (message: BrowserServerMessage) => void
  frame: (frame: BrowserFrame) => void
}
export interface BrowserOwnerClientToServerEvents {
  ownerMessage: (message: BrowserOwnerClientMessage) => void
}
export interface BrowserOwnerServerToClientEvents {
  ownerMessage: (message: BrowserOwnerServerMessage) => void
}

function decodeOrNull<S extends Schema.Schema<any, any, never>>(
  schema: S,
  value: unknown
): Schema.Schema.Type<S> | null {
  const result = Schema.decodeUnknownEither(schema, {
    onExcessProperty: 'error'
  })(value)
  return Either.isRight(result) ? result.right : null
}

export function parseBrowserAuth(value: unknown): BrowserAuth | null {
  return decodeOrNull(browserAuthSchema, value)
}
export function parseBrowserOwnerAuth(value: unknown): BrowserOwnerAuth | null {
  return decodeOrNull(browserOwnerAuthSchema, value)
}
export function parseBrowserClientMessage(
  value: unknown
): BrowserClientMessage | null {
  return decodeOrNull(browserClientMessageSchema, value)
}
export function parseBrowserOwnerClientMessage(
  value: unknown
): BrowserOwnerClientMessage | null {
  return decodeOrNull(browserOwnerClientMessageSchema, value)
}
export function parseBrowserServerMessage(
  value: unknown
): BrowserServerMessage | null {
  return decodeOrNull(browserServerMessageSchema, value)
}
export function parseBrowserOwnerServerMessage(
  value: unknown
): BrowserOwnerServerMessage | null {
  return decodeOrNull(browserOwnerServerMessageSchema, value)
}
export function parseBrowserFrameMetadata(
  value: unknown
): BrowserFrameMetadata | null {
  return decodeOrNull(browserFrameMetadataSchema, value)
}

export function encodeBrowserFrame(frame: BrowserFrame): Uint8Array {
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      sequence: frame.sequence,
      mimeType: frame.mimeType,
      timestamp: frame.timestamp,
      width: frame.width,
      height: frame.height,
      byteLength: frame.data.byteLength
    })
  )
  const encoded = new Uint8Array(
    4 + metadata.byteLength + frame.data.byteLength
  )
  new DataView(encoded.buffer).setUint32(0, metadata.byteLength)
  encoded.set(metadata, 4)
  encoded.set(frame.data, 4 + metadata.byteLength)
  return encoded
}

export function decodeBrowserFrame(value: Uint8Array): BrowserFrame | null {
  if (value.byteLength < 4) {
    return null
  }

  const metadataLength = new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength
  ).getUint32(0)
  if (
    metadataLength > value.byteLength - 4 ||
    value.byteLength - 4 - metadataLength > BROWSER_MAX_FRAME_BYTES
  ) {
    return null
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(
      new TextDecoder().decode(value.subarray(4, 4 + metadataLength))
    )
  } catch {
    return null
  }
  const metadata = parseBrowserFrameMetadata(decoded)
  const data = value.subarray(4 + metadataLength)
  if (!metadata || metadata.byteLength !== data.byteLength) {
    return null
  }

  return { ...metadata, data }
}
