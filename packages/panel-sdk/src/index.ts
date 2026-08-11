export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Structured input stored with a web panel launch. */
export type WebPanelInput = Record<string, JsonValue>

/** Launch data for a persistent web panel instance. */
export interface WebPanelLaunch {
  input: WebPanelInput | null
  /** Directory relative to the worktree root. */
  cwd: string | null
}

/** A persistent web panel instance scoped to one worktree. */
export interface WebPanel {
  id: string
  kind: 'web'
  worktreeId: string
  definitionId: string
  title: string
  launch: WebPanelLaunch
  sandbox: {
    allowSameOrigin: boolean
  }
  /** ISO 8601 timestamp. */
  createdAt: string
  /** ISO 8601 timestamp. */
  updatedAt: string
}

/** Project and worktree information available to the current panel. */
export interface WebPanelContext {
  apiVersion: 1
  panel: WebPanel
  launch: WebPanelLaunch
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

/** Durable key-value storage scoped to one panel instance. */
export interface WebPanelStorage {
  /** Return a stored JSON value, or undefined when the key does not exist. */
  get<Value extends JsonValue = JsonValue>(
    key: string
  ): Promise<Value | undefined>
  /** Store a JSON value. Values are limited to 64 KiB. */
  set(key: string, value: JsonValue): Promise<void>
  /** Remove a stored value. */
  delete(key: string): Promise<void>
}

/** Client-local controls for the current panel. */
export interface WebPanelControls {
  /** Set a runtime title. Pass null to restore the configured title. */
  setTitle(title: string | null): void
}

/** Keyboard shortcuts Treeport can route to an active web panel. */
export interface WebPanelShortcuts {
  /** Run a handler when the user invokes Find with Cmd/Ctrl+F. */
  onFind(handler: () => void): () => void
}

/** The worktree-scoped API available to a Treeport web panel. */
export interface TreeportPanelSdk {
  readonly version: 1
  /** Client-local controls for the current panel. */
  readonly panel: WebPanelControls
  /** Return the identity and Git context for the current panel. */
  context(): Promise<WebPanelContext>
  /** Return the current worktree changes as unified diff text. */
  diff(): Promise<GitDiff>
  /** Durable storage deleted when this panel instance is closed. */
  readonly storage: WebPanelStorage
  /** Shortcuts delivered whether focus is in the panel or Treeport host. */
  readonly shortcuts: WebPanelShortcuts
}

interface HostResponse {
  source: 'treeport-host-v1'
  id: string
  ok: boolean
  value?: unknown
  error?: string
}

interface HostShortcut {
  source: 'treeport-host-v1'
  method: 'shortcut'
  shortcut: 'find'
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(reason: Error): void
}

const pending = new Map<string, PendingRequest>()
const shortcutEvents = new EventTarget()
let findSubscribers = 0
let serial = 0

function triggerFindShortcut() {
  shortcutEvents.dispatchEvent(new Event('find'))
}

if (parent !== self) {
  addEventListener(
    'keydown',
    (event) => {
      const find =
        event.key.toLowerCase() === 'f' &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      if (find && findSubscribers > 0) {
        event.preventDefault()
        event.stopPropagation()
        triggerFindShortcut()
        return
      }

      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) {
        return
      }

      const index = Number(event.key) - 1
      if (!Number.isInteger(index) || index < 0 || index > 8) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      parent.postMessage(
        { source: 'treeport-panel-v1', method: 'workspace.select', index },
        '*'
      )
    },
    true
  )
}

addEventListener(
  'message',
  (event: MessageEvent<HostResponse | HostShortcut>) => {
    const message = event.data
    if (event.source !== parent || message?.source !== 'treeport-host-v1') {
      return
    }

    if ('method' in message) {
      if (message.method === 'shortcut' && message.shortcut === 'find') {
        triggerFindShortcut()
      }

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
  }
)

function call<Result>(
  method: 'context' | 'diff' | 'storage.get' | 'storage.set' | 'storage.delete',
  params?: {
    key?: string
    value?: JsonValue
  }
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const id = String(++serial)
    pending.set(id, {
      resolve: (value) => resolve(value as Result),
      reject
    })
    parent.postMessage(
      { source: 'treeport-panel-v1', id, method, ...params },
      '*'
    )
  })
}

/** The worktree-scoped API available to this web panel. */
export const treeport: TreeportPanelSdk = Object.freeze({
  version: 1,
  panel: Object.freeze({
    setTitle: (title: string | null) => {
      if (parent === self) {
        return
      }

      parent.postMessage(
        { source: 'treeport-panel-v1', method: 'panel.title.set', title },
        '*'
      )
    }
  }),
  context: () => call<WebPanelContext>('context'),
  diff: () => call<GitDiff>('diff'),
  storage: Object.freeze({
    get: <Value extends JsonValue = JsonValue>(key: string) =>
      call<Value | undefined>('storage.get', { key }),
    set: (key: string, value: JsonValue) =>
      call<void>('storage.set', { key, value }),
    delete: (key: string) => call<void>('storage.delete', { key })
  }),
  shortcuts: Object.freeze({
    onFind: (handler: () => void) => {
      const listener = () => handler()
      let subscribed = true
      findSubscribers += 1
      shortcutEvents.addEventListener('find', listener)

      return () => {
        if (!subscribed) {
          return
        }

        subscribed = false
        findSubscribers -= 1
        shortcutEvents.removeEventListener('find', listener)
      }
    }
  })
})
