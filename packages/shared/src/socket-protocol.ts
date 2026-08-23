import { z } from 'zod'
import type { ProductEvent } from './index.js'
import { terminalRuntimeMetadataSchema } from './terminal-protocol.js'

const identifierSchema = z.string().min(1).max(128)
const eventEnvelope = <Type extends string, DataSchema extends z.ZodType>(
  type: Type,
  data: DataSchema
) =>
  z.strictObject({
    id: identifierSchema,
    type: z.literal(type),
    at: z.string().datetime(),
    data
  })
const projectEventDataSchema = z.strictObject({
  projectId: identifierSchema,
  worktreeId: z.null()
})
const worktreeEventDataSchema = z.strictObject({
  worktreeId: identifierSchema
})
const projectWorktreeEventDataSchema = z.strictObject({
  projectId: identifierSchema,
  worktreeId: identifierSchema
})
const operationEventDataSchema = z.strictObject({
  operationId: identifierSchema,
  worktreeId: identifierSchema
})

export const productEventSchema = z.discriminatedUnion('type', [
  eventEnvelope('project.created', projectEventDataSchema),
  eventEnvelope('project.updated', projectEventDataSchema),
  eventEnvelope('project.removed', projectEventDataSchema),
  eventEnvelope('worktree.created', projectWorktreeEventDataSchema),
  eventEnvelope('worktree.updated', worktreeEventDataSchema),
  eventEnvelope('worktree.removed', projectWorktreeEventDataSchema),
  eventEnvelope(
    'create.started',
    z.strictObject({
      projectId: identifierSchema,
      operationId: identifierSchema,
      worktreeId: z.null()
    })
  ),
  eventEnvelope(
    'create.completed',
    z.strictObject({
      projectId: identifierSchema,
      operationId: identifierSchema,
      worktreeId: identifierSchema
    })
  ),
  eventEnvelope(
    'create.failed',
    z.strictObject({
      projectId: identifierSchema,
      operationId: identifierSchema,
      worktreeId: z.null()
    })
  ),
  eventEnvelope(
    'terminal.created',
    z.strictObject({
      projectId: identifierSchema.optional(),
      worktreeId: identifierSchema,
      terminalId: identifierSchema
    })
  ),
  eventEnvelope(
    'terminal.updated',
    z.strictObject({
      worktreeId: identifierSchema,
      terminalId: identifierSchema
    })
  ),
  eventEnvelope(
    'terminal.removed',
    z.strictObject({
      worktreeId: identifierSchema,
      terminalId: identifierSchema
    })
  ),
  eventEnvelope(
    'terminal.metadata',
    terminalRuntimeMetadataSchema.extend({ worktreeId: z.null() })
  ),
  eventEnvelope(
    'terminal.controller_changed',
    z.strictObject({
      terminalId: identifierSchema,
      controlled: z.boolean(),
      worktreeId: z.null()
    })
  ),
  eventEnvelope(
    'panel.created',
    z.strictObject({ worktreeId: identifierSchema, panelId: identifierSchema })
  ),
  eventEnvelope(
    'panel.updated',
    z.strictObject({ worktreeId: identifierSchema, panelId: identifierSchema })
  ),
  eventEnvelope(
    'panel.open_requested',
    z.strictObject({
      worktreeId: identifierSchema,
      panelId: identifierSchema,
      sourceTerminalId: identifierSchema.nullable()
    })
  ),
  eventEnvelope(
    'panel.removed',
    z.strictObject({ worktreeId: identifierSchema, panelId: identifierSchema })
  ),
  eventEnvelope(
    'workspace.open_requested',
    z.strictObject({
      worktreeId: identifierSchema,
      sourceTerminalId: identifierSchema
    })
  ),
  eventEnvelope(
    'remove.started',
    operationEventDataSchema.extend({ kind: z.literal('remove') })
  ),
  eventEnvelope('remove.completed', operationEventDataSchema),
  eventEnvelope(
    'remove.failed',
    operationEventDataSchema.extend({ error: z.string() })
  )
])

const webPanelSnapshotSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal('web'),
  worktreeId: z.string().min(1),
  definitionId: z.string().min(1),
  title: z.string().min(1),
  launch: z.strictObject({
    input: z.record(z.string(), z.json()).nullable(),
    cwd: z.string().nullable()
  }),
  permissions: z.array(z.enum(['same-origin', 'host-browser'])),
  sandbox: z.strictObject({ allowSameOrigin: z.boolean() }),
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

const socketProtocolInputSchema = z.unknown()
type SocketProtocolInput = z.input<typeof socketProtocolInputSchema>

export function parseEventsSnapshot(
  value: SocketProtocolInput
): EventsSnapshot | null {
  const parsed = eventsSnapshotSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function parseProductEvent(
  value: SocketProtocolInput
): ProductEvent | null {
  const parsed = productEventSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
