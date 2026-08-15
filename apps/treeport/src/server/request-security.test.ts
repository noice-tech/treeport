import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizeRequest, rejectHttpRequest } from './request-security'

interface ResponseRecord {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

const servers: Server[] = []

async function request(
  url: string,
  options: {
    method?: string
    path?: string
    headers?: Record<string, string | string[]>
  } = {}
): Promise<ResponseRecord> {
  const target = new URL(options.path ?? '/', url)
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      target,
      {
        method: options.method,
        headers: options.headers,
        joinDuplicateHeaders: false
      },
      (response) => {
        response.setEncoding('utf8')
        let body = ''
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body
          })
        )
      }
    )
    outgoing.once('error', reject)
    outgoing.end()
  })
}

async function fixture(): Promise<{
  url: string
  mutations: { count: number }
}> {
  const mutations = { count: 0 }
  const server = http.createServer((incoming, response) => {
    const security = authorizeRequest(incoming)
    if (!security.allowed) {
      rejectHttpRequest(incoming, response, security)
      return
    }

    if (incoming.method === 'POST') {
      mutations.count += 1
    }

    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        source: security.principal?.source,
        login: security.principal?.login
      })
    )
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, mutations }
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  )
})

describe('request security over a real HTTP server', () => {
  it('never trusts identity or forwarding headers from a non-loopback peer', () => {
    const request = {
      method: 'GET',
      headers: {
        host: 'treeport.tailnet.ts.net',
        'tailscale-user-login': 'developer@example.test',
        'x-forwarded-host': 'treeport.tailnet.ts.net',
        'x-forwarded-proto': 'https'
      },
      rawHeaders: [
        'Host',
        'treeport.tailnet.ts.net',
        'Tailscale-User-Login',
        'developer@example.test',
        'X-Forwarded-Host',
        'treeport.tailnet.ts.net',
        'X-Forwarded-Proto',
        'https'
      ],
      socket: { remoteAddress: '192.168.1.10' }
    } as unknown as IncomingMessage

    expect(authorizeRequest(request)).toMatchObject({
      allowed: false,
      status: 401,
      code: 'AUTHENTICATION_REQUIRED'
    })
  })

  it('accepts local and Tailscale ingress while rejecting bypasses and foreign browser mutations', async () => {
    const value = await fixture()

    const local = await request(value.url, { path: '/api/local' })
    expect(local.status).toBe(200)
    expect(JSON.parse(local.body)).toEqual({ source: 'local', login: null })

    const tailscaleHeaders = {
      Host: 'treeport.tailnet.ts.net',
      Origin: 'https://treeport.tailnet.ts.net',
      'Tailscale-User-Login': 'developer@example.test',
      'Tailscale-User-Name': 'Treeport Developer',
      'Tailscale-User-Profile-Pic': 'https://example.test/profile.png',
      'X-Forwarded-Host': 'treeport.tailnet.ts.net',
      'X-Forwarded-Proto': 'https'
    }
    const tailscale = await request(value.url, {
      path: '/api/remote',
      headers: tailscaleHeaders
    })
    expect(tailscale.status).toBe(200)
    expect(JSON.parse(tailscale.body)).toEqual({
      source: 'tailscale',
      login: 'developer@example.test'
    })

    const identityWithoutProfile = await request(value.url, {
      path: '/api/remote',
      headers: {
        ...tailscaleHeaders,
        'Tailscale-User-Name': '',
        'Tailscale-User-Profile-Pic': ''
      }
    })
    expect(identityWithoutProfile.status).toBe(200)

    const bypass = await request(value.url, {
      path: '/api/projects',
      headers: { Host: 'treeport.tailnet.ts.net' }
    })
    expect(bypass.status).toBe(401)
    expect(bypass.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(bypass.body)).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message:
          'Treeport accepts remote requests only through Tailscale Serve.'
      }
    })

    const assetBypass = await request(value.url, {
      path: '/assets/application.js',
      headers: { Host: 'treeport.tailnet.ts.net' }
    })
    expect(assetBypass.status).toBe(401)
    expect(assetBypass.body).not.toContain('treeport.tailnet.ts.net')

    const partialIdentity = await request(value.url, {
      path: '/api/projects',
      headers: {
        Host: 'treeport.tailnet.ts.net',
        'Tailscale-User-Name': 'Unverified User'
      }
    })
    expect(partialIdentity.status).toBe(401)
    expect(JSON.parse(partialIdentity.body).error.code).toBe(
      'INVALID_TAILSCALE_IDENTITY'
    )

    const oversizedLogin = `private-${'x'.repeat(321)}`
    const malformedIdentity = await request(value.url, {
      path: '/api/projects',
      headers: {
        ...tailscaleHeaders,
        'Tailscale-User-Login': oversizedLogin
      }
    })
    expect(malformedIdentity.status).toBe(401)
    expect(malformedIdentity.body).not.toContain(oversizedLogin)

    const duplicateIdentity = await request(value.url, {
      path: '/api/projects',
      headers: {
        ...tailscaleHeaders,
        'Tailscale-User-Login': ['developer@example.test', 'other@example.test']
      }
    })
    expect(duplicateIdentity.status).toBe(401)

    const insecureForwardedOrigin = await request(value.url, {
      path: '/api/projects',
      headers: { ...tailscaleHeaders, 'X-Forwarded-Proto': 'http' }
    })
    expect(insecureForwardedOrigin.status).toBe(400)
    expect(JSON.parse(insecureForwardedOrigin.body).error.code).toBe(
      'INVALID_FORWARDED_ORIGIN'
    )

    const missingForwardedOrigin = await request(value.url, {
      path: '/api/projects',
      headers: Object.fromEntries(
        Object.entries(tailscaleHeaders).filter(
          ([name]) => name !== 'X-Forwarded-Proto'
        )
      )
    })
    expect(missingForwardedOrigin.status).toBe(400)

    const foreignMutation = await request(value.url, {
      method: 'POST',
      path: '/api/projects',
      headers: {
        ...tailscaleHeaders,
        Origin: 'https://evil.example'
      }
    })
    expect(foreignMutation.status).toBe(403)
    expect(JSON.parse(foreignMutation.body).error.code).toBe('INVALID_ORIGIN')
    expect(value.mutations.count).toBe(0)

    const crossSiteMutation = await request(value.url, {
      method: 'POST',
      path: '/api/projects',
      headers: {
        ...Object.fromEntries(
          Object.entries(tailscaleHeaders).filter(([name]) => name !== 'Origin')
        ),
        'Sec-Fetch-Site': 'cross-site'
      }
    })
    expect(crossSiteMutation.status).toBe(403)
    expect(value.mutations.count).toBe(0)

    const originlessMutation = await request(value.url, {
      method: 'POST',
      path: '/api/projects',
      headers: Object.fromEntries(
        Object.entries(tailscaleHeaders).filter(([name]) => name !== 'Origin')
      )
    })
    expect(originlessMutation.status).toBe(200)
    expect(value.mutations.count).toBe(1)
  })
})
