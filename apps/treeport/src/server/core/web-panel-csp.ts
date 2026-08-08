export interface WebPanelRequestOrigin {
  referrer: string | null | undefined
  forwardedHost: string | null | undefined
  host: string | null | undefined
  forwardedProtocol: string | null | undefined
  requestProtocol: string
}

function validProtocol(
  value: string | null | undefined
): 'http:' | 'https:' | null {
  const protocol = value?.trim().toLowerCase().replace(/:?$/u, ':')
  return protocol === 'http:' || protocol === 'https:' ? protocol : null
}

function originForHost(
  protocol: 'http:' | 'https:',
  host: string | null | undefined
): URL | null {
  if (!host || host.includes(',')) {
    return null
  }

  const trimmed = host.trim()
  const value = `${protocol}//${trimmed}`
  if (!URL.canParse(value)) {
    return null
  }

  const origin = new URL(value)
  return origin.username === '' &&
    origin.password === '' &&
    origin.pathname === '/' &&
    origin.search === '' &&
    origin.hash === ''
    ? origin
    : null
}

export function webPanelBrowserOrigin(input: WebPanelRequestOrigin): string {
  const protocol =
    validProtocol(input.forwardedProtocol) ??
    validProtocol(input.requestProtocol) ??
    'http:'
  const requestOrigin =
    originForHost(protocol, input.forwardedHost) ??
    originForHost(protocol, input.host) ??
    new URL(`${protocol}//localhost`)

  if (input.referrer && URL.canParse(input.referrer)) {
    const referrer = new URL(input.referrer)
    if (
      validProtocol(referrer.protocol) &&
      referrer.host.toLowerCase() === requestOrigin.host.toLowerCase()
    ) {
      return referrer.origin
    }
  }

  return requestOrigin.origin
}

export function webPanelContentSecurityPolicy(
  policy: 'development' | 'immutable' | 'error',
  browserOrigin: string
): string {
  if (policy === 'development') {
    return `default-src 'self' ${browserOrigin}; script-src 'self' ${browserOrigin} 'unsafe-inline'; style-src 'self' ${browserOrigin} 'unsafe-inline'; img-src 'self' ${browserOrigin} data: blob:; connect-src 'self' ${browserOrigin} ws: wss:; frame-ancestors 'self' ${browserOrigin}`
  }

  if (policy === 'immutable') {
    return `default-src 'self' ${browserOrigin}; script-src 'self' ${browserOrigin}; style-src 'self' ${browserOrigin} 'unsafe-inline'; img-src 'self' ${browserOrigin} data:; connect-src 'none'; frame-ancestors 'self' ${browserOrigin}`
  }

  return `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' ${browserOrigin}`
}
