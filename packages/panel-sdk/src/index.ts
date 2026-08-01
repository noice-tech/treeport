/** A persistent web panel instance scoped to one worktree. */
export interface WebPanel {
  id: string
  kind: 'web'
  worktreeId: string
  extensionId: string
  contributionId: string
  title: string
  /** ISO 8601 timestamp. */
  createdAt: string
  /** ISO 8601 timestamp. */
  updatedAt: string
}

/** Project and worktree information available to the current panel. */
export interface WebPanelContext {
  apiVersion: 1
  panel: WebPanel
  project: {
    id: string
    name: string
    defaultBranch: string
  }
  worktree: {
    id: string
    name: string
    branch: string | null
    head: string
  }
}

/**
 * A read-only diff from the default-branch merge base through the worktree's
 * committed, tracked local, and untracked changes.
 */
export interface GitDiff {
  baseRef: string
  baseCommit: string
  headCommit: string
  /** ISO 8601 timestamp. */
  generatedAt: string
  /** Unified diff text. */
  unified: string
}

/** The worktree-scoped, read-only API available to a Treeport web panel. */
export interface TreeportPanelSdk {
  readonly version: 1
  /** Return the identity and Git context for the current panel. */
  context(): Promise<WebPanelContext>
  /** Return the current worktree changes as unified diff text. */
  diff(): Promise<GitDiff>
}

interface HostResponse {
  source: 'treeport-host-v1'
  id: string
  ok: boolean
  value?: unknown
  error?: string
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(reason: Error): void
}

const pending = new Map<string, PendingRequest>()
let serial = 0

addEventListener('message', (event: MessageEvent<HostResponse>) => {
  const message = event.data
  if (event.source !== parent || message?.source !== 'treeport-host-v1') {
    return
  }

  const request = pending.get(message.id)
  if (!request) {
    return
  }

  pending.delete(message.id)
  if (message.ok) {
    request.resolve(message.value)
  } else {
    request.reject(new Error(message.error || 'Treeport request failed'))
  }
})

function call<Result>(method: 'context' | 'diff'): Promise<Result> {
  return new Promise((resolve, reject) => {
    const id = String(++serial)
    pending.set(id, {
      resolve: (value) => resolve(value as Result),
      reject
    })
    parent.postMessage({ source: 'treeport-panel-v1', id, method }, '*')
  })
}

/** The worktree-scoped, read-only API available to this web panel. */
export const treeport: TreeportPanelSdk = Object.freeze({
  version: 1,
  context: () => call<WebPanelContext>('context'),
  diff: () => call<GitDiff>('diff')
})
