import { z } from 'zod'
import { terminalProgressSchema } from '@treeport/shared'
import type {
  LaunchSpec,
  TmuxSessionState,
  TmuxSessionTitleState,
  TmuxTerminalSession
} from './core/tmux'
import type { DirectPtyRuntimeEvent } from './direct-pty-sessions'

export const TERMINAL_HOST_PROTOCOL_VERSION = 1
export const TERMINAL_HOST_MAX_FRAME_BYTES = 64 * 1024 * 1024

export interface TerminalHostRecord {
  protocolVersion: number
  hostId: string
  hostKey: string
  pid: number
  socketPath: string
  startedAt: string
}

export const terminalHostRecordSchema: z.ZodType<TerminalHostRecord> = z
  .object({
    protocolVersion: z.number().int().positive(),
    hostId: z.string().min(1),
    hostKey: z.string().min(1),
    pid: z.number().int().positive(),
    socketPath: z.string().min(1),
    startedAt: z.string().min(1)
  })
  .strict()

export interface TerminalHostCreateInput {
  socketName: string
  sessionName: string
  terminalId: string
  worktreeId: string
  name: string
  createdAt: string
  cwd: string
  argv: string[]
  initialTitle?: string | undefined
  shellCommand: string | null
  interactiveShell: boolean
  fallbackArgv?: string[] | undefined
  closeOnSuccess?: boolean | undefined
  initialSize?: { cols: number; rows: number } | undefined
  env: Record<string, string>
  setupTasks?: LaunchSpec['setupTasks'] | undefined
  setupError?: string | undefined
}

const terminalSizeSchema = z
  .object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
  })
  .strict()
const terminalIdentitySchema = z
  .object({ socketName: z.string(), sessionName: z.string() })
  .strict()
const terminalIdSchema = z.object({ terminalId: z.string() }).strict()
const setupTaskSchema = z
  .object({
    label: z.string(),
    argv: z.array(z.string()),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    timeoutMs: z.number().positive()
  })
  .strict()
const createSchema: z.ZodType<TerminalHostCreateInput> = z
  .object({
    socketName: z.string(),
    sessionName: z.string(),
    terminalId: z.string(),
    worktreeId: z.string(),
    name: z.string(),
    createdAt: z.string(),
    cwd: z.string(),
    argv: z.array(z.string()),
    initialTitle: z.string().optional(),
    shellCommand: z.string().nullable(),
    interactiveShell: z.boolean(),
    fallbackArgv: z.array(z.string()).optional(),
    closeOnSuccess: z.boolean().optional(),
    initialSize: terminalSizeSchema.optional(),
    env: z.record(z.string(), z.string()),
    setupTasks: z.array(setupTaskSchema).optional(),
    setupError: z.string().optional()
  })
  .strict()

export const terminalHostInputSchemas = {
  handshake: z
    .object({
      token: z.string(),
      hostKey: z.string(),
      protocolVersion: z.number().int()
    })
    .strict(),
  create: createSchema,
  list: z.object({ socketName: z.string() }).strict(),
  state: terminalIdentitySchema,
  size: terminalIdentitySchema,
  snapshot: terminalIdSchema,
  subscribeOutput: terminalIdSchema,
  unsubscribeOutput: terminalIdSchema,
  subscribeRuntime: terminalIdSchema,
  unsubscribeRuntime: terminalIdSchema,
  runtimeState: terminalIdSchema,
  write: z
    .object({
      terminalId: z.string(),
      data: z.string(),
      encoding: z.enum(['utf8', 'base64'])
    })
    .strict(),
  resize: z
    .object({
      terminalId: z.string(),
      cols: z.number().int().positive(),
      rows: z.number().int().positive()
    })
    .strict(),
  capture: terminalIdentitySchema
    .extend({ lines: z.number().int().positive() })
    .strict(),
  rename: terminalIdentitySchema
    .extend({ name: z.string(), updatedAt: z.string() })
    .strict(),
  processes: z
    .object({ socketName: z.string(), worktreeId: z.string() })
    .strict(),
  titleState: terminalIdentitySchema,
  setShellTitle: terminalIdentitySchema
    .extend({ title: z.string().nullable() })
    .strict(),
  kill: terminalIdentitySchema
    .extend({ terminalId: z.string().optional() })
    .strict(),
  killServer: z.object({ socketName: z.string() }).strict(),
  shutdown: z.object({ ifEmpty: z.literal(true) }).strict()
}

const TERMINAL_HOST_REQUEST_METHODS = [
  'handshake',
  'create',
  'list',
  'state',
  'size',
  'snapshot',
  'subscribeOutput',
  'unsubscribeOutput',
  'subscribeRuntime',
  'unsubscribeRuntime',
  'runtimeState',
  'write',
  'resize',
  'capture',
  'rename',
  'processes',
  'titleState',
  'setShellTitle',
  'kill',
  'killServer',
  'shutdown'
] as const satisfies readonly (keyof typeof terminalHostInputSchemas)[]

export type TerminalHostRequestMethod = keyof typeof terminalHostInputSchemas
export type TerminalHostRequestInput = z.infer<
  (typeof terminalHostInputSchemas)[TerminalHostRequestMethod]
>

export interface TerminalHostRequestFrame {
  protocolVersion: number
  type: 'request'
  id: string
  method: TerminalHostRequestMethod
  input: object
}

export interface TerminalHostResponseFrame {
  protocolVersion: number
  type: 'response'
  id: string
  result: TerminalHostResult
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
      data: { terminalId: string; value: DirectPtyRuntimeEvent }
    }

export type TerminalHostFrame =
  | TerminalHostRequestFrame
  | TerminalHostResponseFrame
  | TerminalHostEventFrame

export interface TerminalHostResults {
  handshake: TerminalHostRecord & { liveSessionCount: number }
  create: null
  list: TmuxTerminalSession[]
  state: TmuxSessionState
  size: { cols: number; rows: number } | null
  snapshot: { data: string; fence: number } | null
  subscribeOutput: null
  unsubscribeOutput: null
  subscribeRuntime: null
  unsubscribeRuntime: null
  runtimeState: {
    title: string | null
    status: TmuxTerminalSession['status']
  } | null
  write: null
  resize: null
  capture: string | null
  rename: null
  processes: Array<{ pid: number; terminalId: string }>
  titleState: TmuxSessionTitleState | null
  setShellTitle: null
  kill: null
  killServer: string[]
  shutdown: null
}

export type TerminalHostResult = TerminalHostResults[keyof TerminalHostResults]

const runtimeEventSchema = z
  .object({
    title: z.string().optional(),
    progress: terminalProgressSchema.nullable().optional(),
    bell: z.literal(true).optional(),
    exitCode: z.number().int().nullable().optional()
  })
  .strict()
const terminalHostFrameSchema: z.ZodType<TerminalHostFrame> = z.union([
  z
    .object({
      protocolVersion: z.number().int(),
      type: z.literal('request'),
      id: z.string(),
      method: z.enum(TERMINAL_HOST_REQUEST_METHODS),
      input: z.record(z.string(), z.unknown())
    })
    .strict(),
  z
    .object({
      protocolVersion: z.number().int(),
      type: z.literal('response'),
      id: z.string(),
      result: z.any(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          hostProtocolVersion: z.number().int().optional(),
          liveSessionCount: z.number().int().nonnegative().optional()
        })
        .strict()
        .nullable()
    })
    .strict(),
  z
    .object({
      protocolVersion: z.number().int(),
      type: z.literal('event'),
      event: z.literal('output'),
      data: z
        .object({
          terminalId: z.string(),
          output: z.string(),
          sequence: z.number().int().positive()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      protocolVersion: z.number().int(),
      type: z.literal('event'),
      event: z.literal('runtime'),
      data: z
        .object({ terminalId: z.string(), value: runtimeEventSchema })
        .strict()
    })
    .strict()
])

export function encodeTerminalHostFrame(frame: TerminalHostFrame): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), 'utf8')
  if (payload.byteLength > TERMINAL_HOST_MAX_FRAME_BYTES) {
    throw new Error('Terminal host frame exceeds the byte limit')
  }

  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(payload.byteLength)
  return Buffer.concat([header, payload])
}

export class TerminalHostFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): TerminalHostFrame[] {
    this.buffer = this.buffer.byteLength
      ? Buffer.concat([this.buffer, chunk])
      : chunk
    const frames: TerminalHostFrame[] = []
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length <= 0 || length > TERMINAL_HOST_MAX_FRAME_BYTES) {
        throw new Error('Invalid terminal host frame length')
      }

      if (this.buffer.byteLength < length + 4) {
        break
      }

      const payload = this.buffer.subarray(4, length + 4)
      this.buffer = this.buffer.subarray(length + 4)
      frames.push(
        terminalHostFrameSchema.parse(JSON.parse(payload.toString('utf8')))
      )
    }
    return frames
  }
}
