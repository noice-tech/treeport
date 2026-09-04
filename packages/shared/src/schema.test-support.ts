/* eslint-disable anti-slop/no-unknown-parameters -- Test adapters exercise Effect Schema against untrusted fixtures. */
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'

export function testSchema<A, I>(schema: Schema.Schema<A, I, never>) {
  return {
    parse(input: unknown): A {
      return Schema.decodeUnknownSync(schema, {
        onExcessProperty: 'error'
      })(input)
    },
    safeParse(input: unknown) {
      return {
        success: Either.isRight(
          Schema.decodeUnknownEither(schema, { onExcessProperty: 'error' })(
            input
          )
        )
      }
    }
  }
}
