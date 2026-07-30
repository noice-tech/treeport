const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())
}

export function parseComputerUrl(value: string): URL {
  const input = value.trim()
  if (!URL.canParse(input)) {
    throw new Error('Enter a valid HTTP or HTTPS URL.')
  }

  const url = new URL(input)
  if (url.username || url.password) {
    throw new Error('Computer URLs cannot include a username or password.')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Computer URLs must use HTTP or HTTPS.')
  }

  if (url.protocol === 'http:' && !isLoopbackUrl(url)) {
    throw new Error('Remote computers must use HTTPS.')
  }

  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url
}

/** @deprecated Use parseComputerUrl. */
export function parseRendererUrl(value: string): URL {
  return parseComputerUrl(value)
}
