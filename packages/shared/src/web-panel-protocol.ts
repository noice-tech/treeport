import * as Schema from 'effect/Schema'
import { jsonValueSchema } from './json-schema.js'

export const webPanelPermissionSchema = Schema.Literal(
  'same-origin',
  'tree-files'
)

export const panelServiceRequestSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/))
})

export const panelServiceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literal('stopped', 'starting', 'ready', 'failed'),
  pid: Schema.NullOr(Schema.Int),
  url: Schema.NullOr(Schema.String),
  logs: Schema.String,
  error: Schema.NullOr(Schema.String)
})
export type PanelService = typeof panelServiceSchema.Type

const panelMessageSourceSchema = Schema.Literal('treeport-panel-v1')
export const panelTitleMessageSchema = Schema.Struct({
  source: panelMessageSourceSchema,
  method: Schema.Literal('panel.title.set'),
  title: Schema.NullOr(Schema.String)
})
export const workspaceSelectionMessageSchema = Schema.Struct({
  source: panelMessageSourceSchema,
  method: Schema.Literal('workspace.select'),
  index: Schema.Int.pipe(Schema.between(0, 8))
})
export const panelDirtyMessageSchema = Schema.Struct({
  source: panelMessageSourceSchema,
  method: Schema.Literal('panel.dirty.set'),
  dirty: Schema.Boolean
})
const panelRequestFields = {
  source: panelMessageSourceSchema,
  id: Schema.String
}
export const gitDiffRequestSchema = Schema.Struct({
  scope: Schema.optional(Schema.Literal('committed', 'uncommitted'))
})
export const gitFileDiffRequestSchema = Schema.Struct({
  path: Schema.String,
  ...gitDiffRequestSchema.fields
})
export const gitDiffImageRequestSchema = Schema.Struct({
  path: Schema.String,
  commit: Schema.NullOr(
    Schema.String.pipe(Schema.pattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))
  )
})
export const panelRequestMessageSchema = Schema.Union(
  Schema.Struct({ ...panelRequestFields, method: Schema.Literal('context') }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal(
      'services.ensure',
      'services.status',
      'services.stop'
    ),
    ...panelServiceRequestSchema.fields
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('diff'),
    ...gitDiffRequestSchema.fields
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('diff.file'),
    ...gitFileDiffRequestSchema.fields
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('diff.image'),
    ...gitDiffImageRequestSchema.fields
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('network.listeners')
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('files.list')
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('files.search'),
    query: Schema.String
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('files.read'),
    path: Schema.String
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('files.write'),
    path: Schema.String,
    content: Schema.String,
    expectedRevision: Schema.String
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('storage.get'),
    key: Schema.String
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('storage.set'),
    key: Schema.String,
    value: jsonValueSchema
  }),
  Schema.Struct({
    ...panelRequestFields,
    method: Schema.Literal('storage.delete'),
    key: Schema.String
  })
)
