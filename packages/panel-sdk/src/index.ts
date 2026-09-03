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
  /** Directory relative to the tree root. */
  cwd: string | null
}

export type WebPanelPermission = 'same-origin' | 'tree-files'

/** A persistent web panel instance scoped to one tree. */
export interface WebPanel {
  id: string
  kind: 'web'
  worktreeId: string
  definitionId: string
  title: string
  launch: WebPanelLaunch
  permissions: WebPanelPermission[]
  sandbox: {
    allowSameOrigin: boolean
  }
  /** ISO 8601 timestamp. */
  createdAt: string
  /** ISO 8601 timestamp. */
  updatedAt: string
}

/** Project and tree information available to the current panel. */
export interface WebPanelContext {
  apiVersion: 1
  panel: WebPanel
  launch: WebPanelLaunch
  project: {
    id: string
    name: string
    kind: 'repository' | 'folder'
    defaultBranch: string | null
  }
  worktree: {
    id: string
    name: string
    kind: 'main' | 'linked' | 'folder'
    branch: string | null
    head: string | null
  }
}

/** File paths grouped by the Git layer where they changed. */
export interface GitDiffChangeSets {
  /** Paths changed between the default-branch merge base and HEAD. */
  branch: string[]
  /** Paths changed between HEAD and the index. */
  staged: string[]
  /** Paths changed between the index and the working tree. */
  unstaged: string[]
  /** Untracked, non-ignored paths in the working tree. */
  untracked: string[]
}

/**
 * A read-only diff from the default-branch merge base through the tree's
 * committed, tracked local, and untracked changes.
 */
export interface GitDiff {
  baseRef: string
  baseCommit: string
  headCommit: string
  /** ISO 8601 timestamp. */
  generatedAt: string
  /** Combined unified diff text for the final working-tree state. */
  unified: string
  /** Relative paths; a path can occur in more than one change set. */
  changeSets: GitDiffChangeSets
}

/** A listening TCP socket attributed to the current tree. */
export interface WorktreeListener {
  pid: number
  command: string
  host: string
  port: number
  terminalId: string | null
}

/** The result of scanning for tree-scoped listening TCP sockets. */
export interface WorktreeListenerDiscovery {
  supported: boolean
  message: string | null
  listeners: WorktreeListener[]
}

/** Existing editable files in the current tree. */
export interface TreeFileListing {
  paths: string[]
  truncated: boolean
}

/** UTF-8 contents and revision for one existing tree file. */
export interface TreeFile {
  path: string
  content: string
  revision: string
}

/** One matching line in a tree-file search. */
export interface TreeFileSearchMatch {
  /** One-based line number in the file. */
  lineNumber: number
  /** Zero-based UTF-16 character offset in the complete line. */
  column: number
  /** UTF-16 length of the matched text. */
  length: number
  /** Bounded text from the matching line. */
  preview: string
  /** Zero-based offset of preview[0] in the complete line. */
  previewStart: number
  /** UTF-16 length of the complete line. */
  lineLength: number
}

/** Matching lines grouped by tree-relative file path. */
export interface TreeFileSearchFile {
  path: string
  matches: TreeFileSearchMatch[]
}

/** The bounded result of searching editable files in the current tree. */
export interface TreeFileSearchResult {
  files: TreeFileSearchFile[]
  truncated: boolean
}

/** A revision-checked update to one existing tree file. */
export interface TreeFileWrite {
  path: string
  content: string
  expectedRevision: string
}

/** The revision created by a successful tree-file update. */
export interface TreeFileWriteResult {
  path: string
  revision: string
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
  /** Report local unsaved changes so Treeport can warn before panel closure. */
  setDirty(dirty: boolean): void
}

/** Keyboard shortcuts Treeport can route to an active web panel. */
export interface WebPanelShortcuts {
  /** Run a handler when the user invokes Find with Cmd/Ctrl+F. */
  onFind(handler: () => void): () => void
}

/** The tree-scoped API available to a Treeport web panel. */
export interface TreeportPanelSdk {
  readonly version: 1
  /** Client-local controls for the current panel. */
  readonly panel: WebPanelControls
  /** Return the identity and Git context for the current panel. */
  context(): Promise<WebPanelContext>
  /** Return the combined tree diff and its Git-layer file groups. */
  diff(): Promise<GitDiff>
  /** Listening TCP sockets conservatively attributed to this tree. */
  readonly network: {
    listeners(): Promise<WorktreeListenerDiscovery>
  }
  /** Permission-gated access to existing UTF-8 files in this tree. */
  readonly files: {
    list(): Promise<TreeFileListing>
    read(path: string): Promise<TreeFile>
    search(query: string): Promise<TreeFileSearchResult>
    write(input: TreeFileWrite): Promise<TreeFileWriteResult>
  }
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
  errorCode?: string
}

interface HostShortcut {
  source: 'treeport-host-v1'
  method: 'shortcut'
  shortcut: 'find'
}

interface PendingRequest {
  complete(response: HostResponse): void
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
    if (event.source !== parent) {
      return
    }

    if (message?.source !== 'treeport-host-v1') {
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
    request.complete(message)
  }
)

function call<Result>(
  method:
    | 'context'
    | 'diff'
    | 'network.listeners'
    | 'files.list'
    | 'files.read'
    | 'files.search'
    | 'files.write'
    | 'storage.get'
    | 'storage.set'
    | 'storage.delete',
  params?: {
    key?: string
    value?: JsonValue
    path?: string
    query?: string
    content?: string
    expectedRevision?: string
  }
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const id = String(++serial)
    pending.set(id, {
      complete: (response) => {
        if (response.ok) {
          // SAFETY: The caller selects Result for the matching host method.
          resolve(response.value as Result)
        } else {
          const error = new Error(response.error || 'Treeport request failed')
          if (response.errorCode) {
            Object.assign(error, { code: response.errorCode })
          }

          reject(error)
        }
      }
    })
    parent.postMessage(
      { source: 'treeport-panel-v1', id, method, ...params },
      '*'
    )
  })
}

/** The tree-scoped API available to this web panel. */
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
    },
    setDirty: (dirty: boolean) => {
      if (parent === self) {
        return
      }

      parent.postMessage(
        { source: 'treeport-panel-v1', method: 'panel.dirty.set', dirty },
        '*'
      )
    }
  }),
  context: () => call<WebPanelContext>('context'),
  diff: () => call<GitDiff>('diff'),
  network: Object.freeze({
    listeners: () => call<WorktreeListenerDiscovery>('network.listeners')
  }),
  files: Object.freeze({
    list: () => call<TreeFileListing>('files.list'),
    read: (path: string) => call<TreeFile>('files.read', { path }),
    search: (query: string) =>
      call<TreeFileSearchResult>('files.search', { query }),
    write: (input: TreeFileWrite) =>
      call<TreeFileWriteResult>('files.write', input)
  }),
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
