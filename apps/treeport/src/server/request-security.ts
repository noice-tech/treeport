import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_HOST_BYTES = 512
const MAX_LOGIN_BYTES = 320
const MAX_NAME_BYTES = 512
const MAX_PROFILE_PICTURE_BYTES = 2_048
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface RequestPrincipal {
  source: 'local' | 'tailscale'
  login: string | null
  name: string | null
  profilePicture: string | null
}

export interface RequestSecurityDecision {
  allowed: boolean
  principal: RequestPrincipal | null
  effectiveOrigin: string | null
  status: 200 | 400 | 401 | 403
  code: string | null
  message: string | null
}

function denied(
  status: 400 | 401 | 403,
  code: string,
  message: string
): RequestSecurityDecision {
  return {
    allowed: false,
    principal: null,
    effectiveOrigin: null,
    status,
    code,
    message
  }
}

function headerValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? '')
    }
  }

  if (values.length > 0) {
    return values
  }

  const value = request.headers[name]
  if (value === undefined) {
    return []
  }

  return Array.isArray(value) ? value : [value]
}

function singleHeader(
  request: IncomingMessage,
  name: string
): { present: boolean; valid: boolean; value: string | null } {
  const values = headerValues(request, name)
  return {
    present: values.length > 0,
    valid: values.length <= 1,
    value: values.length === 1 ? values[0]! : null
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 31 || code === 127
  })
}

function parseHost(value: string): { host: string; hostname: string } | null {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_HOST_BYTES ||
    hasControlCharacters(value) ||
    /[\s,/@?#\\]/u.test(value)
  ) {
    return null
  }

  const candidate = `http://${value}`
  if (!URL.canParse(candidate)) {
    return null
  }

  const url = new URL(candidate)
  if (!url.host || url.pathname !== '/') {
    return null
  }

  return { host: url.host, hostname: url.hostname.toLowerCase() }
}

function isLoopbackHostname(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false
  }

  const normalized = address.toLowerCase()
  if (normalized === '::1') {
    return true
  }

  const ipv4 = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized
  const octets = ipv4.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  )
}

function validIdentityValue(value: string, maximumBytes: number): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value) <= maximumBytes &&
    !hasControlCharacters(value)
  )
}

function effectiveOriginFor(
  request: IncomingMessage,
  source: RequestPrincipal['source'],
  incomingHost: { host: string; hostname: string }
): string | null {
  if (source === 'local') {
    return `http://${incomingHost.host}`
  }

  // Tailscale Serve overwrites these values from its inbound HTTPS request.
  const forwardedHostHeader = singleHeader(request, 'x-forwarded-host')
  const forwardedProtocolHeader = singleHeader(request, 'x-forwarded-proto')
  if (
    !forwardedHostHeader.valid ||
    !forwardedHostHeader.present ||
    !forwardedProtocolHeader.valid ||
    !forwardedProtocolHeader.present
  ) {
    return null
  }

  const forwardedHost = parseHost(forwardedHostHeader.value ?? '')
  if (
    !forwardedHost ||
    forwardedProtocolHeader.value?.toLowerCase() !== 'https'
  ) {
    return null
  }

  return `https://${forwardedHost.host}`
}

function originIsAllowed(
  request: IncomingMessage,
  effectiveOrigin: string,
  socketUpgrade: boolean
): boolean {
  const originHeader = singleHeader(request, 'origin')
  if (!originHeader.valid) {
    return false
  }

  if (originHeader.present) {
    const value = originHeader.value ?? ''
    if (value === 'null' || !URL.canParse(value)) {
      return false
    }

    const parsed = new URL(value)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.origin !== value ||
      parsed.origin !== effectiveOrigin
    ) {
      return false
    }
  }

  const fetchSiteHeader = singleHeader(request, 'sec-fetch-site')
  if (!fetchSiteHeader.valid) {
    return false
  }

  const unsafeMethod = UNSAFE_METHODS.has(request.method?.toUpperCase() ?? '')
  if (
    (unsafeMethod || socketUpgrade) &&
    fetchSiteHeader.value?.toLowerCase() === 'cross-site'
  ) {
    return false
  }

  return true
}

export function authorizeRequest(
  request: IncomingMessage,
  options: { socketUpgrade?: boolean } = {}
): RequestSecurityDecision {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    return denied(
      401,
      'AUTHENTICATION_REQUIRED',
      'Treeport accepts remote requests only through Tailscale Serve.'
    )
  }

  const hostHeader = singleHeader(request, 'host')
  const incomingHost =
    hostHeader.valid && hostHeader.value
      ? parseHost(hostHeader.value.toLowerCase())
      : null
  if (!incomingHost) {
    return denied(400, 'INVALID_REQUEST_HOST', 'The request host is invalid.')
  }

  const loginHeader = singleHeader(request, 'tailscale-user-login')
  const nameHeader = singleHeader(request, 'tailscale-user-name')
  const profilePictureHeader = singleHeader(
    request,
    'tailscale-user-profile-pic'
  )
  const hasTailscaleIdentity =
    loginHeader.present || nameHeader.present || profilePictureHeader.present
  const headersHaveSingleValues =
    loginHeader.valid && nameHeader.valid && profilePictureHeader.valid

  let principal: RequestPrincipal
  if (hasTailscaleIdentity) {
    const login = loginHeader.value ?? ''
    const name = nameHeader.value === '' ? null : nameHeader.value
    const profilePicture =
      profilePictureHeader.value === '' ? null : profilePictureHeader.value
    const validProfilePicture =
      profilePicture === null ||
      (validIdentityValue(profilePicture, MAX_PROFILE_PICTURE_BYTES) &&
        URL.canParse(profilePicture) &&
        ['http:', 'https:'].includes(new URL(profilePicture).protocol))
    if (
      !headersHaveSingleValues ||
      !loginHeader.present ||
      !validIdentityValue(login, MAX_LOGIN_BYTES) ||
      (name !== null && !validIdentityValue(name, MAX_NAME_BYTES)) ||
      !validProfilePicture
    ) {
      return denied(
        401,
        'INVALID_TAILSCALE_IDENTITY',
        'The Tailscale user identity is invalid.'
      )
    }

    principal = {
      source: 'tailscale',
      login,
      name,
      profilePicture
    }
  } else {
    if (!isLoopbackHostname(incomingHost.hostname)) {
      return denied(
        401,
        'AUTHENTICATION_REQUIRED',
        'Treeport accepts remote requests only through Tailscale Serve.'
      )
    }

    principal = {
      source: 'local',
      login: null,
      name: null,
      profilePicture: null
    }
  }

  const effectiveOrigin = effectiveOriginFor(
    request,
    principal.source,
    incomingHost
  )
  if (!effectiveOrigin) {
    return denied(
      400,
      'INVALID_FORWARDED_ORIGIN',
      'The forwarded request origin is invalid.'
    )
  }

  if (
    !originIsAllowed(request, effectiveOrigin, options.socketUpgrade === true)
  ) {
    return denied(403, 'INVALID_ORIGIN', 'The request origin is not allowed.')
  }

  return {
    allowed: true,
    principal,
    effectiveOrigin,
    status: 200,
    code: null,
    message: null
  }
}

export function rejectHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  decision: RequestSecurityDecision
): void {
  const apiRequest = request.url?.startsWith('/api/') === true
  const body = apiRequest
    ? `${JSON.stringify({
        error: { code: decision.code, message: decision.message }
      })}\n`
    : `${decision.message ?? 'The request was rejected.'}\n`

  response.statusCode = decision.status
  response.setHeader('cache-control', 'no-store')
  response.setHeader(
    'content-type',
    apiRequest ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'
  )
  response.end(request.method === 'HEAD' ? undefined : body)
}
