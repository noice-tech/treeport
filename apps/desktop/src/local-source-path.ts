import path from 'node:path'
import { z } from 'zod'
import { isLoopbackUrl } from './renderer-url'

const MAX_LOCAL_FILE_PATH_LENGTH = 16_384

export const localSourcePathSchema = z
  .string()
  .max(MAX_LOCAL_FILE_PATH_LENGTH)
  .refine((filePath) => path.isAbsolute(filePath))
  .refine((filePath) =>
    Array.from(filePath).every((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint > 31 && codePoint !== 127
    })
  )

export function resolveLocalSourcePath(
  origin: string | null,
  filePath: string
): string | null {
  if (!origin || !URL.canParse(origin) || !isLoopbackUrl(new URL(origin))) {
    return null
  }

  return filePath
}
