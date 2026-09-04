/* eslint-disable anti-slop/no-unknown-parameters -- Effect Schema decoders validate untrusted protocol input at this boundary. */
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { browserUrlSchema } from './browser-protocol.js'
import { jsonValueSchema } from './json-schema.js'
import {
  terminalRuntimeMetadataFields,
  terminalRuntimeMetadataSchema
} from './terminal-protocol.js'
import { webPanelPermissionSchema } from './web-panel-protocol.js'

export const EVENT_PROTOCOL_VERSION = 2

const identifierSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)
const dateTimeString = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value)))
)
const eventEnvelope = <Type extends string, Data extends Schema.Schema.Any>(
  type: Type,
  data: Data
) =>
  Schema.Struct({
    id: identifierSchema,
    type: Schema.Literal(type),
    at: dateTimeString,
    data
  })
const projectEventDataSchema = Schema.Struct({
  projectId: identifierSchema,
  worktreeId: Schema.Null
})
const worktreeEventDataSchema = Schema.Struct({ worktreeId: identifierSchema })
const projectWorktreeEventDataSchema = Schema.Struct({
  projectId: identifierSchema,
  worktreeId: identifierSchema
})
const operationEventDataSchema = Schema.Struct({
  operationId: identifierSchema,
  worktreeId: identifierSchema
})
const webPanelSnapshotSchema = Schema.Struct({
  id: identifierSchema,
  kind: Schema.Literal('web'),
  worktreeId: identifierSchema,
  definitionId: identifierSchema,
  title: nonEmptyString(),
  launch: Schema.Struct({
    input: Schema.NullOr(
      Schema.mutable(
        Schema.Record({ key: Schema.String, value: jsonValueSchema })
      )
    ),
    cwd: Schema.NullOr(Schema.String)
  }),
  permissions: Schema.mutable(Schema.Array(webPanelPermissionSchema)),
  sandbox: Schema.Struct({ allowSameOrigin: Schema.Boolean }),
  createdAt: Schema.String,
  updatedAt: Schema.String
})
const browserPanelSnapshotSchema = Schema.Struct({
  id: identifierSchema,
  kind: Schema.Literal('browser'),
  worktreeId: identifierSchema,
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  url: Schema.Union(Schema.Literal('about:blank'), browserUrlSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String
})
const openPanelSnapshotSchema = Schema.Union(
  webPanelSnapshotSchema,
  browserPanelSnapshotSchema
)
const terminalRecordSchema = Schema.Struct({
  id: identifierSchema,
  worktreeId: identifierSchema,
  name: nonEmptyString(),
  argv: Schema.mutable(Schema.Array(Schema.String)),
  shellCommand: Schema.NullOr(Schema.String),
  interactiveShell: Schema.Boolean,
  status: Schema.Literal('running', 'exited', 'missing'),
  exitCode: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  updatedAt: Schema.String
})

function nonEmptyString() {
  return Schema.String.pipe(Schema.minLength(1))
}

export const productEventSchema = Schema.Union(
  eventEnvelope('project.created', projectEventDataSchema),
  eventEnvelope('project.updated', projectEventDataSchema),
  eventEnvelope('project.removed', projectEventDataSchema),
  eventEnvelope('worktree.created', projectWorktreeEventDataSchema),
  eventEnvelope('worktree.updated', worktreeEventDataSchema),
  eventEnvelope('worktree.removed', projectWorktreeEventDataSchema),
  eventEnvelope(
    'create.started',
    Schema.Struct({
      projectId: identifierSchema,
      operationId: identifierSchema,
      worktreeId: Schema.Null
    })
  ),
  eventEnvelope(
    'create.completed',
    Schema.Struct({
      projectId: identifierSchema,
      operationId: identifierSchema,
      worktreeId: identifierSchema
    })
  ),
  eventEnvelope(
    'create.failed',
    Schema.Struct({
      projectId: identifierSchema,
      operationId: identifierSchema,
      worktreeId: Schema.Null
    })
  ),
  eventEnvelope(
    'terminal.created',
    Schema.Struct({
      projectId: Schema.optional(identifierSchema),
      worktreeId: identifierSchema,
      terminalId: identifierSchema,
      terminal: terminalRecordSchema
    })
  ),
  eventEnvelope(
    'terminal.updated',
    Schema.Struct({
      worktreeId: identifierSchema,
      terminalId: identifierSchema
    })
  ),
  eventEnvelope(
    'terminal.removed',
    Schema.Struct({
      worktreeId: identifierSchema,
      terminalId: identifierSchema
    })
  ),
  eventEnvelope(
    'terminal.metadata',
    Schema.Struct({
      ...terminalRuntimeMetadataFields,
      worktreeId: Schema.Null
    })
  ),
  eventEnvelope(
    'terminal.controller_changed',
    Schema.Struct({
      terminalId: identifierSchema,
      controlled: Schema.Boolean,
      worktreeId: Schema.Null
    })
  ),
  eventEnvelope(
    'panel.created',
    Schema.Struct({
      worktreeId: identifierSchema,
      panelId: identifierSchema
    })
  ),
  eventEnvelope(
    'panel.updated',
    Schema.Struct({
      worktreeId: identifierSchema,
      panelId: identifierSchema
    })
  ),
  eventEnvelope(
    'panel.open_requested',
    Schema.Struct({
      worktreeId: identifierSchema,
      panelId: identifierSchema,
      panel: openPanelSnapshotSchema,
      sourceTerminalId: Schema.NullOr(identifierSchema),
      sourcePanelId: Schema.NullOr(identifierSchema)
    })
  ),
  eventEnvelope(
    'panel.removed',
    Schema.Struct({
      worktreeId: identifierSchema,
      panelId: identifierSchema
    })
  ),
  eventEnvelope(
    'workspace.open_requested',
    Schema.Struct({
      worktreeId: identifierSchema,
      sourceTerminalId: identifierSchema
    })
  ),
  eventEnvelope(
    'remove.started',
    Schema.Struct({
      ...operationEventDataSchema.fields,
      kind: Schema.Literal('remove')
    })
  ),
  eventEnvelope('remove.completed', operationEventDataSchema),
  eventEnvelope(
    'remove.failed',
    Schema.Struct({
      ...operationEventDataSchema.fields,
      error: Schema.String
    })
  )
)

export type NetworkProductEvent = Schema.Schema.Type<typeof productEventSchema>

export const eventsSnapshotSchema = Schema.Struct({
  at: dateTimeString,
  terminalMetadata: Schema.Array(terminalRuntimeMetadataSchema),
  webPanels: Schema.Array(webPanelSnapshotSchema),
  browserPanels: Schema.Array(browserPanelSnapshotSchema)
})
export type EventsSnapshot = Schema.Schema.Type<typeof eventsSnapshotSchema>

export const socketHandshakeSchema = Schema.Struct({
  type: Schema.Literal('handshake'),
  auth: jsonValueSchema,
  query: Schema.Record({ key: Schema.String, value: Schema.String })
})
export type SocketHandshake = Schema.Schema.Type<typeof socketHandshakeSchema>

export const socketMessageSchema = Schema.Struct({
  event: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  payload: jsonValueSchema
})
export type SocketMessage = Schema.Schema.Type<typeof socketMessageSchema>

function decodeOrNull<S extends Schema.Schema<any, any, never>>(
  schema: S,
  value: unknown
): Schema.Schema.Type<S> | null {
  const parsed = Schema.decodeUnknownEither(schema, {
    onExcessProperty: 'error'
  })(value)
  return Either.isRight(parsed) ? parsed.right : null
}

export function parseEventsSnapshot(value: unknown): EventsSnapshot | null {
  return decodeOrNull(eventsSnapshotSchema, value)
}
export function parseProductEvent(value: unknown): NetworkProductEvent | null {
  return decodeOrNull(productEventSchema, value)
}
export function parseSocketHandshake(value: unknown): SocketHandshake | null {
  return decodeOrNull(socketHandshakeSchema, value)
}
export function parseSocketMessage(value: unknown): SocketMessage | null {
  return decodeOrNull(socketMessageSchema, value)
}
