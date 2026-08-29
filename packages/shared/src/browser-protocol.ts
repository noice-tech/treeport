import { z } from 'zod'

export const BROWSER_PROTOCOL_VERSION = 3
export const BROWSER_MAX_FRAME_BYTES = 8 * 1024 * 1024
export const BROWSER_MAX_MESSAGE_BYTES = 128 * 1024

export type BrowserMouseButton = 'left' | 'right' | 'middle'

export const browserUrlSchema: z.ZodType<string> = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => {
    if (!URL.canParse(value)) {
      return false
    }

    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === ''
    )
  }, 'Expected an absolute HTTP or HTTPS URL without credentials')

export const browserClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('navigate'), url: browserUrlSchema }),
  z.strictObject({ type: z.literal('back') }),
  z.strictObject({ type: z.literal('forward') }),
  z.strictObject({ type: z.literal('reload') }),
  z.strictObject({ type: z.literal('stop') }),
  z.strictObject({
    type: z.literal('resize'),
    width: z.number().int().min(320).max(3_840),
    height: z.number().int().min(200).max(2_160)
  }),
  z.strictObject({
    type: z.literal('pointer'),
    phase: z.enum(['move', 'down', 'up']),
    x: z.number().finite().min(0).max(3_840),
    y: z.number().finite().min(0).max(2_160),
    button: z.enum(['left', 'right', 'middle']).optional()
  }),
  z.strictObject({
    type: z.literal('wheel'),
    deltaX: z.number().finite().min(-10_000).max(10_000),
    deltaY: z.number().finite().min(-10_000).max(10_000)
  }),
  z.strictObject({
    type: z.literal('key'),
    phase: z.enum(['down', 'up']),
    key: z.string().min(1).max(128)
  }),
  z.strictObject({
    type: z.literal('insertText'),
    text: z.string().max(64 * 1024)
  }),
  z.strictObject({ type: z.literal('takeControl') }),
  z.strictObject({ type: z.literal('setVisible'), visible: z.boolean() }),
  z.strictObject({
    type: z.literal('frameAck'),
    sequence: z.number().int().positive()
  })
])

export type BrowserClientMessage = z.infer<typeof browserClientMessageSchema>

export const browserRuntimeStateSchema = z.strictObject({
  url: z.union([z.literal('about:blank'), browserUrlSchema]),
  title: z.string().max(256),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  viewport: z.strictObject({
    width: z.number().finite().min(0).max(3_840),
    height: z.number().finite().min(0).max(2_160)
  })
})

export type BrowserRuntimeState = z.infer<typeof browserRuntimeStateSchema>

export const browserSessionStateSchema = browserRuntimeStateSchema.extend({
  controlled: z.boolean(),
  hasController: z.boolean(),
  controller: z.enum(['you', 'agent', 'other', 'none'])
})

export type BrowserSessionState = z.infer<typeof browserSessionStateSchema>

export const browserServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ready'),
    state: browserSessionStateSchema
  }),
  z.strictObject({
    type: z.literal('state'),
    state: browserSessionStateSchema
  }),
  z.strictObject({
    type: z.literal('controlChanged'),
    state: browserSessionStateSchema
  }),
  z.strictObject({ type: z.literal('navigationError'), message: z.string() }),
  z.strictObject({
    type: z.literal('browserUnavailable'),
    message: z.string(),
    installCommand: z.string().nullable()
  }),
  z.strictObject({ type: z.literal('browserCrashed'), message: z.string() }),
  z.strictObject({ type: z.literal('closed'), reason: z.string() })
])

export type BrowserServerMessage = z.infer<typeof browserServerMessageSchema>

export const browserFrameSchema = z.strictObject({
  sequence: z.number().int().positive(),
  mimeType: z.literal('image/jpeg'),
  timestamp: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data: z
    .union([z.instanceof(Uint8Array), z.instanceof(ArrayBuffer)])
    .transform((value) =>
      value instanceof Uint8Array ? value : new Uint8Array(value)
    )
    .refine((value) => value.byteLength <= BROWSER_MAX_FRAME_BYTES)
})

export type BrowserFrame = z.infer<typeof browserFrameSchema>

export const browserTicketRequestSchema = z.strictObject({
  clientId: z.string().min(1).max(128),
  visible: z.boolean()
})

export const browserOwnerTicketRequestSchema = z.strictObject({
  clientId: z.string().min(1).max(128)
})

const opaqueTokenSchema = z.string().min(32).max(256)
const browserPanelIdSchema = z.string().min(1).max(128)
const browserRequestIdSchema = z.string().min(1).max(128)
const browserGenerationSchema = z.number().int().positive()
const browserRevisionSchema = z.number().int().nonnegative()

export const browserOwnerEndpointSchema = z
  .string()
  .url()
  .max(1_024)
  .refine((value) => {
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
  }, 'Expected a private loopback Browser endpoint')

const browserAgentArgumentSchema = z.string().max(4_096)

export const browserAgentCommandSchema = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('snapshot'), args: z.tuple([]) }),
  z.strictObject({
    command: z.literal('click'),
    args: z.tuple([browserAgentArgumentSchema])
  }),
  z.strictObject({
    command: z.literal('fill'),
    args: z.tuple([browserAgentArgumentSchema, browserAgentArgumentSchema])
  }),
  z.strictObject({
    command: z.literal('press'),
    args: z.tuple([browserAgentArgumentSchema])
  }),
  z.strictObject({
    command: z.literal('console'),
    args: z.union([z.tuple([]), z.tuple([browserAgentArgumentSchema.max(32)])])
  }),
  z.strictObject({ command: z.literal('requests'), args: z.tuple([]) }),
  z.strictObject({ command: z.literal('screenshot'), args: z.tuple([]) }),
  z.strictObject({
    command: z.literal('goto'),
    args: z.tuple([browserUrlSchema])
  }),
  z.strictObject({ command: z.literal('go-back'), args: z.tuple([]) }),
  z.strictObject({ command: z.literal('go-forward'), args: z.tuple([]) }),
  z.strictObject({ command: z.literal('reload'), args: z.tuple([]) })
])

export type BrowserAgentCommand = z.infer<typeof browserAgentCommandSchema>

export const browserAuthSchema = z.strictObject({
  ticket: opaqueTokenSchema,
  protocolVersion: z.literal(BROWSER_PROTOCOL_VERSION)
})

export type BrowserAuth = z.infer<typeof browserAuthSchema>

export const browserOwnerAuthSchema = z.strictObject({
  ticket: opaqueTokenSchema,
  protocolVersion: z.literal(BROWSER_PROTOCOL_VERSION),
  endpoint: browserOwnerEndpointSchema,
  challenge: opaqueTokenSchema
})

export type BrowserOwnerAuth = z.infer<typeof browserOwnerAuthSchema>

export const browserOwnerClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ready'),
    generation: browserGenerationSchema,
    revision: browserRevisionSchema,
    state: browserRuntimeStateSchema
  }),
  z.strictObject({
    type: z.literal('state'),
    generation: browserGenerationSchema,
    revision: browserRevisionSchema,
    state: browserRuntimeStateSchema
  }),
  z.strictObject({
    type: z.literal('popup'),
    generation: browserGenerationSchema,
    url: browserUrlSchema
  }),
  z.strictObject({
    type: z.literal('crashed'),
    generation: browserGenerationSchema,
    message: z.string().min(1).max(1_024)
  }),
  z.strictObject({
    type: z.literal('runtimeControlResult'),
    generation: browserGenerationSchema,
    requestId: browserRequestIdSchema,
    accepted: z.boolean()
  }),
  z.strictObject({
    type: z.literal('takeControl'),
    generation: browserGenerationSchema
  }),
  z.strictObject({
    type: z.literal('released'),
    generation: browserGenerationSchema
  }),
  z.strictObject({
    type: z.literal('closeResult'),
    generation: browserGenerationSchema,
    requestId: browserRequestIdSchema,
    canClose: z.boolean()
  })
])

export type BrowserOwnerClientMessage = z.infer<
  typeof browserOwnerClientMessageSchema
>

export const browserOwnerServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('claimGranted'),
    panelId: browserPanelIdSchema,
    generation: browserGenerationSchema,
    resumed: z.boolean(),
    state: browserRuntimeStateSchema
  }),
  z.strictObject({
    type: z.literal('claimRejected'),
    message: z.string().min(1).max(1_024)
  }),
  z.strictObject({
    type: z.literal('runtimeControl'),
    generation: browserGenerationSchema,
    requestId: browserRequestIdSchema,
    controller: z.enum(['agent', 'other', 'none']),
    retainPaint: z.boolean()
  }),
  z.strictObject({
    type: z.literal('closeRequest'),
    generation: browserGenerationSchema,
    requestId: browserRequestIdSchema,
    force: z.boolean()
  }),
  z.strictObject({ type: z.literal('closed'), reason: z.string().max(1_024) })
])

export type BrowserOwnerServerMessage = z.infer<
  typeof browserOwnerServerMessageSchema
>

export interface BrowserAuthInput {
  ticket?: string
  protocolVersion?: number
  panelId?: string
}

export interface BrowserOwnerAuthInput {
  ticket?: string
  protocolVersion?: number
  endpoint?: string
  challenge?: string
}

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

export function parseBrowserAuth(value: BrowserAuthInput): BrowserAuth | null {
  const result = browserAuthSchema.safeParse(value)
  return result.success ? result.data : null
}

export function parseBrowserOwnerAuth(
  value: BrowserOwnerAuthInput
): BrowserOwnerAuth | null {
  const result = browserOwnerAuthSchema.safeParse(value)
  return result.success ? result.data : null
}

export function parseBrowserClientMessage(
  value: BrowserClientMessage
): BrowserClientMessage | null {
  const result = browserClientMessageSchema.safeParse(value)
  return result.success ? result.data : null
}

export function parseBrowserOwnerClientMessage(
  value: BrowserOwnerClientMessage
): BrowserOwnerClientMessage | null {
  const result = browserOwnerClientMessageSchema.safeParse(value)
  return result.success ? result.data : null
}
