import * as Schema from 'effect/Schema'
import type { WebAppInput } from '@treeport/app-sdk'
import { jsonValueSchema } from './json.ts'

const nullableStringSchema = Schema.NullOr(Schema.String)

const jsonObjectSchema = Schema.Record({
  key: Schema.String,
  value: jsonValueSchema
})

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

const webAppStorageScopeSchema = Schema.Literal('instance', 'definition')

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

export const WEB_APP_INPUT_MAX_BYTES = 64 * 1024

export type WebAppDefinition = typeof webAppDefinitionSchema.Type

export type OpenWebAppResult = typeof openWebAppResponseSchema.Type

export const webAppInputSchema: Schema.Schema<WebAppInput> = Schema.Record({
  key: Schema.String,
  value: jsonValueSchema
})

export const createWebAppSchema = Schema.Struct({
  definitionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  input: Schema.optional(Schema.NullOr(webAppInputSchema)),
  launchCwd: Schema.optional(
    Schema.NullOr(Schema.String.pipe(Schema.maxLength(4_096)))
  )
})

export const updateWebAppPermissionGrantSchema = Schema.Struct({
  granted: Schema.Boolean,
  permissions: Schema.mutable(Schema.Array(webAppPermissionSchema))
})

export const openWebAppSchema = Schema.Struct({
  ...createWebAppSchema.fields,
  newInstance: Schema.optional(Schema.Boolean),
  sourceTerminalId: Schema.optional(
    Schema.NullOr(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
    )
  )
})

const webAppStorageKeySchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)

export const getWebAppStorageSchema = Schema.Struct({
  scope: Schema.optional(webAppStorageScopeSchema),
  key: webAppStorageKeySchema
})

export const setWebAppStorageSchema = Schema.Struct({
  scope: Schema.optional(webAppStorageScopeSchema),
  key: webAppStorageKeySchema,
  value: jsonValueSchema
})

export const deleteWebAppStorageSchema = Schema.Struct({
  scope: Schema.optional(webAppStorageScopeSchema),
  key: webAppStorageKeySchema
})

const webAppLaunchSchema = Schema.Struct({
  input: Schema.NullOr(jsonObjectSchema),
  cwd: nullableStringSchema
})

const webAppSandboxSchema = Schema.Struct({
  /** False only for apps explicitly declared as trusted and unsandboxed. */
  enabled: Schema.Boolean,
  allowSameOrigin: Schema.Boolean
})

export const webAppSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal('web'),
  worktreeId: Schema.String,
  definitionId: Schema.String,
  title: Schema.String,
  launch: webAppLaunchSchema,
  permissions: Schema.mutable(Schema.Array(webAppPermissionSchema)),
  sandbox: webAppSandboxSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String
})

const webAppDefinitionSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    icon: nullableStringSchema,
    source: Schema.Union(
      Schema.Struct({ type: Schema.Literal('project') }),
      Schema.Struct({
        type: Schema.Literal('package'),
        packageId: Schema.String,
        source: Schema.String,
        scope: Schema.Literal('global', 'project')
      })
    ),
    permissions: Schema.mutable(Schema.Array(webAppPermissionSchema)),
    permissionsGranted: Schema.Boolean,
    sandbox: webAppSandboxSchema
  })
)

const webAppContextSchema = Schema.Struct({
  apiVersion: Schema.Literal(1),
  app: webAppSchema,
  launch: webAppLaunchSchema,
  project: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind: Schema.Literal('repository', 'folder'),
    defaultBranch: nullableStringSchema
  }),
  worktree: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind: Schema.Literal('main', 'linked', 'folder'),
    branch: nullableStringSchema,
    head: nullableStringSchema
  })
})

export const webAppDefinitionsResponseSchema = Schema.Struct({
  definitions: Schema.Array(webAppDefinitionSchema)
})

export const openWebAppResponseSchema = Schema.Struct({
  app: webAppSchema,
  created: Schema.Boolean,
  reused: Schema.Boolean
})

export const webAppContextResponseSchema = Schema.Struct({
  context: webAppContextSchema
})

export const webAppResponseSchema = Schema.Struct({ app: webAppSchema })

export const webAppDefinitionResponseSchema = Schema.Struct({
  definition: webAppDefinitionSchema
})

export const hasDataResponseSchema = Schema.Struct({ hasData: Schema.Boolean })

export const storageValueResponseSchema = Schema.Struct({
  found: Schema.Boolean,
  value: jsonValueSchema
})
