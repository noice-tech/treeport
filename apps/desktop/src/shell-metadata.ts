import { z } from 'zod'
import type {
  PhoneAccessResponse,
  WorkspaceActivityResponse
} from './desktop-contract'

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

export const computersListingSchema = z.object({
  self: z.object({ url: z.string().nullable() }),
  computers: z.array(z.object({ name: z.string(), url: z.string() }))
})
