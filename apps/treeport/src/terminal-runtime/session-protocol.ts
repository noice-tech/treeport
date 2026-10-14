import { z } from 'zod'

// This is the deliberately small, cross-release PTY-owner contract. It contains
// no emulator state or product concepts. Old owners stay alive for their sessions.
export const sessionRecordSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('output'),
    at: z.int().nonnegative(),
    sequence: z.int().positive(),
    data: z.string()
  }),
  z.object({
    type: z.literal('resize'),
    at: z.int().nonnegative(),
    sequence: z.int().positive(),
    cols: z.int().positive(),
    rows: z.int().positive()
  }),
  z.object({
    type: z.literal('marker'),
    at: z.int().nonnegative(),
    sequence: z.int().positive(),
    data: z.string()
  }),
  z.object({
    type: z.literal('exit'),
    at: z.int().nonnegative(),
    sequence: z.int().positive(),
    exitCode: z.int()
  })
])
export type SessionRecord = z.infer<typeof sessionRecordSchema>
export type SessionRecordInput = SessionRecord extends infer Record
  ? Record extends SessionRecord
    ? Omit<Record, 'sequence' | 'at'> & { at?: number }
    : never
  : never

export const sessionManifestSchema = z.object({
  version: z.literal(1),
  token: z.string().min(32),
  socketPath: z.string().min(1),
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  cols: z.int().positive(),
  rows: z.int().positive(),
  // Metadata belongs to the engine; the owner only stores it.
  metadata: z.string(),
  journalLimitBytes: z.int().positive()
})
export type SessionManifest = z.infer<typeof sessionManifestSchema>

export const sessionStatusSchema = z
  .object({
    version: z.literal(1),
    ownerPid: z.int().positive(),
    pid: z.int().nonnegative(),
    process: z.string(),
    cols: z.int().positive(),
    rows: z.int().positive(),
    sequence: z.int().nonnegative(),
    processedSequence: z.int().nonnegative(),
    exitCode: z.int().nullable(),
    error: z.string().nullable(),
    incomplete: z.boolean(),
    startupAborted: z.boolean().default(false)
  })
  .refine(
    (status) =>
      status.startupAborted
        ? status.pid === 0 &&
          status.exitCode === 1 &&
          !status.incomplete &&
          status.error !== null
        : status.pid > 0,
    'Only a proven aborted startup may have no command PID'
  )
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const sessionRequestSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('attach'),
    id: z.string(),
    token: z.string(),
    journalLimitBytes: z.int().positive().optional()
  }),
  z.object({ method: z.literal('inspect'), id: z.string(), token: z.string() }),
  z.object({
    method: z.literal('write'),
    id: z.string(),
    data: z.string(),
    encoding: z.enum(['utf8', 'base64'])
  }),
  z.object({
    method: z.literal('resize'),
    id: z.string(),
    cols: z.int().min(1).max(10000),
    rows: z.int().min(1).max(10000)
  }),
  z.object({
    method: z.literal('signal'),
    id: z.string(),
    signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'])
  }),
  z.object({ method: z.literal('pause'), id: z.string(), paused: z.boolean() }),
  z.object({ method: z.literal('status'), id: z.string() }),
  z.object({
    method: z.literal('terminate'),
    id: z.string(),
    token: z.string().optional()
  }),
  z.object({
    method: z.literal('processed'),
    id: z.string(),
    sequence: z.int().nonnegative()
  }),
  z.object({ method: z.literal('marker'), id: z.string(), data: z.string() }),
  z.object({
    method: z.literal('metadata'),
    id: z.string(),
    metadata: z.string()
  })
])
export type SessionRequest = z.infer<typeof sessionRequestSchema>

export const sessionFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('response'),
    id: z.string(),
    status: sessionStatusSchema.nullable(),
    error: z.string().nullable()
  }),
  sessionRecordSchema,
  z.object({ type: z.literal('ready'), sequence: z.int().nonnegative() }),
  z.object({ type: z.literal('fault'), message: z.string() })
])
export type SessionFrame = z.infer<typeof sessionFrameSchema>
export const SESSION_MAX_FRAME_BYTES = 8 * 1024 * 1024
export const SESSION_DEFAULT_JOURNAL_LIMIT = 512 * 1024 * 1024
