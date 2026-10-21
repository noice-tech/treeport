/* eslint-disable anti-slop/no-unknown-parameters -- Effect Schema decoders validate untrusted protocol input at this boundary. */
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { browserVideoSettingsSchema } from './browser-video.js'
import { browserClipboardSchema } from './browser-clipboard.js'
import { viewerIdentitySchema } from './presence-protocol.js'
import {
  BROWSER_MAX_UPLOAD_BYTES,
  browserAppIdSchema,
  browserObservedUrlSchema,
  browserUrlSchema
} from './browser-host.js'
export {
  BROWSER_MAX_UPLOAD_BYTES,
  browserAppIdSchema,
  browserObservedUrlSchema,
  browserUrlSchema
} from './browser-host.js'

export const BROWSER_MAX_UPLOAD_FILES = 100
export const BROWSER_MAX_INSERT_TEXT_LENGTH = 1024 * 1024
// Observed Chromium addresses can be megabytes long (including JSON escaping).
export const BROWSER_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export type BrowserMouseButton = 'left' | 'right' | 'middle'

const opaqueTokenSchema = Schema.String.pipe(
  Schema.minLength(32),
  Schema.maxLength(256)
)
const browserRequestIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)
const browserGenerationSchema = Schema.Int.pipe(Schema.positive())
const browserRevisionSchema = Schema.NonNegativeInt

export function normalizeBrowserTitle(title: string): string {
  const end = title.charCodeAt(255)
  return title.slice(0, end >= 0xd800 && end <= 0xdbff ? 255 : 256)
}

export function normalizeBrowserFaviconUrl(
  value: string | null
): string | null {
  if (!value || value.length > 512 * 1024 || !URL.canParse(value)) {
    return null
  }

  const url = new URL(value)
  if (url.protocol === 'data:') {
    return /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,/i.test(
      value
    )
      ? value
      : null
  }

  return (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username &&
    !url.password
    ? value
    : null
}

export const browserContextActionSchema = Schema.Literal(
  'openLink',
  'copyLink',
  'back',
  'forward',
  'reload',
  'inspect'
)
export type BrowserContextAction = Schema.Schema.Type<
  typeof browserContextActionSchema
>

export const browserContextResultSchema = Schema.Struct({
  type: Schema.Literal('contextResult'),
  requestId: browserRequestIdSchema,
  contextId: Schema.NullOr(browserRequestIdSchema),
  linkUrl: Schema.NullOr(Schema.String.pipe(Schema.maxLength(16_384))),
  canOpenLink: Schema.Boolean,
  canInspect: Schema.Boolean
})
export type BrowserContextResult = Schema.Schema.Type<
  typeof browserContextResultSchema
>

export const browserContextActionResultSchema = Schema.Struct({
  type: Schema.Literal('contextActionResult'),
  requestId: browserRequestIdSchema,
  action: browserContextActionSchema,
  linkUrl: Schema.NullOr(Schema.String.pipe(Schema.maxLength(16_384))),
  backendNodeId: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  targetId: Schema.NullOr(
    Schema.String.pipe(Schema.pattern(/^[a-fA-F0-9]{32}$/))
  )
})
export type BrowserContextActionResult = Schema.Schema.Type<
  typeof browserContextActionResultSchema
>

export const browserClientMessageSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('setVideoSettings'),
    requestId: browserRequestIdSchema,
    settings: browserVideoSettingsSchema
  }),
  Schema.Struct({
    type: Schema.Literal('fileChooserResponse'),
    requestId: browserRequestIdSchema,
    // Null cancels without clearing the input's previous selection.
    files: Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.String.pipe(
            Schema.minLength(1),
            Schema.maxLength(255),
            // eslint-disable-next-line no-control-regex -- File names must not contain path separators or control characters.
            Schema.pattern(/^[^/\\\x00-\x1f]+$/),
            Schema.filter((name) => name !== '.' && name !== '..')
          ),
          mimeType: Schema.String.pipe(Schema.maxLength(255)),
          base64: Schema.String.pipe(
            Schema.maxLength(4 * Math.ceil(BROWSER_MAX_UPLOAD_BYTES / 3)),
            Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/),
            Schema.filter((value) => value.length % 4 === 0)
          )
        })
      ).pipe(
        Schema.minItems(1),
        Schema.maxItems(BROWSER_MAX_UPLOAD_FILES),
        Schema.filter(
          (files) =>
            files.reduce(
              (total, file) =>
                total +
                (file.base64.length / 4) * 3 -
                (file.base64.endsWith('==')
                  ? 2
                  : file.base64.endsWith('=')
                    ? 1
                    : 0),
              0
            ) <= BROWSER_MAX_UPLOAD_BYTES
        )
      )
    )
  }),
  Schema.Struct({
    type: Schema.Literal('contextMenu'),
    requestId: browserRequestIdSchema,
    x: Schema.Finite.pipe(Schema.between(0, 3_840)),
    y: Schema.Finite.pipe(Schema.between(0, 2_160))
  }),
  Schema.Struct({
    type: Schema.Literal('contextAction'),
    requestId: browserRequestIdSchema,
    contextId: browserRequestIdSchema,
    action: browserContextActionSchema
  }),
  Schema.Struct({
    type: Schema.Literal('dismissContext'),
    contextId: browserRequestIdSchema
  }),
  Schema.Struct({ type: Schema.Literal('navigate'), url: browserUrlSchema }),
  Schema.Struct({ type: Schema.Literal('back') }),
  Schema.Struct({ type: Schema.Literal('forward') }),
  Schema.Struct({ type: Schema.Literal('reload') }),
  Schema.Struct({ type: Schema.Literal('stop') }),
  Schema.Struct({
    type: Schema.Literal('resize'),
    width: Schema.Int.pipe(Schema.between(1, 3_840)),
    height: Schema.Int.pipe(Schema.between(1, 2_160))
  }),
  Schema.Struct({
    type: Schema.Literal('pointer'),
    phase: Schema.Literal('move', 'down', 'up'),
    x: Schema.Finite.pipe(Schema.between(0, 3_840)),
    y: Schema.Finite.pipe(Schema.between(0, 2_160)),
    button: Schema.optional(Schema.Literal('left', 'right', 'middle')),
    clickCount: Schema.optional(Schema.Int.pipe(Schema.positive()))
  }),
  Schema.Struct({
    type: Schema.Literal('touch'),
    phase: Schema.Literal('start', 'move', 'end', 'cancel'),
    // Start/move carry active contacts; end carries only released contacts.
    // An empty end or cancel releases the entire gesture.
    points: Schema.Array(
      Schema.Struct({
        id: Schema.Int.pipe(Schema.between(0, 2_147_483_647)),
        x: Schema.Finite.pipe(Schema.between(0, 3_840)),
        y: Schema.Finite.pipe(Schema.between(0, 2_160))
      })
    ).pipe(Schema.maxItems(10))
  }).pipe(
    Schema.filter(
      ({ phase, points }) =>
        new Set(points.map((point) => point.id)).size === points.length &&
        (phase === 'cancel'
          ? points.length === 0
          : phase === 'end' || points.length > 0)
    )
  ),
  Schema.Struct({
    type: Schema.Literal('wheel'),
    x: Schema.Finite.pipe(Schema.between(0, 3_840)),
    y: Schema.Finite.pipe(Schema.between(0, 2_160)),
    // CDP modifier bits: Alt=1, Control=2, Meta=4, Shift=8.
    modifiers: Schema.Int.pipe(Schema.between(0, 15)),
    deltaX: Schema.Finite.pipe(Schema.between(-10_000, 10_000)),
    deltaY: Schema.Finite.pipe(Schema.between(-10_000, 10_000))
  }),
  Schema.Struct({
    type: Schema.Literal('key'),
    phase: Schema.Literal('down', 'up'),
    key: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
    modifiers: Schema.Int.pipe(Schema.between(0, 15))
  }),
  Schema.Struct({
    type: Schema.Literal('copy'),
    requestId: browserRequestIdSchema
  }),
  Schema.Struct({
    type: Schema.Literal('insertText'),
    text: Schema.String.pipe(Schema.maxLength(BROWSER_MAX_INSERT_TEXT_LENGTH))
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
    type: Schema.Literal('webcodecsAck'),
    epoch: Schema.Int.pipe(Schema.between(1, 0xffffffff)),
    sequence: Schema.Int.pipe(Schema.between(0, 0xffffffff))
  }),
  Schema.Struct({
    type: Schema.Literal('webcodecsStop'),
    message: Schema.String.pipe(Schema.maxLength(512))
  }),
  Schema.Struct({
    type: Schema.Literal('videoOffer'),
    requestId: browserRequestIdSchema,
    sdp: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(65_536))
  })
)
export type BrowserClientMessage = Schema.Schema.Type<
  typeof browserClientMessageSchema
>

export const browserRuntimeStateSchema = Schema.Struct({
  url: Schema.Union(Schema.Literal('about:blank'), browserObservedUrlSchema),
  // Ordinary page metadata must not invalidate an otherwise healthy connection.
  title: Schema.transform(Schema.String, Schema.String, {
    decode: normalizeBrowserTitle,
    encode: normalizeBrowserTitle
  }),
  faviconUrl: Schema.transform(
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    {
      decode: normalizeBrowserFaviconUrl,
      encode: normalizeBrowserFaviconUrl
    }
  ),
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

export const browserControllerDetailsSchema = Schema.Struct({
  kind: Schema.Literal('viewer', 'local'),
  account: Schema.NullOr(viewerIdentitySchema),
  sameAccount: Schema.Boolean,
  sameDevice: Schema.Boolean
})
export type BrowserControllerDetails = Schema.Schema.Type<
  typeof browserControllerDetailsSchema
>

export function browserControllerDescription(
  details: BrowserControllerDetails | null
): string {
  if (details?.sameAccount) {
    return details.sameDevice
      ? 'Another window on this device controls this browser.'
      : 'Another window or device on your account controls this browser.'
  }

  if (details?.sameDevice) {
    return 'Another window on this device controls this browser.'
  }

  if (details?.kind === 'local') {
    return 'A desktop window on the server controls this browser.'
  }

  const name = details?.account?.name ?? details?.account?.login
  return name
    ? `${name} controls this browser.`
    : 'Another window or device controls this browser.'
}

export const browserSessionStateSchema = Schema.Struct({
  videoSettings: Schema.NullOr(browserVideoSettingsSchema),
  ...browserRuntimeStateSchema.fields,
  controlled: Schema.Boolean,
  hasController: Schema.Boolean,
  controller: Schema.Literal('you', 'other', 'none'),
  controllerDetails: Schema.NullOr(browserControllerDetailsSchema),
  agentActive: Schema.Boolean
})
export type BrowserSessionState = Schema.Schema.Type<
  typeof browserSessionStateSchema
>

// Only native keywords cross the boundary: remote cursor URLs must never load
// resources from the viewer's network or carry credentials into the client.
export const browserCursorSchema = Schema.Literal(
  'auto',
  'default',
  'none',
  'context-menu',
  'help',
  'pointer',
  'progress',
  'wait',
  'cell',
  'crosshair',
  'text',
  'vertical-text',
  'alias',
  'copy',
  'move',
  'no-drop',
  'not-allowed',
  'grab',
  'grabbing',
  'e-resize',
  'n-resize',
  'ne-resize',
  'nw-resize',
  's-resize',
  'se-resize',
  'sw-resize',
  'w-resize',
  'ew-resize',
  'ns-resize',
  'nesw-resize',
  'nwse-resize',
  'col-resize',
  'row-resize',
  'all-scroll',
  'zoom-in',
  'zoom-out'
)

export const browserServerMessageSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('videoSettingsResult'),
    requestId: browserRequestIdSchema,
    error: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal('fileChooser'),
    requestId: browserRequestIdSchema,
    multiple: Schema.Boolean,
    accept: Schema.String.pipe(Schema.maxLength(4_096))
  }),
  Schema.Struct({
    type: Schema.Literal('fileChooserClosed'),
    requestId: browserRequestIdSchema,
    error: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal('webcodecsReady'),
    epoch: Schema.Int.pipe(Schema.between(1, 0xffffffff)),
    codec: Schema.String.pipe(Schema.maxLength(64)),
    width: Schema.Int.pipe(Schema.between(2, 3_840)),
    height: Schema.Int.pipe(Schema.between(2, 2_160)),
    hardwareSupported: Schema.Boolean,
    encoderPreference: Schema.Literal('prefer-hardware', 'no-preference'),
    processor: Schema.Literal('window'),
    encoderBackend: Schema.Literal('unknown')
  }),
  Schema.Struct({ type: Schema.Literal('videoReady') }),
  Schema.Struct({
    type: Schema.Literal('videoAnswer'),
    requestId: browserRequestIdSchema,
    sdp: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(65_536))
  }),
  browserContextResultSchema,
  browserContextActionResultSchema,
  Schema.Struct({
    type: Schema.Literal('clipboardWrite'),
    clipboard: browserClipboardSchema
  }),
  Schema.Struct({
    type: Schema.Literal('copyResult'),
    requestId: browserRequestIdSchema,
    clipboard: Schema.NullOr(browserClipboardSchema),
    error: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal('cursor'),
    cursor: browserCursorSchema
  }),
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
    type: Schema.Literal('videoUnavailable'),
    message: Schema.String
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

export const browserTicketRequestSchema = Schema.Struct({
  // Persistent viewer/window ID. Account and device identity come from ingress,
  // never from this request body; the socket gets its own ephemeral ID.
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
  appId: browserAppIdSchema,
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
  ticket: opaqueTokenSchema
})
export type BrowserAuth = Schema.Schema.Type<typeof browserAuthSchema>

export const browserOwnerAuthSchema = Schema.Struct({
  ticket: opaqueTokenSchema,
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
    url: browserObservedUrlSchema
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
    appId: browserAppIdSchema,
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
    controller: Schema.Literal('other', 'none'),
    viewport: Schema.NullOr(
      Schema.Struct({
        width: Schema.Int.pipe(Schema.between(1, 3_840)),
        height: Schema.Int.pipe(Schema.between(1, 2_160))
      })
    ),
    retainPaint: Schema.Boolean,
    agentActive: Schema.Boolean
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
