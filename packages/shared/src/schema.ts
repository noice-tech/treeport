/* eslint-disable anti-slop/no-unknown-parameters -- These helpers decode untrusted values with their supplied Effect Schema. */
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'

export function decodeUnknownOrNull<S extends Schema.Schema<any, any, never>>(
  schema: S,
  value: unknown
): Schema.Schema.Type<S> | null {
  const result = Schema.decodeUnknownEither(schema, {
    onExcessProperty: 'error'
  })(value)
  return Either.isRight(result) ? result.right : null
}

export function isSchemaValue<S extends Schema.Schema<any, any, never>>(
  schema: S,
  value: unknown
): value is Schema.Schema.Type<S> {
  return Schema.is(schema, { onExcessProperty: 'error' })(value)
}
