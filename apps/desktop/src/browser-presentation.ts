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
  return parsed === null ? null : new URL(parsed).origin
}
