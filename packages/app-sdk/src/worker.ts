export type TreeBadgeTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'done'

/** A compact status published for a tree by a script, hook, or package. */
export interface TreeBadge {
  key: string
  text: string
  tone: TreeBadgeTone
  url: string | null
  tooltip: string | null
  /** ID of the package that owns this badge, or null when set directly. */
  source: string | null
  /** ISO 8601 timestamp. */
  updatedAt: string
}

export interface TreeBadgeInput {
  /** At most 32 characters. */
  text: string
  /** Defaults to neutral. */
  tone?: TreeBadgeTone
  /** An http or https link, opened from the tree's context menu. */
  url?: string | null
  tooltip?: string | null
}

/** The tree fields available to package workers. */
export interface WorkerTree {
  id: string
  name: string
  branch: string | null
  badges: TreeBadge[]
}

/** The project fields available to package workers. */
export interface WorkerProject {
  id: string
  name: string
  kind: 'repository' | 'folder'
  rootPath: string
  defaultBranch: string
  /** Fetch URL of the repository's origin remote, when it has one. */
  originUrl: string | null
  availability: {
    state: 'available' | 'unavailable'
    message: string | null
  }
  worktrees: WorkerTree[]
}

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

/** The Treeport API available to a package worker. */
export interface PackageWorker {
  /** The package this worker acts for; it owns the badges the worker sets. */
  readonly packageId: string
  /** Projects this worker's package is configured for, with their trees. */
  projects(): Promise<WorkerProject[]>
  readonly badges: {
    /** Set or replace this package's badge. Unchanged values cost nothing. */
    set(treeId: string, key: string, badge: TreeBadgeInput): Promise<void>
    /** Remove a badge this package owns; removing a missing badge is a no-op. */
    clear(treeId: string, key: string): Promise<void>
  }
}

interface WorkerSelf {
  packageId: string
  projectIds: string[] | null
}

/**
 * Connect a package worker to the Treeport instance that started it. Pass
 * `process.env`; Treeport provides `TREEPORT_API_URL` and
 * `TREEPORT_PACKAGE_TOKEN` to each worker it runs.
 */
export async function connectPackageWorker(
  env: Record<string, string | undefined>
): Promise<PackageWorker> {
  const apiUrl = env.TREEPORT_API_URL
  const token = env.TREEPORT_PACKAGE_TOKEN
  if (!apiUrl || !token) {
    throw new Error(
      'TREEPORT_API_URL and TREEPORT_PACKAGE_TOKEN are missing; Treeport provides them to the workers it runs'
    )
  }

  const request = async <Result>(
    method: 'GET' | 'PUT' | 'DELETE',
    pathname: string,
    badge?: TreeBadgeInput
  ): Promise<Result> => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      }
    }
    if (badge) {
      init.body = JSON.stringify(badge)
    }

    const response = await fetch(new URL(pathname, apiUrl), init)
    // SAFETY: Treeport answers API requests with JSON bodies.
    const value = (await response.json()) as
      | Result
      | { error?: { code?: string; message?: string } }
    if (!response.ok) {
      // SAFETY: Failed Treeport responses use the { error } envelope.
      const error = (value as { error?: { code?: string; message?: string } })
        .error
      throw new TreeportRequestError(
        response.status,
        error?.code ?? null,
        error?.message ?? `${method} ${pathname} failed (${response.status})`
      )
    }

    // SAFETY: Successful responses follow the documented route contract.
    return value as Result
  }
  const badgePath = (treeId: string, key: string) =>
    `/api/worktrees/${encodeURIComponent(treeId)}/badges/${encodeURIComponent(key)}`
  const { packageId } = await request<WorkerSelf>(
    'GET',
    '/api/package-workers/self'
  )

  return {
    packageId,
    projects: async () => {
      // Scope can change while the worker runs, so read it with the projects.
      const [self, { projects }] = await Promise.all([
        request<WorkerSelf>('GET', '/api/package-workers/self'),
        request<{ projects: WorkerProject[] }>('GET', '/api/projects')
      ])
      return projects.filter(
        (project) => !self.projectIds || self.projectIds.includes(project.id)
      )
    },
    badges: {
      set: async (treeId, key, badge) => {
        await request('PUT', badgePath(treeId, key), badge)
      },
      clear: async (treeId, key) => {
        await request('DELETE', badgePath(treeId, key))
      }
    }
  }
}
