import * as Schema from 'effect/Schema'
import type {
  TreeDecoration,
  TreeDecorationTone,
  WebApp,
  WebAppInput,
  WebAppPermission
} from '@treeport/app-sdk'
import { browserUrlSchema } from './browser-protocol.js'
import { jsonValueSchema } from './json-schema.js'
import type { WorkspacePresence } from './presence-protocol.js'
import {
  webAppPermissionSchema,
  webAppStorageScopeSchema
} from './web-app-protocol.js'
import {
  terminalSizeSchema,
  type TerminalRuntimeMetadata
} from './terminal-protocol.js'

export type {
  GitDiff,
  GitDiffRequest,
  GitDiffChangeSets,
  GitDiffFile,
  GitFileDiff,
  GitFileDiffRequest,
  GitDiffImage,
  GitDiffImageRequest,
  JsonValue,
  TreeFile,
  TreeFileListing,
  TreeFileSearchFile,
  TreeFileSearchMatch,
  TreeFileSearchResult,
  TreeFileWrite,
  TreeFileWriteResult,
  WebApp,
  WebAppContext,
  WebAppInput,
  WebAppLaunch,
  WebAppPermission,
  WorktreeListener,
  WorktreeListenerDiscovery,
  PackageServiceIdentity,
  TreeDecoration,
  TreeDecorationInput,
  TreeDecorationTone,
  TreeportEvent,
  TreeportProject,
  TreeportServiceSdk,
  TreeportTree
} from '@treeport/app-sdk'

export * from './browser-protocol.js'

export * from './browser-clipboard.js'

export * from './browser-page-metadata.js'

export * from './browser-video.js'

export * from './http-protocol.js'

export * from './json-schema.js'

export * from './network-rpc.js'

export * from './network-rpc-client.js'

export * from './protocol-socket-client.js'

export * from './presence-protocol.js'

export * from './push-protocol.js'

export * from './schema.js'

export * from './socket-protocol.js'

export * from './terminal-protocol.js'

export * from './web-app-protocol.js'

export const PRODUCT_NAME = 'Treeport'
export const API_VERSION = 1
export const DESKTOP_PROTOCOL_VERSION = 3
export const TERMINAL_MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024
export const TERMINAL_NAME_MAX_LENGTH = 120
export const TERMINAL_ARGV_MAX_COUNT = 128
export const TERMINAL_EXECUTABLE_MAX_LENGTH = 4_096
export const TERMINAL_ARGUMENT_MAX_LENGTH = 4_096
export const LAUNCHER_ARGUMENT_MAX_COUNT = TERMINAL_ARGV_MAX_COUNT - 1
export const TERMINAL_CAPTURE_DEFAULT_LINES = 200
export const TERMINAL_CAPTURE_MAX_LINES = 5_000
export const WEB_APP_INPUT_MAX_BYTES = 64 * 1024
export const TREE_FILE_MAX_BYTES = 2 * 1024 * 1024
export const TREE_FILE_LIST_MAX_ENTRIES = 50_000
export const TREE_FILE_SEARCH_QUERY_MAX_LENGTH = 256
export const TREE_FILE_SEARCH_MAX_MATCHES = 500
export const TREE_FILE_SEARCH_PREVIEW_MAX_LENGTH = 300

export function formatCommandLine(argv: readonly string[]): string {
  return argv
    .map((value) =>
      /^[\w@%+=:,./-]+$/u.test(value)
        ? value
        : `'${value.replaceAll("'", `'\\''`)}'`
    )
    .join(' ')
}

export type ProjectKind = 'repository' | 'folder'

export type WorktreeKind = 'main' | 'linked' | 'folder'

export type TerminalStatus = 'running' | 'exited' | 'missing' | 'unavailable'

export type OperationStatus = 'pending' | 'running' | 'completed' | 'failed'

export type OperationKind =
  | 'create'
  | 'finish'
  | 'discard'
  | 'project_cleanup'
  | 'remove'
  | 'external_remove'

export const TREE_DECORATION_TONES = [
  'neutral',
  'info',
  'success',
  'warning',
  'danger',
  'done'
] as const satisfies readonly TreeDecorationTone[]

export interface TerminalRecord {
  id: string
  worktreeId: string
  name: string
  command: string | null
  status: TerminalStatus
  exitCode: number | null
  unavailableReason?: string | null | undefined
  recoveryPending?: boolean | undefined
  commandExitCode?: number | null | undefined
  createdAt: string
  updatedAt: string
}

export type TerminalAfterExit = 'shell' | 'close' | 'closeOnSuccess'

export interface LauncherCommand {
  readonly executable: string
  readonly args: readonly string[]
}

export interface Launcher {
  id: string
  name: string
  executable: string
  args: string[]
  closeOnSuccess: boolean
  /** Runs after a new tree starts; its first output line becomes the tree title. */
  treeTitle: LauncherCommand | null
  createdAt: string
  updatedAt: string
}

export type PackageScope = 'global' | 'project'

export type PackageResourceType = 'web-app' | 'launcher'

export interface PackageResourceDiagnostic {
  severity: 'warning' | 'error'
  message: string
  scope: PackageScope
  source?: string
  projectId?: string
  resourceType?: PackageResourceType
  path?: string
}

export type PackageSource =
  | string
  | {
      source: string
      autoload?: boolean
      webApps?: string[]
      launchers?: string[]
    }

export interface PackageListing {
  source: string
  identity: string
  scope: PackageScope
  projectId: string | null
  projectName: string | null
  installedPath: string | null
  resources: {
    webApps: number
    launchers: number
  }
  diagnostics: PackageResourceDiagnostic[]
}

export interface PackageOperationResult {
  action: 'install' | 'remove' | 'update' | 'reload'
  source: string | null
  scope: PackageScope
  projectId: string | null
  status: 'installed' | 'removed' | 'updated' | 'reloaded' | 'skipped'
  reason?: string
}

export type LauncherDefinitionSource =
  | { type: 'user' }
  | { type: 'repository'; format: 'treeport' | 'zed' }
  | {
      type: 'package'
      packageId: string
      source: string
      scope: PackageScope
    }

export interface LauncherDefinitionDiagnostic {
  path: string
  itemId: string | null
  message: string
}

export interface LauncherDefinitionListing {
  definitions: LauncherDefinition[]
  diagnostics: LauncherDefinitionDiagnostic[]
}

export interface LauncherDefinition {
  id: string
  name: string
  executable: string | null
  args: string[]
  shellCommand: string | null
  cwd: string | null
  env: Record<string, string>
  closeOnSuccess: boolean
  treeTitle: LauncherCommand | null
  source: LauncherDefinitionSource
}

export interface TerminalCapture {
  terminalId: string
  capturedAt: string
  lineLimit: number
  content: string
}

export interface TerminalWorkspaceItem {
  id: string
  kind: 'terminal'
  worktreeId: string
  terminalId: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface BrowserApp {
  id: string
  kind: 'browser'
  worktreeId: string
  title: string
  url: string
  createdAt: string
  updatedAt: string
}

export type App = WebApp | BrowserApp

export type WorkspaceItem = TerminalWorkspaceItem | App

export type WebAppSource =
  | { type: 'project' }
  | {
      type: 'package'
      packageId: string
      source: string
      scope: PackageScope
    }

export interface WebAppSandbox {
  /** False only for apps explicitly declared as trusted and unsandboxed. */
  enabled: boolean
  allowSameOrigin: boolean
}

export interface WebAppDefinition {
  id: string
  title: string
  icon: string | null
  source: WebAppSource
  permissions: WebAppPermission[]
  permissionsGranted: boolean
  sandbox: WebAppSandbox
}

export interface OpenWebAppResult {
  app: WebApp
  created: boolean
  reused: boolean
}

export interface OpenBrowserAppResult {
  app: BrowserApp
}

export interface WorktreeRecord {
  id: string
  projectId: string
  name: string
  title: string | null
  /** Shown while the launcher's tree title command runs; null otherwise. */
  pendingTitle: string | null
  path: string
  head: string
  branch: string | null
  detached: boolean
  locked: boolean
  lockReason: string | null
  prunable: boolean
  kind: WorktreeKind
  managedWrapperPath: string | null
  decorations: TreeDecoration[]
  dirty: DirtyState | null
  terminals: TerminalRecord[]
  workspaceItems: WorkspaceItem[]
  createdAt: string
  updatedAt: string
}

export const PROJECT_COLORS = [
  'rose',
  'orange',
  'amber',
  'emerald',
  'cyan',
  'blue',
  'violet',
  'pink'
] as const

export type ProjectColor = (typeof PROJECT_COLORS)[number]

export interface ProjectRecord {
  id: string
  name: string
  kind: ProjectKind
  /** Fetch URL of the repository's origin remote, when it has one. */
  originUrl: string | null
  /** Canonical root folder for this project. */
  rootPath: string
  /**
   * Repository root for repository projects. Folder projects use rootPath here
   * to preserve the version 1 API shape; inspect kind before using Git fields.
   */
  repositoryPath: string
  /**
   * Main checkout for repository projects. Folder projects use rootPath here
   * to preserve the version 1 API shape; inspect kind before using Git fields.
   */
  mainWorktreePath: string
  /** Empty for folder projects. */
  defaultBranch: string
  color: ProjectColor | null
  availability: {
    state: 'available' | 'unavailable'
    message: string | null
  }
  worktrees: WorktreeRecord[]
  createdAt: string
  updatedAt: string
}

export interface RecentProjectRecord {
  id: string
  name: string
  kind: ProjectKind
  rootPath: string
  repositoryPath: string
  lastOpenedAt: string
}

export type TreeportContext =
  | {
      managed: false
      reason: 'outside_treeport'
    }
  | {
      managed: true
      apiUrl: string
      daemonLifecycle: 'treeport' | 'service' | 'external'
      project: Pick<
        ProjectRecord,
        | 'id'
        | 'name'
        | 'kind'
        | 'rootPath'
        | 'repositoryPath'
        | 'mainWorktreePath'
        | 'defaultBranch'
        | 'availability'
      >
      worktree: Pick<
        WorktreeRecord,
        | 'id'
        | 'projectId'
        | 'name'
        | 'path'
        | 'head'
        | 'branch'
        | 'detached'
        | 'kind'
      >
      terminal: Pick<
        TerminalRecord,
        'id' | 'worktreeId' | 'name' | 'status' | 'exitCode'
      >
    }

export interface DirtyState {
  dirty: boolean
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
  total: number
}

export type CleanupCommandStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'

export interface CleanupCommandProgress {
  name: string
  status: CleanupCommandStatus
  stdout: string
  stderr: string
  exitCode: number | null
  error: string | null
  outputTruncated: boolean
}

export interface RemoveCleanupProgress {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  definitionHash: string | null
  skippedReason: string | null
  commands: CleanupCommandProgress[]
}

export interface RemovePreview {
  worktreeId: string
  name: string
  path: string
  head: string
  branch: string | null
  detached: boolean
  locked: boolean
  lockReason: string | null
  dirty: DirtyState
  detachedHeadReachable: boolean | null
  forceRequired: boolean
  eligible: boolean
  reasons: string[]
  warnings: string[]
  cleanup: {
    commands: string[]
    available: boolean
    unavailableReason: string | null
  }
  terminals: Array<Pick<TerminalRecord, 'id' | 'name' | 'status'>>
  confirmationToken: string
}

export interface RemovalCheckoutIdentity {
  path: string
  device: string
  inode: string
  gitWorktreeKey: string
  gitMarker: string
  repositoryIdentity: string | null
  managedWrapperPath: string | null
  quarantinePath: string
}

export interface CreateOperationRequest {
  name: string
  base: 'default' | 'current'
  initialTerminal?:
    | {
        name: string
        command?: string | undefined
        afterExit?: TerminalAfterExit | undefined
        initialSize?: { cols: number; rows: number } | undefined
      }
    | undefined
  sourceWorktreeId?: string | undefined
  treeTitle?: LauncherTreeTitle | undefined
}

export interface CreateOperationResult {
  worktreeId: string
  terminalId: string | null
  terminalError: string | null
  setupError: string | null
}

export type RemoveOperationPhase =
  | 'accepted'
  | 'terminals_stopped'
  | 'cleanup_commands_completed'
  | 'git_removed'
  | 'cleanup_pending'

export interface RemoveOperationRequest {
  confirmation: boolean | null
  confirmationToken: string | null
  confirmDestructive: boolean | null
  skipCleanup: boolean
  preview: RemovePreview | null
  checkoutIdentity: RemovalCheckoutIdentity | null
  prunable: boolean | null
  gitWorktreeKey: string | null
  repositoryIdentity: string | null
  phase: RemoveOperationPhase | null
  managedWrapperPath: string | null
  cleanupCommands: RemoveCleanupProgress
}

export interface RemoveOperationResult {
  removed: true
  worktreeId: string
  name: string
  branchPreserved: string | null
  path: string
  recovered: boolean
  cleanup: {
    status: 'completed' | 'preserved'
    residualPath: string | null
    warning: string | null
    commands: CleanupCommandProgress[]
  }
}

export interface ExternalRemoveOperationResult {
  removed: true
  external: true
  worktreeId: string
  path: string
  head: string
  branch: string | null
  cleanup: {
    status: 'skipped'
    skippedReason: string
  }
}

interface OperationRecordBase {
  id: string
  projectId: string | null
  worktreeId: string | null
  status: OperationStatus
  error: string | null
  createdAt: string
  updatedAt: string
}

export type CreateOperationRecord = OperationRecordBase & {
  kind: 'create'
  request: CreateOperationRequest
  result: CreateOperationResult | null
}

export type RemoveOperationRecord = OperationRecordBase & {
  kind: 'remove'
  request: RemoveOperationRequest
  result: RemoveOperationResult | null
}

export type OperationRecord =
  | CreateOperationRecord
  | RemoveOperationRecord
  | (OperationRecordBase & {
      kind: 'external_remove'
      request: { source: 'git' }
      result: ExternalRemoveOperationResult | null
    })
  | (OperationRecordBase & {
      kind: 'finish' | 'discard' | 'project_cleanup'
      request: object
      result: object | null
    })

export const apiErrorBodySchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    details: Schema.optional(Schema.Unknown)
  })
})

export type ApiErrorBody = Schema.Schema.Type<typeof apiErrorBodySchema>

export interface DirectoryBreadcrumb {
  name: string
  path: string
}

export interface DirectoryEntry {
  name: string
  path: string
}

export type DirectoryRepositoryStatus =
  | { state: 'valid'; repositoryPath: string }
  | { state: 'incomplete'; message: string }
  | { state: 'not-repository'; message: string }

export type DirectoryProjectStatus =
  | { state: 'valid'; kind: ProjectKind; path: string }
  | { state: 'incomplete'; message: string }

export interface DirectoryBrowseResponse {
  input: string
  exact: boolean
  directory: {
    path: string
    parentPath: string | null
    homePath: string
    rootPath: string
    breadcrumbs: DirectoryBreadcrumb[]
    entries: DirectoryEntry[]
    truncated: boolean
  }
  project: DirectoryProjectStatus
  repository: DirectoryRepositoryStatus
}

export const browseDirectoryQuerySchema = Schema.Struct({
  input: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  hidden: Schema.optionalWith(
    Schema.Literal('true', 'false').pipe(
      Schema.transform(Schema.Boolean, {
        strict: true,
        decode: (value) => value === 'true',
        encode: (value) => (value ? 'true' : 'false')
      })
    ),
    { default: () => false }
  )
})

export const terminalCaptureQuerySchema = Schema.Struct({
  lines: Schema.optionalWith(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.between(1, TERMINAL_CAPTURE_MAX_LINES)
    ),
    { default: () => TERMINAL_CAPTURE_DEFAULT_LINES }
  )
})

export const registerProjectSchema = Schema.Struct({
  path: Schema.Trim.pipe(Schema.minLength(1)),
  name: Schema.optional(
    Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(120))
  )
})

export const updateProjectSchema = Schema.Struct({
  color: Schema.NullOr(Schema.Literal(...PROJECT_COLORS))
})

const terminalNameSchema = Schema.Trim.pipe(
  Schema.minLength(1),
  Schema.maxLength(TERMINAL_NAME_MAX_LENGTH)
)

const terminalArgvSchema = Schema.Array(Schema.String).pipe(
  Schema.minItems(1),
  Schema.maxItems(TERMINAL_ARGV_MAX_COUNT)
)

const launcherArgumentSchema = Schema.String.pipe(
  Schema.maxLength(TERMINAL_ARGUMENT_MAX_LENGTH)
)

const launcherExecutableSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(TERMINAL_EXECUTABLE_MAX_LENGTH),
  Schema.filter((value) => value.trim().length > 0, {
    message: () => 'Executable cannot be blank'
  })
)

const launcherArgsSchema = Schema.Array(launcherArgumentSchema).pipe(
  Schema.maxItems(LAUNCHER_ARGUMENT_MAX_COUNT)
)

const launcherTreeTitleSchema = Schema.NullOr(
  Schema.Struct({
    executable: launcherExecutableSchema,
    args: launcherArgsSchema
  })
)

const launcherFields = {
  name: terminalNameSchema,
  executable: launcherExecutableSchema,
  args: launcherArgsSchema,
  closeOnSuccess: Schema.optionalWith(Schema.Boolean, {
    default: () => false
  }),
  treeTitle: Schema.optionalWith(launcherTreeTitleSchema, {
    default: () => null
  })
}

export const repositoryLauncherSchema = Schema.Struct(launcherFields)

const repositoryLauncherIdSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]{0,119}$/, {
    message: () =>
      'Launcher IDs must contain only lowercase letters, numbers, dots, underscores, and hyphens'
  })
)

export const repositoryLaunchersSettingsSchema = Schema.Struct({
  launchers: Schema.optionalWith(
    Schema.Record({
      key: repositoryLauncherIdSchema,
      value: Schema.Unknown
    }),
    { default: () => ({}) }
  )
})

const launcherRevisionSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64)
)

export const WORKTREE_TITLE_MAX_LENGTH = 120

const LAUNCHER_INPUT_PATTERN = /\$\{([a-z][a-z0-9_]*)\}/g
const LAUNCHER_WHOLE_INPUT_PATTERN = /^\$\{([a-z][a-z0-9_]*)\}$/

/** Input names referenced as `${name}` in launcher arguments, in first-use order. */
export function launcherInputNames(args: readonly string[]): string[] {
  return [
    ...new Set(
      args.flatMap((arg) =>
        [...arg.matchAll(LAUNCHER_INPUT_PATTERN)].map((match) => match[1]!)
      )
    )
  ]
}

/**
 * Substitutes inputs inside each argument without shell parsing, so values
 * never split into extra arguments. An argument that is exactly one empty
 * input is omitted, letting `["pi", "${prompt}"]` also start without a prompt.
 */
export function resolveLauncherArgs(
  args: readonly string[],
  inputs: Readonly<Record<string, string>>
): string[] {
  return args.flatMap((arg) => {
    const whole = LAUNCHER_WHOLE_INPUT_PATTERN.exec(arg)

    if (whole && !inputs[whole[1]!]) {
      return []
    }

    return [
      arg.replace(
        LAUNCHER_INPUT_PATTERN,
        (_match, name: string) => inputs[name] ?? ''
      )
    ]
  })
}

export interface LauncherTreeTitle {
  readonly command: readonly string[]
  readonly pendingTitle: string
}

/** The tree title command, plus the launcher's first input to show until it finishes. */
export function resolveLauncherTreeTitle(
  launcher: { name: string; treeTitle: LauncherCommand | null },
  inputs: Readonly<Record<string, string>>
): LauncherTreeTitle | null {
  if (!launcher.treeTitle) {
    return null
  }

  const input = launcherInputNames(launcher.treeTitle.args)
    .map((name) => inputs[name]?.replace(/\s+/gu, ' ').trim())
    .find(Boolean)

  return {
    command: [
      launcher.treeTitle.executable,
      ...resolveLauncherArgs(launcher.treeTitle.args, inputs)
    ],
    pendingTitle: (input ?? launcher.name)
      .slice(0, WORKTREE_TITLE_MAX_LENGTH)
      .trim()
  }
}

export function normalizeWorktreeName(input: string): string {
  const name = input
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')

  if (!name) {
    throw new Error('Tree name is required')
  }

  if (name.length > 120) {
    throw new Error('Tree name must be 120 characters or fewer')
  }

  return name
}

const TREE_NAME_ADJECTIVES = [
  'amber',
  'bold',
  'brave',
  'bright',
  'brisk',
  'calm',
  'clever',
  'cosy',
  'crisp',
  'daring',
  'eager',
  'early',
  'fair',
  'fleet',
  'fresh',
  'gentle',
  'golden',
  'grand',
  'happy',
  'hidden',
  'jolly',
  'keen',
  'kind',
  'lively',
  'lucky',
  'merry',
  'mellow',
  'misty',
  'nimble',
  'noble',
  'proud',
  'quick',
  'quiet',
  'rapid',
  'silver',
  'steady',
  'sunny',
  'swift',
  'tidy',
  'wild'
]

const TREE_NAME_NOUNS = [
  'acorn',
  'alder',
  'aspen',
  'bamboo',
  'banyan',
  'baobab',
  'birch',
  'cedar',
  'cherry',
  'cypress',
  'elm',
  'fern',
  'fig',
  'fir',
  'grove',
  'hazel',
  'hemlock',
  'holly',
  'juniper',
  'larch',
  'laurel',
  'linden',
  'magnolia',
  'maple',
  'meadow',
  'moss',
  'oak',
  'olive',
  'palm',
  'pine',
  'poplar',
  'redwood',
  'rowan',
  'sequoia',
  'spruce',
  'sycamore',
  'thicket',
  'walnut',
  'willow',
  'yew'
]

/** A random `adjective-noun` name, with a numeric suffix if every tried name is taken. */
export function availableTreeName(takenNames: readonly string[]): string {
  const taken = new Set(takenNames.map((name) => name.toLowerCase()))

  const pick = (words: readonly string[]) =>
    words[Math.floor(Math.random() * words.length)]!

  let name = `${pick(TREE_NAME_ADJECTIVES)}-${pick(TREE_NAME_NOUNS)}`

  for (let attempt = 1; taken.has(name); attempt += 1) {
    name = `${pick(TREE_NAME_ADJECTIVES)}-${pick(TREE_NAME_NOUNS)}${attempt > 32 ? `-${attempt}` : ''}`
  }

  return name
}

const terminalCommandSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(TERMINAL_ARGUMENT_MAX_LENGTH),
  Schema.filter((value) => value.trim().length > 0 && !value.includes('\0'), {
    message: () => 'Command cannot be blank or contain NUL'
  })
)

const terminalAfterExitSchema = Schema.Literal(
  'shell',
  'close',
  'closeOnSuccess'
)

const initialTerminalSchema = Schema.Struct({
  name: terminalNameSchema,
  command: Schema.optional(terminalCommandSchema),
  afterExit: Schema.optional(terminalAfterExitSchema),
  initialSize: Schema.optional(terminalSizeSchema)
})

export const createWorktreeSchema = Schema.Struct({
  name: Schema.optional(
    Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(120))
  ),
  base: Schema.optionalWith(Schema.Literal('default', 'current'), {
    default: () => 'default' as const
  }),
  sourceWorktreeId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  initialTerminal: Schema.optional(initialTerminalSchema),
  treeTitle: Schema.optional(
    Schema.Struct({
      command: terminalArgvSchema,
      pendingTitle: Schema.Trim.pipe(
        Schema.minLength(1),
        Schema.maxLength(WORKTREE_TITLE_MAX_LENGTH)
      )
    })
  )
}).pipe(
  Schema.filter(
    (value) => value.base !== 'current' || Boolean(value.sourceWorktreeId),
    { message: () => 'A source tree is required when starting from current' }
  )
)

const terminalCwdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.filter((value) => value.trim().length > 0 && !value.includes('\0'), {
    message: () => 'Working directory cannot be blank or contain NUL'
  })
)

const terminalEnvironmentKeySchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
  Schema.filter((value) => !value.includes('=') && !value.includes('\0'), {
    message: () => 'Environment keys cannot contain equals or NUL'
  })
)

const terminalEnvironmentSchema = Schema.Record({
  key: terminalEnvironmentKeySchema,
  value: Schema.String.pipe(
    Schema.maxLength(TERMINAL_ARGUMENT_MAX_LENGTH),
    Schema.filter((value) => !value.includes('\0'), {
      message: () => 'Environment values cannot contain NUL'
    })
  )
}).pipe(
  Schema.filter((value) => Object.keys(value).length <= 128, {
    message: () => 'Environment cannot contain more than 128 variables'
  })
)

export const createTerminalSchema = Schema.Struct({
  name: terminalNameSchema,
  command: Schema.optional(terminalCommandSchema),
  afterExit: Schema.optional(terminalAfterExitSchema),
  cwd: Schema.optional(terminalCwdSchema),
  env: Schema.optional(terminalEnvironmentSchema),
  initialSize: Schema.optional(terminalSizeSchema)
})

export const updateTerminalSchema = Schema.Struct({ name: terminalNameSchema })

export const updateWorktreeTitleSchema = Schema.Struct({
  title: Schema.NullOr(
    Schema.Trim.pipe(
      Schema.minLength(1),
      Schema.maxLength(WORKTREE_TITLE_MAX_LENGTH)
    )
  )
})

export const TREE_DECORATION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const TREE_DECORATION_TEXT_MAX_LENGTH = 32

export const setTreeDecorationSchema = Schema.Struct({
  text: Schema.Trim.pipe(
    Schema.minLength(1),
    Schema.maxLength(TREE_DECORATION_TEXT_MAX_LENGTH)
  ),
  title: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(256)),
  tone: Schema.optionalWith(Schema.Literal(...TREE_DECORATION_TONES), {
    default: () => 'neutral' as const
  }),
  url: Schema.optionalWith(
    Schema.NullOr(
      Schema.String.pipe(
        Schema.maxLength(2_048),
        Schema.filter(
          (url) =>
            URL.canParse(url) &&
            ['http:', 'https:'].includes(new URL(url).protocol),
          { message: () => 'A decoration URL must use http or https' }
        )
      )
    ),
    { default: () => null }
  ),
  icon: Schema.optionalWith(
    Schema.NullOr(
      Schema.Trim.pipe(
        Schema.maxLength(8_192),
        Schema.filter(
          (icon) => icon.startsWith('<svg') && icon.endsWith('</svg>'),
          { message: () => 'A decoration icon must be an <svg> element' }
        )
      )
    ),
    { default: () => null }
  )
})

export const reorderWorkspaceItemsSchema = Schema.Struct({
  itemIds: Schema.Array(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
  ).pipe(
    Schema.minItems(1),
    Schema.filter((itemIds) => new Set(itemIds).size === itemIds.length, {
      message: () => 'Item order cannot contain duplicates'
    })
  )
})

export const webAppInputSchema: Schema.Schema<WebAppInput> = Schema.Record({
  key: Schema.String,
  value: jsonValueSchema
})

export const createWebAppSchema = Schema.Struct({
  definitionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  input: Schema.optional(Schema.NullOr(webAppInputSchema)),
  launchCwd: Schema.optional(
    Schema.NullOr(Schema.String.pipe(Schema.maxLength(4_096)))
  )
})

export const updateWebAppPermissionGrantSchema = Schema.Struct({
  granted: Schema.Boolean,
  permissions: Schema.Array(webAppPermissionSchema)
})

export const createBrowserAppSchema = Schema.Struct({
  url: Schema.optional(browserUrlSchema),
  sourceTerminalId: Schema.optional(
    Schema.NullOr(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
    )
  )
})

export const openBrowserAppFromTerminalSchema = Schema.Struct({
  url: browserUrlSchema
})

export const openWebAppSchema = Schema.Struct({
  ...createWebAppSchema.fields,
  newInstance: Schema.optional(Schema.Boolean),
  sourceTerminalId: Schema.optional(
    Schema.NullOr(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
    )
  )
})

export const requestWorkspaceOpenSchema = Schema.Struct({
  sourceTerminalId: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128)
  )
})

export const webAppStorageKeySchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)

export const getWebAppStorageSchema = Schema.Struct({
  scope: Schema.optional(webAppStorageScopeSchema),
  key: webAppStorageKeySchema
})

export const setWebAppStorageSchema = Schema.Struct({
  scope: Schema.optional(webAppStorageScopeSchema),
  key: webAppStorageKeySchema,
  value: jsonValueSchema
})

export const deleteWebAppStorageSchema = Schema.Struct({
  scope: Schema.optional(webAppStorageScopeSchema),
  key: webAppStorageKeySchema
})

export const treeFilePathSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.filter(
    (value) =>
      !value.includes('\0') &&
      !value.startsWith('/') &&
      value.split('/').every((segment) => segment !== '' && segment !== '..'),
    { message: () => 'File path must be a relative path inside the tree' }
  )
)

export const readTreeFileSchema = Schema.Struct({ path: treeFilePathSchema })

export const searchTreeFilesSchema = Schema.Struct({
  query: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(TREE_FILE_SEARCH_QUERY_MAX_LENGTH),
    Schema.filter((value) => !/[\0\r\n]/.test(value), {
      message: () => 'Search query must be one line and cannot contain NUL'
    })
  )
})

export const writeTreeFileSchema = Schema.Struct({
  path: treeFilePathSchema,
  content: Schema.String,
  expectedRevision: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128)
  )
})

export const createLauncherSchema = Schema.Struct(launcherFields)

export const updateLauncherSchema = Schema.Struct({
  ...launcherFields,
  closeOnSuccess: Schema.optional(Schema.Boolean),
  treeTitle: Schema.optional(launcherTreeTitleSchema),
  expectedUpdatedAt: launcherRevisionSchema
})

export const deleteLauncherSchema = Schema.Struct({
  expectedUpdatedAt: launcherRevisionSchema
})

export const packageProjectQuerySchema = Schema.Struct({
  path: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096))
})

export const packageInstallSchema = Schema.Struct({
  source: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  projectId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})

export const packageRemoveSchema = Schema.Struct({
  source: Schema.String.pipe(Schema.minLength(1)),
  projectId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})

export const packageUpdateSchema = Schema.Struct({
  source: Schema.optional(
    Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(4_096))
  )
})

export const packageReloadSchema = Schema.Struct({
  projectId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})

export const removeWorktreeSchema = Schema.Struct({
  confirmationToken: Schema.String.pipe(Schema.length(64)),
  confirmDestructive: Schema.Boolean,
  skipCleanup: Schema.optionalWith(Schema.Boolean, {
    default: () => false
  })
})

interface ProductEventPayloadMap {
  'presence.changed': {
    viewers: readonly WorkspacePresence[]
  }
  'project.created': { projectId: string }
  'project.updated': { projectId: string }
  'project.removed': { projectId: string }
  'worktree.created': { projectId: string; worktreeId: string }
  'worktree.updated': { worktreeId: string }
  'worktree.removed': { projectId: string; worktreeId: string }
  'worktree.git_changed': { projectId: string; worktreeId: string }
  'create.started': { projectId: string; operationId: string }
  'create.completed': {
    projectId: string
    operationId: string
    worktreeId: string
  }
  'create.failed': { projectId: string; operationId: string }
  'terminal.created': {
    projectId?: string | undefined
    worktreeId: string
    terminalId: string
    terminal: TerminalRecord
  }
  'terminal.updated': { worktreeId: string; terminalId: string }
  'terminal.removed': { worktreeId: string; terminalId: string }
  'terminal.metadata': TerminalRuntimeMetadata
  'terminal.controller_changed': { terminalId: string; controlled: boolean }
  'app.created': { worktreeId: string; appId: string }
  'app.updated': { worktreeId: string; appId: string }
  'app.open_requested': {
    worktreeId: string
    appId: string
    app: BrowserApp | WebApp
    requestId?: string | null
    sourceTerminalId: string | null
    sourceAppId: string | null
  }
  'app.removed': { worktreeId: string; appId: string }
  'workspace.open_requested': {
    worktreeId: string
    sourceTerminalId: string
  }
  'remove.started': {
    operationId: string
    worktreeId: string
    kind: 'remove'
  }
  'remove.completed': { operationId: string; worktreeId: string }
  'remove.failed': {
    operationId: string
    worktreeId: string
    error: string
  }
}

export type ProductEventType = keyof ProductEventPayloadMap

export type ProductEventInputDataMap = {
  [Type in ProductEventType]: ProductEventPayloadMap[Type] & {
    worktreeId?: string | undefined
  }
}

export type ProductEventDataMap = {
  [Type in ProductEventType]: Omit<
    ProductEventPayloadMap[Type],
    'worktreeId'
  > & {
    worktreeId: string | null
  }
}

export type ProductEvent<Type extends ProductEventType = ProductEventType> = {
  [EventType in Type]: {
    id: string
    type: EventType
    at: string
    data: ProductEventDataMap[EventType]
  }
}[Type]
