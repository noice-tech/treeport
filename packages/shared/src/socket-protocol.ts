import { z } from 'zod'
import type { ProductEvent } from './index.js'
import { terminalRuntimeMetadataSchema } from './terminal-protocol.js'

const productEventTypeSchema = z.enum([
  'project.created',
  'project.updated',
  'project.removed',
  'worktree.created',
  'worktree.updated',
  'create.started',
  'create.completed',
  'create.failed',
  'worktree.removed',
  'terminal.created',
  'terminal.updated',
  'terminal.removed',
  'terminal.metadata',
  'terminal.controller_changed',
  'panel.created',
  'panel.removed',
  'remove.started',
  'remove.completed',
  'remove.failed'
])

export const productEventSchema = z.strictObject({
  id: z.string().min(1).max(128),
  type: productEventTypeSchema,
  at: z.string().datetime(),
  data: z.record(z.string(), z.unknown())
})

const webPanelSnapshotSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal('web'),
  worktreeId: z.string().min(1),
  definitionId: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string()
})

export const eventsSnapshotSchema = z.strictObject({
  at: z.string().datetime(),
  terminalMetadata: z.array(terminalRuntimeMetadataSchema),
  webPanels: z.array(webPanelSnapshotSchema)
})

export type EventsSnapshot = z.infer<typeof eventsSnapshotSchema>

export interface EventsServerToClientEvents {
  snapshot: (snapshot: EventsSnapshot) => void
  product_event: (event: ProductEvent) => void
}

export type EventsClientToServerEvents = Record<never, never>

export function parseEventsSnapshot(value: unknown): EventsSnapshot | null {
  const parsed = eventsSnapshotSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function parseProductEvent(value: unknown): ProductEvent | null {
  const parsed = productEventSchema.safeParse(value)
  return parsed.success ? (parsed.data as ProductEvent) : null
}
