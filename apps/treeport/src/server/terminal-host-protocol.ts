import { z } from 'zod'
import type { TerminalProgress, TerminalSnapshotLink } from '@treeport/shared'
import type {
  HostedTerminal,
  TerminalLaunchSpec,
  TerminalSessionState,
  TerminalTitleState
} from './core/terminal'
import type { TerminalHostRuntimeEvent } from './terminal-host-sessions'

export const TERMINAL_HOST_PROTOCOL_VERSION = 3
const TERMINAL_HOST_MAX_FRAME_BYTES = 64 * 1024 * 1024

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
  setupTasks?: TerminalLaunchSpec['setupTasks'] | undefined
  setupError?: string | undefined
}

const terminalSizeSchema = z
  .object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
  })
  .strict()
const terminalIdSchema = z.object({ terminalId: z.string().min(1) }).strict()
const worktreeIdSchema = z.object({ worktreeId: z.string().min(1) }).strict()
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
    terminalId: z.string().min(1),
    worktreeId: z.string().min(1),
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
  inventory: worktreeIdSchema,
  state: terminalIdSchema,
  attach: terminalIdSchema,
  unsubscribeOutput: terminalIdSchema,
  subscribeRuntime: terminalIdSchema,
  unsubscribeRuntime: terminalIdSchema,
  runtimeState: terminalIdSchema,
  write: z
    .object({
      terminalId: z.string(),
      data: z.string(),
      encoding: z.enum(['utf8', 'base64']),
      authority: z
        .object({
          attachmentId: z.string(),
          generation: z.number().int().positive()
        })
        .strict()
    })
    .strict(),
  prepareQueryAuthority: terminalIdSchema,
  activateQueryAuthority: terminalIdSchema
    .extend({
      transitionId: z.string(),
      attachmentId: z.string(),
      generation: z.number().int().positive()
    })
    .strict(),
  hostQueryAuthority: terminalIdSchema,
  resize: terminalIdSchema
    .extend({
      cols: z.number().int().positive(),
      rows: z.number().int().positive()
    })
    .strict(),
  capture: terminalIdSchema
    .extend({ lines: z.number().int().positive() })
    .strict(),
  rename: terminalIdSchema
    .extend({ name: z.string(), updatedAt: z.string() })
    .strict(),
  processes: worktreeIdSchema,
  titleState: terminalIdSchema,
  signal: terminalIdSchema
    .extend({ signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP']) })
    .strict(),
  kill: terminalIdSchema,
  killWorktree: worktreeIdSchema,
  shutdown: z.object({ ifEmpty: z.literal(true) }).strict()
}

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

type TerminalHostRequestMethod = keyof typeof terminalHostInputSchemas
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
  /**
   * Current hosts always send result. It is optional only so a new daemon can
   * read an old host's structured INCOMPATIBLE_PROTOCOL response and refuse
   * replacement safely.
   */
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
  handshake: TerminalHostRecord & { liveSessionCount: number }
  create: null
  inventory: HostedTerminal[]
  state: TerminalSessionState
  attach: {
    data: string
    links?: TerminalSnapshotLink[] | undefined
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

const runtimeEventSchema = z
  .object({
    title: z.string().optional(),
    progress: z
      .strictObject({
        state: z.enum(['normal', 'error', 'indeterminate', 'paused']),
        value: z.number().int().min(0).max(100).nullable()
      })
      .nullable()
      .optional(),
    bell: z
      .object({
        sequence: z.number().int().positive(),
        at: z.string().datetime()
      })
      .strict()
      .optional(),
    exitCode: z.number().int().nullable().optional(),
    titleState: z
      .object({
        terminalTitle: z.string().nullable(),
        currentCommand: z.string().nullable(),
        commandLine: z.string().nullable()
      })
      .strict()
      .optional()
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
      result: z.any().optional(),
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
