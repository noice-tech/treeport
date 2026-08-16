import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const MAX_FILE_URL_LENGTH = 16_384

const filePathParser = z.unknown().transform((value): string | null => {
  const parsed = z.string().safeParse(value)
  if (
    !parsed.success ||
    parsed.data.length > MAX_FILE_URL_LENGTH ||
    !parsed.data.startsWith('file:///') ||
    !URL.canParse(parsed.data)
  ) {
    return null
  }

  const url = new URL(parsed.data)
  if (
    url.protocol !== 'file:' ||
    url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%(?:00|2f|5c)/i.test(url.pathname)
  ) {
    return null
  }

  try {
    const filePath = fileURLToPath(url)
    return path.isAbsolute(filePath) && !filePath.includes('\0')
      ? filePath
      : null
  } catch {
    return null
  }
})

export const filePathFromUrl = filePathParser.parse
