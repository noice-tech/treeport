import fs from 'node:fs/promises'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'

export type OptionalJsoncResult =
  | { found: false }
  | { found: true; value: unknown }

export class JsoncError extends Data.TaggedError('JsoncError')<{
  readonly filePath: string
  readonly operation: 'read' | 'parse'
  readonly cause: unknown
  readonly message: string
}> {
  constructor(
    filePath: string,
    operation: JsoncError['operation'],
    cause: unknown,
    message = cause instanceof Error ? cause.message : String(cause)
  ) {
    super({ filePath, operation, cause, message })
  }
}

export function readOptionalJsonc(
  filePath: string
): Effect.Effect<OptionalJsoncResult, JsoncError> {
  return Effect.tryPromise({
    try: () => fs.readFile(filePath, 'utf8'),
    catch: (cause) => new JsoncError(filePath, 'read', cause)
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        error.cause instanceof Error &&
        'code' in error.cause &&
        error.cause.code === 'ENOENT'
          ? Effect.succeed({ found: false as const })
          : Effect.fail(error),
      onSuccess: (source) =>
        Effect.try({
          try: (): OptionalJsoncResult => {
            const errors: ParseError[] = []
            const value = parse(source, errors, {
              allowTrailingComma: true,
              disallowComments: false
            })
            if (errors.length) {
              const first = errors[0]!
              throw new Error(
                `Invalid JSONC in ${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`
              )
            }

            return { found: true, value }
          },
          catch: (cause) => new JsoncError(filePath, 'parse', cause)
        })
    })
  )
}
