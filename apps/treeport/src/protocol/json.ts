import * as Schema from 'effect/Schema'

export type NetworkJsonValue =
  | string
  | number
  | boolean
  | null
  | NetworkJsonValue[]
  | { readonly [key: string]: NetworkJsonValue }

export const jsonValueSchema: Schema.Schema<NetworkJsonValue> = Schema.suspend(
  () =>
    Schema.Union(
      Schema.Null,
      Schema.String,
      Schema.Number,
      Schema.Boolean,
      Schema.mutable(Schema.Array(jsonValueSchema)),
      Schema.Record({ key: Schema.String, value: jsonValueSchema })
    )
)
