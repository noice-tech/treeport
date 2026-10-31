import type {
  PackageServiceIdentity,
  TreeDecorationInput,
  TreeportEvent,
  TreeportProject,
  TreeportServiceSdk
} from './index.ts'

declare const process: { env: Record<string, string | undefined> }

export class TreeportRequestError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, code: string | null, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = 'TreeportRequestError'
  }
}

function connection() {
  const apiUrl = process.env.TREEPORT_API_URL
  const token = process.env.TREEPORT_PACKAGE_TOKEN

  if (!apiUrl || !token) {
    throw new Error(
      'TREEPORT_API_URL and TREEPORT_PACKAGE_TOKEN are missing; run this as a Treeport package service'
    )
  }

  return { apiUrl, authorization: `Bearer ${token}` }
}

async function request<Result>(
  method: 'GET' | 'PUT' | 'DELETE',
  pathname: string,
  decoration?: TreeDecorationInput
): Promise<Result> {
  const { apiUrl, authorization } = connection()

  const init: RequestInit = {
    method,
    headers: { authorization, 'content-type': 'application/json' }
  }

  if (decoration) {
    init.body = JSON.stringify(decoration)
  }

  const response = await fetch(new URL(pathname, apiUrl), init)

  if (!response.ok) {
    // SAFETY: Failed Treeport responses use the { error: { code, message } } envelope.
    const { error } = (await response.json()) as {
      error?: { code?: string; message?: string }
    }

    throw new TreeportRequestError(
      response.status,
      error?.code ?? null,
      error?.message ?? `${method} ${pathname} failed (${response.status})`
    )
  }

  // SAFETY: Successful responses follow the route contracts these types mirror.
  return (await response.json()) as Result
}

const decorationPath = (treeId: string, key: string) =>
  `/api/worktrees/${encodeURIComponent(treeId)}/decorations/${encodeURIComponent(key)}`

export const treeport: TreeportServiceSdk = Object.freeze({
  version: 1,
  self: () =>
    request<PackageServiceIdentity>('GET', '/api/package-services/self'),
  projects: async () =>
    (
      await request<{ projects: TreeportProject[] }>(
        'GET',
        '/api/package-services/projects'
      )
    ).projects,
  events: async function* () {
    const { apiUrl, authorization } = connection()
    let retryMs = 1_000

    while (true) {
      const response = await fetch(
        new URL('/api/package-services/events', apiUrl),
        { headers: { authorization, accept: 'text/event-stream' } }
      ).catch(() => null)

      if (response?.status === 401) {
        throw new TreeportRequestError(
          401,
          'INVALID_PACKAGE_TOKEN',
          'The package token is invalid or its package was removed'
        )
      }

      if (response?.ok && response.body) {
        retryMs = 1_000

        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader()

        let buffer = ''

        while (true) {
          const chunk = await reader
            .read()
            .catch(() => ({ done: true, value: undefined }) as const)

          if (chunk.done) {
            break
          }

          const messages = (buffer + chunk.value).split('\n\n')
          buffer = messages.pop()!

          for (const message of messages) {
            if (message.startsWith('data: ')) {
              // SAFETY: Treeport sends one TreeportEvent per server-sent event.
              yield JSON.parse(message.slice(6)) as TreeportEvent
            }
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, retryMs))
      retryMs = Math.min(retryMs * 2, 30_000)
    }
  },
  decorations: Object.freeze({
    set: async (
      treeId: string,
      key: string,
      decoration: TreeDecorationInput
    ) => {
      await request('PUT', decorationPath(treeId, key), decoration)
    },
    clear: async (treeId: string, key: string) => {
      await request('DELETE', decorationPath(treeId, key))
    }
  })
})
