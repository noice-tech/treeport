import { browserUrlSchema, decodeUnknownOrNull } from '@treeport/shared'

export function browserPresentationOrigin(
  permission: string,
  requestingUrl: string | undefined,
  eligible: boolean
): string | null {
  if (
    !eligible ||
    (permission !== 'pointerLock' && permission !== 'fullscreen') ||
    !requestingUrl
  ) {
    return null
  }

  const parsed = decodeUnknownOrNull(browserUrlSchema, requestingUrl)
  if (parsed === null) {
    return null
  }

  const url = new URL(parsed)
  // File pages have an opaque origin; never grant permissions to "null".
  return url.protocol === 'http:' || url.protocol === 'https:'
    ? url.origin
    : null
}
