import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import type * as Cause from 'effect/Cause'

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2']
])

export interface RendererRequestHandlerOptions {
  rendererDirectory: string
  developmentServerUrl: string | null
  selectedBackendOrigin(): string | null
  forward(request: Request): Promise<Response>
}

function rendererFiles(
  directory: string,
  relativeDirectory = ''
): Effect.Effect<Map<string, string>, Cause.UnknownException> {
  return Effect.gen(function* () {
    const files = new Map<string, string>()
    const entries = yield* Effect.tryPromise(() =>
      readdir(path.join(directory, relativeDirectory), { withFileTypes: true })
    )
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        for (const [urlPath, filePath] of yield* rendererFiles(
          directory,
          relativePath
        )) {
          files.set(urlPath, filePath)
        }
      } else if (entry.isFile()) {
        files.set(`/${relativePath}`, path.join(directory, relativePath))
      }
    }
    return files
  })
}

function requestPath(url: URL): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (
    decoded.includes('\\') ||
    decoded.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    return null
  }

  const normalized = path.posix.normalize(decoded)
  return normalized.startsWith('/') ? normalized : null
}

function isDocumentRequest(request: Request): boolean {
  return (
    request.destination === 'document' ||
    request.headers.get('sec-fetch-dest') === 'document' ||
    (request.method === 'GET' &&
      request.headers.get('accept')?.includes('text/html') === true)
  )
}

export function createRendererRequestHandler(
  options: RendererRequestHandlerOptions
) {
  return Effect.gen(function* () {
    const files = options.developmentServerUrl
      ? new Map<string, string>()
      : yield* rendererFiles(options.rendererDirectory)
    const indexPath = files.get('/index.html') ?? null
    const forward = (request: Request) =>
      Effect.tryPromise((signal) =>
        options.forward(
          new Request(request, {
            signal: AbortSignal.any([request.signal, signal])
          })
        )
      )
    const localFileResponse = (filePath: string, head: boolean) =>
      Effect.gen(function* () {
        const content = yield* Effect.tryPromise((signal) =>
          readFile(filePath, { signal })
        )
        return new Response(head ? null : new Uint8Array(content), {
          headers: {
            'content-type':
              contentTypes.get(path.extname(filePath).toLowerCase()) ??
              'application/octet-stream',
            'cache-control': 'no-store'
          }
        })
      })
    return (request: Request) =>
      Effect.gen(function* () {
        const url = new URL(request.url)
        const backendOrigin = options.selectedBackendOrigin()
        const privateApplicationRequest = url.protocol === 'treeport-app:'
        const selectedBackendRequest =
          backendOrigin !== null && url.origin === backendOrigin
        if (!privateApplicationRequest && !selectedBackendRequest) {
          return yield* forward(request)
        }

        const pathname = requestPath(url)
        if (!pathname) {
          return new Response('Not found', { status: 404 })
        }

        if (
          selectedBackendRequest &&
          (pathname === '/api' || pathname.startsWith('/api/'))
        ) {
          return yield* forward(request)
        }

        if (options.developmentServerUrl) {
          const developmentUrl = new URL(
            isDocumentRequest(request) ? '/' : `${pathname}${url.search}`,
            options.developmentServerUrl
          )
          const requestInit: RequestInit & { duplex?: 'half' } = {
            method: request.method,
            headers: request.headers,
            signal: request.signal
          }
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            requestInit.body = request.body
            if (request.body) {
              requestInit.duplex = 'half'
            }
          }

          return yield* forward(new Request(developmentUrl, requestInit))
        }

        const filePath = files.get(pathname)
        if (
          (request.method === 'GET' || request.method === 'HEAD') &&
          filePath
        ) {
          return yield* localFileResponse(filePath, request.method === 'HEAD')
        }

        if (isDocumentRequest(request) && indexPath) {
          return yield* localFileResponse(indexPath, request.method === 'HEAD')
        }

        return privateApplicationRequest
          ? new Response('Not found', { status: 404 })
          : yield* forward(request)
      })
  })
}
