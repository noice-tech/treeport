export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type WebAppInput = Record<string, JsonValue>

export interface WebAppLaunch {
  input: WebAppInput | null
  /** Directory relative to the tree root. */
  cwd: string | null
}

export type WebAppPermission = 'same-origin' | 'tree-files'

/** A persistent web app instance scoped to one tree. */
export interface WebApp {
  id: string
  kind: 'web'
  worktreeId: string
  definitionId: string
  title: string
  launch: WebAppLaunch
  permissions: WebAppPermission[]
  sandbox: {
    /** False only for apps explicitly declared as trusted and unsandboxed. */
    enabled: boolean
    allowSameOrigin: boolean
  }
  /** ISO 8601 timestamp. */
  createdAt: string
  /** ISO 8601 timestamp. */
  updatedAt: string
}

export interface WebAppContext {
  apiVersion: 1
  app: WebApp
  launch: WebAppLaunch
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

/** A changed file discovered without materializing its patch. */
export interface GitDiffFile {
  path: string
  previousPath: string | null
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
}

/**
 * A read-only diff index for the requested comparison. By default it includes
 * committed, tracked local, and untracked changes from the merge base.
 */
export interface GitDiff {
  baseRef: string
  /** HEAD for uncommitted changes; the default-branch merge base otherwise. */
  baseCommit: string
  headCommit: string
  /** ISO 8601 timestamp. */
  generatedAt: string
  files: GitDiffFile[]
  /** Complete text line totals, independent of patch loading. */
  lineCounts: { additions: number; deletions: number }
  /** Relative paths; a path can occur in more than one change set. */
  changeSets: GitDiffChangeSets
}

export interface GitDiffRequest {
  /** Committed: merge base to HEAD. Uncommitted: HEAD to working tree, including
   * staged and untracked files. Omit for the combined diff. */
  scope?: 'committed' | 'uncommitted'
}

export interface GitFileDiffRequest extends GitDiffRequest {
  path: string
}

/** A bounded patch. Oversized patches have null unified content. */
export interface GitFileDiff {
  path: string
  status: 'ready' | 'oversized'
  unified: string | null
  /** SHA-256 of unified, or null when content is unavailable. */
  revision: string | null
  message: string | null
}

/** An image in the working tree, or at a full Git commit ID. */
export interface GitDiffImageRequest {
  path: string
  /** null selects the current working-tree file. */
  commit: string | null
}

/** Bounded image contents. Render dataUrl only as an image, not as HTML. */
export interface GitDiffImage {
  dataUrl: string
  byteLength: number
}

export interface WorktreeListener {
  pid: number
  command: string
  host: string
  port: number
  terminalId: string | null
}

export interface WorktreeListenerDiscovery {
  supported: boolean
  message: string | null
  listeners: WorktreeListener[]
}

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

export interface TreeFileWrite {
  path: string
  content: string
  expectedRevision: string
}

export interface TreeFileWriteResult {
  path: string
  revision: string
}

export interface WebAppStorageOptions {
  /** Defaults to instance. Definition storage is shared across trees and survives app closure. */
  scope?: 'instance' | 'definition'
}

/** Durable key-value storage scoped to an app instance or definition. */
export interface WebAppStorage {
  get<Value extends JsonValue = JsonValue>(
    key: string,
    options?: WebAppStorageOptions
  ): Promise<Value | undefined>
  /** Store a JSON value. Values are limited to 64 KiB. */
  set(
    key: string,
    value: JsonValue,
    options?: WebAppStorageOptions
  ): Promise<void>
  delete(key: string, options?: WebAppStorageOptions): Promise<void>
}

/** Client-local controls for the current app. */
export interface WebAppControls {
  /** Set a runtime title. Pass null to restore the configured title. */
  setTitle(title: string | null): void
  /** Report local unsaved changes so Treeport can warn before app closure. */
  setDirty(dirty: boolean): void
}

export interface WebAppShortcuts {
  /** Run a handler when the user invokes Find with Cmd/Ctrl+F. */
  onFind(handler: () => void): () => void
}

/** A package-declared backend shared by every app in this Treeport instance. */
export interface AppService {
  id: string
  name: string
  status: 'stopped' | 'starting' | 'ready' | 'failed'
  pid: number | null
  /** Treeport-proxied URL with this app's tree context, when ready. */
  url: string | null
  logs: string
  error: string | null
}

export type TreeDecorationTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'done'

/** A short marker beside a tree's name, set by a script, hook, or package. */
export interface TreeDecoration {
  key: string
  text: string
  /** Shown on hover and in the tree's context menu. */
  title: string
  tone: TreeDecorationTone
  url: string | null
  /** SVG markup drawn before the text. Only its shape is used: it takes the tone's color. */
  icon: string | null
  /** ID of the package that owns this decoration, or null when set directly. */
  source: string | null
  /** ISO 8601 timestamp. */
  updatedAt: string
}

export interface TreeDecorationInput {
  /** At most 32 characters. */
  text: string
  /** What the decoration means, such as a pull request's title; at most 256 characters. */
  title: string
  /** Defaults to neutral. */
  tone?: TreeDecorationTone
  /** An http or https link, opened from the tree's context menu. */
  url?: string | null
  /** An `<svg>` of at most 8 KiB. Only its shape is used: it takes the tone's color. */
  icon?: string | null
}

export interface TreeportTree {
  id: string
  name: string
  /** Null when the tree is not a Git checkout. */
  git: {
    /** Null when HEAD is detached. */
    branch: string | null
    head: string
  } | null
  decorations: TreeDecoration[]
}

export interface TreeportProject {
  id: string
  name: string
  rootPath: string
  availability: {
    state: 'available' | 'unavailable'
    message: string | null
  }
  /** Null when the project is not a Git repository. */
  git: {
    defaultBranch: string
    /** Fetch URL of the origin remote, when it has one. */
    originUrl: string | null
  } | null
  worktrees: TreeportTree[]
}

/**
 * A change a package service may react to. Events name what changed; read
 * the current state with `projects()`.
 */
export type TreeportEvent =
  /** Read everything again: the stream (re)connected and may have missed events. */
  | { type: 'resync' }
  | { type: 'tree.created'; projectId: string; treeId: string }
  | { type: 'tree.removed'; projectId: string; treeId: string }
  /** The tree's contents moved, such as a commit, checkout, or push in a Git tree. */
  | { type: 'tree.changed'; projectId: string; treeId: string }

/** The package a service acts for, and where it is configured. */
export interface PackageServiceIdentity {
  packageId: string
  /** Null when the package is configured globally. */
  projectIds: string[] | null
}

/** The Treeport API available to a package service process. */
export interface TreeportServiceSdk {
  readonly version: 1
  /** The package this service acts for; it owns the decorations the service sets. */
  self(): Promise<PackageServiceIdentity>
  /** Projects this service's package is configured for, with their trees. */
  projects(): Promise<TreeportProject[]>
  /**
   * Changes in this package's projects. The stream reconnects by itself and
   * starts every connection with `resync`.
   */
  events(): AsyncIterable<TreeportEvent>
  readonly decorations: {
    /** Set or replace this package's decoration. Unchanged values cost nothing. */
    set(
      treeId: string,
      key: string,
      decoration: TreeDecorationInput
    ): Promise<void>
    /** Remove a decoration this package owns; removing a missing decoration is a no-op. */
    clear(treeId: string, key: string): Promise<void>
  }
}

export interface TreeportAppSdk {
  readonly version: 1
  readonly app: WebAppControls
  readonly services: {
    /** Start or attach to a declared service and wait for readiness. Does not navigate or change the app UI. */
    ensure(name: string): Promise<AppService>
    /** Inspect state and bounded process output without starting the service. */
    status(name: string): Promise<AppService>
    /** Stop the shared backend; affects every attached app. */
    stop(name: string): Promise<AppService>
  }
  /** Return the identity and Git context for the current app. */
  context(): Promise<WebAppContext>
  /** Return the changed-file index and its Git-layer file groups. */
  diff(input?: GitDiffRequest): Promise<GitDiff>
  /** Return one bounded file patch, or an explicit oversized state. */
  diffFile(input: GitFileDiffRequest): Promise<GitFileDiff>
  /** Read a repository image (maximum 5 MiB) for a diff preview. */
  diffImage(input: GitDiffImageRequest): Promise<GitDiffImage>
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
  /** Durable storage. Instance-scoped values are deleted when this app is closed. */
  readonly storage: WebAppStorage
  /** Shortcuts delivered whether focus is in the app or Treeport host. */
  readonly shortcuts: WebAppShortcuts
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
        { source: 'treeport-app-v1', method: 'workspace.select', index },
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
    | 'services.ensure'
    | 'services.status'
    | 'services.stop'
    | 'diff'
    | 'diff.file'
    | 'diff.image'
    | 'network.listeners'
    | 'files.list'
    | 'files.read'
    | 'files.search'
    | 'files.write'
    | 'storage.get'
    | 'storage.set'
    | 'storage.delete',
  params?: {
    scope?: GitDiffRequest['scope'] | WebAppStorageOptions['scope']
    name?: string
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
      { source: 'treeport-app-v1', id, method, ...params },
      '*'
    )
  })
}

export const treeport: TreeportAppSdk = Object.freeze({
  version: 1,
  app: Object.freeze({
    setTitle: (title: string | null) => {
      if (parent === self) {
        return
      }

      parent.postMessage(
        { source: 'treeport-app-v1', method: 'app.title.set', title },
        '*'
      )
    },
    setDirty: (dirty: boolean) => {
      if (parent === self) {
        return
      }

      parent.postMessage(
        { source: 'treeport-app-v1', method: 'app.dirty.set', dirty },
        '*'
      )
    }
  }),
  services: Object.freeze({
    ensure: (name: string) => call<AppService>('services.ensure', { name }),
    status: (name: string) => call<AppService>('services.status', { name }),
    stop: (name: string) => call<AppService>('services.stop', { name })
  }),
  context: () => call<WebAppContext>('context'),
  diff: (input?: GitDiffRequest) => call<GitDiff>('diff', { ...input }),
  diffFile: (input: GitFileDiffRequest) =>
    call<GitFileDiff>('diff.file', { ...input }),
  diffImage: (input: GitDiffImageRequest) =>
    call<GitDiffImage>('diff.image', { ...input }),
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
    get: <Value extends JsonValue = JsonValue>(
      key: string,
      options?: WebAppStorageOptions
    ) => call<Value | undefined>('storage.get', { key, ...options }),
    set: (key: string, value: JsonValue, options?: WebAppStorageOptions) =>
      call<void>('storage.set', { key, value, ...options }),
    delete: (key: string, options?: WebAppStorageOptions) =>
      call<void>('storage.delete', { key, ...options })
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
