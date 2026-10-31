import * as Schema from 'effect/Schema'
import { browserAppSchema } from './browser.ts'
import { webAppSchema } from './web-app.ts'

export const reorderWorkspaceItemsSchema = Schema.Struct({
  itemIds: Schema.Array(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
  ).pipe(
    Schema.minItems(1),
    Schema.filter((itemIds) => new Set(itemIds).size === itemIds.length, {
      message: () => 'Item order cannot contain duplicates'
    })
  )
})

export const requestWorkspaceOpenSchema = Schema.Struct({
  sourceTerminalId: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128)
  )
})

export const deleteAppQuerySchema = Schema.Struct({
  discardStoredData: Schema.optional(Schema.String),
  force: Schema.optional(Schema.String)
})

const terminalWorkspaceItemSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal('terminal'),
  worktreeId: Schema.String,
  terminalId: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String
})

export const workspaceItemSchema = Schema.Union(
  terminalWorkspaceItemSchema,
  webAppSchema,
  browserAppSchema
)

export const workspaceActivityResponseSchema = Schema.Struct({
  working: Schema.Int.pipe(Schema.nonNegative()),
  needsAttention: Schema.Int.pipe(Schema.nonNegative())
})
