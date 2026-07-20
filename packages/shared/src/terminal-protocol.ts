import { z } from "zod";

export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const TERMINAL_HELLO_TIMEOUT_MS = 5_000;
export const TERMINAL_HEARTBEAT_MS = 15_000;
export const TERMINAL_HEARTBEAT_TIMEOUT_MS = 45_000;
export const TERMINAL_CONTROLLER_GRACE_MS = 10_000;
export const TERMINAL_OUTPUT_HIGH_WATERMARK = 256 * 1024;
export const TERMINAL_OUTPUT_LOW_WATERMARK = 64 * 1024;
export const TERMINAL_OUTPUT_STALL_TIMEOUT_MS = 30_000;
export const TERMINAL_MAX_CLIENT_MESSAGE_BYTES = 128 * 1024;

const version = z.literal(TERMINAL_PROTOCOL_VERSION);
const clientId = z.string().min(1).max(128);
const dimensions = {
  cols: z.number().int().min(2).max(1_000),
  rows: z.number().int().min(2).max(500),
};

export const terminalClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ version, type: z.literal("hello"), clientId, ...dimensions }),
  z.strictObject({ version, type: z.literal("input"), data: z.string().max(64 * 1024) }),
  z.strictObject({ version, type: z.literal("binary"), data: z.string().max(64 * 1024) }),
  z.strictObject({ version, type: z.literal("resize"), ...dimensions }),
  z.strictObject({ version, type: z.literal("take_control") }),
  z.strictObject({
    version,
    type: z.literal("output_ack"),
    streamId: z.string().min(1).max(128),
    sequence: z.number().int().nonnegative(),
  }),
  z.strictObject({ version, type: z.literal("pong"), nonce: z.string().min(1).max(128) }),
]);

export const terminalServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    version,
    type: z.literal("ready"),
    connectionId: z.string().min(1).max(128),
    streamId: z.string().min(1).max(128),
    controller: z.boolean(),
    reset: z.literal("full"),
    heartbeatMs: z.number().int().positive(),
  }),
  z.strictObject({
    version,
    type: z.literal("output"),
    streamId: z.string().min(1).max(128),
    sequence: z.number().int().positive(),
    data: z.string(),
  }),
  z.strictObject({ version, type: z.literal("title"), title: z.string().max(256) }),
  z.strictObject({ version, type: z.literal("control"), controller: z.boolean() }),
  z.strictObject({ version, type: z.literal("ping"), nonce: z.string().min(1).max(128) }),
  z.strictObject({ version, type: z.literal("exit"), exitCode: z.number().int().nullable() }),
  z.strictObject({
    version,
    type: z.literal("error"),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
  }),
]);

export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;

export function parseTerminalClientMessage(value: unknown): TerminalClientMessage | null {
  const parsed = terminalClientMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseTerminalServerMessage(value: unknown): TerminalServerMessage | null {
  const parsed = terminalServerMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
