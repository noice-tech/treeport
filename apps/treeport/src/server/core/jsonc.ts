import fs from 'node:fs/promises'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'

export type OptionalJsoncResult =
  | { found: false }
  | { found: true; value: unknown }

export async function readOptionalJsonc(
  filePath: string
): Promise<OptionalJsoncResult> {
  let source: string
  try {
    source = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { found: false }
    }

    throw error
  }

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
}
