import { z } from 'zod'

export const BROWSER_PROTOCOL_VERSION = 1
export const BROWSER_MAX_FRAME_BYTES = 8 * 1024 * 1024
export const BROWSER_MAX_MESSAGE_BYTES = 128 * 1024

export type BrowserMouseButton = 'left' | 'right' | 'middle'

const browserUrlSchema = z
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
  }),
  z.strictObject({ type: z.literal('reset') })
])

export type BrowserClientMessage = z.infer<typeof browserClientMessageSchema>

export interface BrowserSessionState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  controlled: boolean
  hasController: boolean
  controller: 'you' | 'agent' | 'other' | 'none'
  viewport: { width: number; height: number }
}

export type BrowserServerMessage =
  | { type: 'ready'; state: BrowserSessionState }
  | { type: 'state'; state: BrowserSessionState }
  | { type: 'controlChanged'; state: BrowserSessionState }
  | { type: 'navigationError'; message: string }
  | {
      type: 'browserUnavailable'
      message: string
      installCommand: string | null
    }
  | { type: 'browserCrashed'; message: string }
  | { type: 'closed'; reason: string }

export interface BrowserFrame {
  sequence: number
  mimeType: 'image/jpeg'
  timestamp: number
  width: number
  height: number
  data: Uint8Array
}

export const browserTicketRequestSchema = z.strictObject({
  clientId: z.string().min(1).max(128)
})

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
  ticket: z.string().min(32).max(256),
  protocolVersion: z.literal(BROWSER_PROTOCOL_VERSION)
})

export type BrowserAuth = z.infer<typeof browserAuthSchema>

export interface BrowserClientToServerEvents {
  command: (message: unknown) => void
}

export interface BrowserServerToClientEvents {
  message: (message: BrowserServerMessage) => void
  frame: (frame: BrowserFrame) => void
}

export function parseBrowserAuth(value: unknown): BrowserAuth | null {
  const result = browserAuthSchema.safeParse(value)
  return result.success ? result.data : null
}

export function parseBrowserClientMessage(
  value: unknown
): BrowserClientMessage | null {
  const result = browserClientMessageSchema.safeParse(value)
  return result.success ? result.data : null
}
