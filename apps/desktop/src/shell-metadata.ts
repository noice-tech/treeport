import { z } from 'zod'
import type {
  PhoneAccessResponse,
  WorkspaceActivityResponse
} from './desktop-contract'

// These are optional shell decorations, not the daemon's application protocol.
// Keep their decoding local so daemon schema changes cannot gate navigation.
export const phoneAccessResponseSchema: z.ZodType<PhoneAccessResponse> =
  z.object({
    url: z.string().nullable(),
    error: z.string().nullable(),
    setupCommand: z.string().nullable()
  })

export const workspaceActivityResponseSchema: z.ZodType<WorkspaceActivityResponse> =
  z.object({
    working: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative()
  })
