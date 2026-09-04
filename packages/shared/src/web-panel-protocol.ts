import * as Schema from 'effect/Schema'
import { jsonValueSchema } from './json-schema.js'

export const webPanelPermissionSchema = Schema.Literal(
  'same-origin',
  'tree-files'
)

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
export const panelRequestMessageSchema = Schema.Union(
  Schema.Struct({ ...panelRequestFields, method: Schema.Literal('context') }),
  Schema.Struct({ ...panelRequestFields, method: Schema.Literal('diff') }),
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
