import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

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

async function rendererFiles(
  directory: string,
  relativeDirectory = ''
): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const entries = await readdir(path.join(directory, relativeDirectory), {
    withFileTypes: true
  }).catch(() => [])
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
      for (const [urlPath, filePath] of await rendererFiles(
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

export async function createRendererRequestHandler(
  options: RendererRequestHandlerOptions
): Promise<(request: Request) => Promise<Response>> {
  const files = options.developmentServerUrl
    ? new Map<string, string>()
    : await rendererFiles(options.rendererDirectory)
  const indexPath = files.get('/index.html') ?? null

  const localFileResponse = async (filePath: string) => {
    const content = await readFile(filePath)
    return new Response(new Uint8Array(content), {
      headers: {
        'content-type':
          contentTypes.get(path.extname(filePath).toLowerCase()) ??
          'application/octet-stream',
        'cache-control': 'no-store'
      }
    })
  }

  return async (request) => {
    const url = new URL(request.url)
    const backendOrigin = options.selectedBackendOrigin()
    const privateApplicationRequest = url.protocol === 'treeport-app:'
    const selectedBackendRequest =
      backendOrigin !== null && url.origin === backendOrigin
    if (!privateApplicationRequest && !selectedBackendRequest) {
      return options.forward(request)
    }

    const pathname = requestPath(url)
    if (!pathname) {
      return new Response('Not found', { status: 404 })
    }

    if (
      selectedBackendRequest &&
      (pathname === '/api' || pathname.startsWith('/api/'))
    ) {
      return options.forward(request)
    }

    if (options.developmentServerUrl) {
      const developmentUrl = new URL(
        isDocumentRequest(request) ? '/' : `${pathname}${url.search}`,
        options.developmentServerUrl
      )
      const requestInit: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers: request.headers
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        requestInit.body = request.body
        if (request.body) {
          requestInit.duplex = 'half'
        }
      }

      return options.forward(new Request(developmentUrl, requestInit))
    } else {
      const filePath = files.get(pathname)
      if ((request.method === 'GET' || request.method === 'HEAD') && filePath) {
        return localFileResponse(filePath)
      }

      if (isDocumentRequest(request) && indexPath) {
        return localFileResponse(indexPath)
      }
    }

    if (privateApplicationRequest) {
      return new Response('Not found', { status: 404 })
    }

    return options.forward(request)
  }
}
