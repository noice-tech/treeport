import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_FILE_URL_LENGTH = 16_384

export function filePathFromUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > MAX_FILE_URL_LENGTH ||
    !value.startsWith('file:///') ||
    !URL.canParse(value)
  ) {
    return null
  }

  const url = new URL(value)
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
}
