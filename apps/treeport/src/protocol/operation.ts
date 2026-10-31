import * as Schema from 'effect/Schema'
import { dirtyStateSchema } from './worktree.ts'
import { terminalAfterExitSchema } from './terminal.ts'
import { jsonValueSchema } from './json.ts'

const stringArraySchema = Schema.Array(Schema.String)

const nullableStringSchema = Schema.NullOr(Schema.String)

const jsonObjectSchema = Schema.Record({
  key: Schema.String,
  value: jsonValueSchema
})

export type CleanupCommandProgress = typeof cleanupCommandProgressSchema.Type

export type RemovePreview = typeof removePreviewSchema.Type

export type RemovalCheckoutIdentity = typeof removalCheckoutIdentitySchema.Type

export type CreateOperationRequest = typeof createOperationRequestSchema.Type

export type CreateOperationResult = typeof createOperationResultSchema.Type

export type RemoveOperationRequest = typeof removeOperationRequestSchema.Type

export type RemoveOperationResult = typeof removeOperationResultSchema.Type

export type ExternalRemoveOperationResult =
  typeof externalRemoveResultSchema.Type

interface OperationRecordBase {
  id: string
  projectId: string | null
  worktreeId: string | null
  status: 'pending' | 'running' | 'completed' | 'failed'
  error: string | null
  createdAt: string
  updatedAt: string
}

export type RemoveOperationRecord = OperationRecordBase & {
  kind: 'remove'
  request: RemoveOperationRequest
  result: RemoveOperationResult | null
}

export type OperationRecord =
  | (OperationRecordBase & {
      kind: 'create'
      request: CreateOperationRequest
      result: CreateOperationResult | null
    })
  | RemoveOperationRecord
  | (OperationRecordBase & {
      kind: 'external_remove'
      request: { source: 'git' }
      result: ExternalRemoveOperationResult | null
    })
  | (OperationRecordBase & {
      kind: 'finish' | 'discard' | 'project_cleanup'
      request: object
      result: object | null
    })

export const removeWorktreeSchema = Schema.Struct({
  confirmationToken: Schema.String.pipe(Schema.length(64)),
  confirmDestructive: Schema.Boolean,
  skipCleanup: Schema.optionalWith(Schema.Boolean, {
    default: () => false
  })
})

export const operationQuerySchema = Schema.Struct({
  kind: Schema.optional(
    Schema.Literal(
      'create',
      'finish',
      'discard',
      'project_cleanup',
      'remove',
      'external_remove'
    )
  ),
  projectId: Schema.optional(Schema.String)
})

const cleanupCommandProgressSchema = Schema.mutable(
  Schema.Struct({
    name: Schema.String,
    status: Schema.Literal('pending', 'running', 'completed', 'failed'),
    stdout: Schema.String,
    stderr: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
    error: nullableStringSchema,
    outputTruncated: Schema.Boolean
  })
)

const removeCleanupProgressSchema = Schema.mutable(
  Schema.Struct({
    status: Schema.Literal(
      'pending',
      'running',
      'completed',
      'failed',
      'skipped'
    ),
    definitionHash: nullableStringSchema,
    skippedReason: nullableStringSchema,
    commands: Schema.mutable(Schema.Array(cleanupCommandProgressSchema))
  })
)

const removePreviewSchema = Schema.Struct({
  worktreeId: Schema.String,
  name: Schema.String,
  path: Schema.String,
  head: Schema.String,
  branch: nullableStringSchema,
  detached: Schema.Boolean,
  locked: Schema.Boolean,
  lockReason: nullableStringSchema,
  dirty: dirtyStateSchema,
  detachedHeadReachable: Schema.NullOr(Schema.Boolean),
  forceRequired: Schema.Boolean,
  eligible: Schema.Boolean,
  reasons: stringArraySchema,
  warnings: stringArraySchema,
  cleanup: Schema.Struct({
    commands: stringArraySchema,
    available: Schema.Boolean,
    unavailableReason: nullableStringSchema
  }),
  terminals: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: Schema.Literal('running', 'exited', 'missing', 'unavailable')
    })
  ),
  confirmationToken: Schema.String
})

const operationBaseFields = {
  id: Schema.String,
  projectId: nullableStringSchema,
  worktreeId: nullableStringSchema,
  status: Schema.Literal('pending', 'running', 'completed', 'failed'),
  error: nullableStringSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String
}

const createOperationRequestSchema = Schema.mutable(
  Schema.Struct({
    name: Schema.String,
    base: Schema.Literal('default', 'current'),
    context: Schema.optional(
      Schema.Record({ key: Schema.String, value: Schema.String })
    ),
    initialTerminal: Schema.optional(
      Schema.mutable(
        Schema.Struct({
          name: Schema.String,
          command: Schema.optional(Schema.String),
          afterExit: Schema.optional(terminalAfterExitSchema),
          initialSize: Schema.optional(
            Schema.Struct({ cols: Schema.Int, rows: Schema.Int })
          )
        })
      )
    ),
    sourceWorktreeId: Schema.optional(Schema.String),
    originWorktreeId: Schema.optional(Schema.String),
    treeTitle: Schema.optional(
      Schema.Struct({ command: stringArraySchema, pendingTitle: Schema.String })
    )
  })
)

const createOperationResultSchema = Schema.Struct({
  worktreeId: Schema.String,
  terminalId: nullableStringSchema,
  terminalError: nullableStringSchema,
  setupError: nullableStringSchema
})

const removalCheckoutIdentitySchema = Schema.Struct({
  path: Schema.String,
  device: Schema.String,
  inode: Schema.String,
  gitWorktreeKey: Schema.String,
  gitMarker: Schema.String,
  repositoryIdentity: nullableStringSchema,
  managedWrapperPath: nullableStringSchema,
  quarantinePath: Schema.String
})

const removeOperationRequestSchema = Schema.mutable(
  Schema.Struct({
    confirmation: Schema.NullOr(Schema.Boolean),
    confirmationToken: nullableStringSchema,
    confirmDestructive: Schema.NullOr(Schema.Boolean),
    skipCleanup: Schema.Boolean,
    preview: Schema.NullOr(removePreviewSchema),
    checkoutIdentity: Schema.NullOr(removalCheckoutIdentitySchema),
    prunable: Schema.NullOr(Schema.Boolean),
    gitWorktreeKey: nullableStringSchema,
    repositoryIdentity: nullableStringSchema,
    phase: Schema.NullOr(
      Schema.Literal(
        'accepted',
        'terminals_stopped',
        'cleanup_commands_completed',
        'git_removed',
        'cleanup_pending'
      )
    ),
    managedWrapperPath: nullableStringSchema,
    cleanupCommands: removeCleanupProgressSchema
  })
)

const removeOperationResultSchema = Schema.Struct({
  removed: Schema.Literal(true),
  worktreeId: Schema.String,
  name: Schema.String,
  branchPreserved: nullableStringSchema,
  path: Schema.String,
  recovered: Schema.Boolean,
  cleanup: Schema.Struct({
    status: Schema.Literal('completed', 'preserved'),
    residualPath: nullableStringSchema,
    warning: nullableStringSchema,
    commands: Schema.mutable(Schema.Array(cleanupCommandProgressSchema))
  })
})

const externalRemoveResultSchema = Schema.Struct({
  removed: Schema.Literal(true),
  external: Schema.Literal(true),
  worktreeId: Schema.String,
  path: Schema.String,
  head: Schema.String,
  branch: nullableStringSchema,
  cleanup: Schema.Struct({
    status: Schema.Literal('skipped'),
    skippedReason: Schema.String
  })
})

const operationRecordSchema = Schema.Union(
  Schema.Struct({
    ...operationBaseFields,
    kind: Schema.Literal('create'),
    request: createOperationRequestSchema,
    result: Schema.NullOr(createOperationResultSchema)
  }),
  Schema.Struct({
    ...operationBaseFields,
    kind: Schema.Literal('remove'),
    request: removeOperationRequestSchema,
    result: Schema.NullOr(removeOperationResultSchema)
  }),
  Schema.Struct({
    ...operationBaseFields,
    kind: Schema.Literal('external_remove'),
    request: Schema.Struct({ source: Schema.Literal('git') }),
    result: Schema.NullOr(externalRemoveResultSchema)
  }),
  Schema.Struct({
    ...operationBaseFields,
    kind: Schema.Literal('finish', 'discard', 'project_cleanup'),
    request: jsonObjectSchema,
    result: Schema.NullOr(jsonObjectSchema)
  })
)

export const operationResponseSchema = Schema.Struct({
  operation: operationRecordSchema
})

export const operationsResponseSchema = Schema.Struct({
  operations: Schema.Array(operationRecordSchema)
})

export const removePreviewResponseSchema = Schema.Struct({
  preview: removePreviewSchema
})
