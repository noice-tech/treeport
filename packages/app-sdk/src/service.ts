import type {
  PackageServiceIdentity,
  TreeDecorationInput,
  TreeportProject,
  TreeportServiceSdk
} from './index.js'

// This entry runs in a package service's Node process, not a browser.
declare const process: { env: Record<string, string | undefined> }

export class TreeportRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string
  ) {
    super(message)
    this.name = 'TreeportRequestError'
  }
}

async function request<Result>(
  method: 'GET' | 'PUT' | 'DELETE',
  pathname: string,
  decoration?: TreeDecorationInput
): Promise<Result> {
  // Treeport passes these to every service it starts.
  const apiUrl = process.env.TREEPORT_API_URL
  const token = process.env.TREEPORT_PACKAGE_TOKEN
  if (!apiUrl || !token) {
    throw new Error(
      'TREEPORT_API_URL and TREEPORT_PACKAGE_TOKEN are missing; run this as a Treeport package service'
    )
  }

  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    }
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

/** The Treeport API available to this package service. */
export const treeport: TreeportServiceSdk = Object.freeze({
  version: 1,
  self: () =>
    request<PackageServiceIdentity>('GET', '/api/package-services/self'),
  projects: async () => {
    // Scope can change while the service runs, so read it with the projects.
    const [self, { projects }] = await Promise.all([
      request<PackageServiceIdentity>('GET', '/api/package-services/self'),
      request<{ projects: TreeportProject[] }>('GET', '/api/projects')
    ])
    return projects.filter(
      (project) => !self.projectIds || self.projectIds.includes(project.id)
    )
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
