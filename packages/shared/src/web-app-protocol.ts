import * as Schema from 'effect/Schema'
import { jsonValueSchema } from './json-schema.js'

export const webAppPermissionSchema = Schema.Literal(
  'same-origin',
  'tree-files'
)

export const appServiceRequestSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/))
})

export const appServiceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literal('stopped', 'starting', 'ready', 'failed'),
  pid: Schema.NullOr(Schema.Int),
  url: Schema.NullOr(Schema.String),
  logs: Schema.String,
  error: Schema.NullOr(Schema.String)
})
export type AppService = typeof appServiceSchema.Type

export const webAppStorageScopeSchema = Schema.Literal('instance', 'definition')
export type WebAppStorageScope = typeof webAppStorageScopeSchema.Type

const appMessageSourceSchema = Schema.Literal('treeport-app-v1')
export const appTitleMessageSchema = Schema.Struct({
  source: appMessageSourceSchema,
  method: Schema.Literal('app.title.set'),
  title: Schema.NullOr(Schema.String)
})
export const workspaceSelectionMessageSchema = Schema.Struct({
  source: appMessageSourceSchema,
  method: Schema.Literal('workspace.select'),
  index: Schema.Int.pipe(Schema.between(0, 8))
})
export const appDirtyMessageSchema = Schema.Struct({
  source: appMessageSourceSchema,
  method: Schema.Literal('app.dirty.set'),
  dirty: Schema.Boolean
})
const appRequestFields = {
  source: appMessageSourceSchema,
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
export const appRequestMessageSchema = Schema.Union(
  Schema.Struct({ ...appRequestFields, method: Schema.Literal('context') }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal(
      'services.ensure',
      'services.status',
      'services.stop'
    ),
    ...appServiceRequestSchema.fields
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('diff'),
    ...gitDiffRequestSchema.fields
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('diff.file'),
    ...gitFileDiffRequestSchema.fields
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('diff.image'),
    ...gitDiffImageRequestSchema.fields
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('network.listeners')
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('files.list')
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('files.search'),
    query: Schema.String
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('files.read'),
    path: Schema.String
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('files.write'),
    path: Schema.String,
    content: Schema.String,
    expectedRevision: Schema.String
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('storage.get'),
    scope: Schema.optional(webAppStorageScopeSchema),
    key: Schema.String
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('storage.set'),
    scope: Schema.optional(webAppStorageScopeSchema),
    key: Schema.String,
    value: jsonValueSchema
  }),
  Schema.Struct({
    ...appRequestFields,
    method: Schema.Literal('storage.delete'),
    scope: Schema.optional(webAppStorageScopeSchema),
    key: Schema.String
  })
)
