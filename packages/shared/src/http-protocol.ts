import * as Schema from 'effect/Schema'
import { browserObservedUrlSchema } from './browser-protocol.js'
import { jsonValueSchema } from './json-schema.js'
import { terminalRuntimeMetadataSchema } from './terminal-protocol.js'
import { webAppPermissionSchema } from './web-app-protocol.js'

const projectColorSchema = Schema.Literal(
  'rose',
  'orange',
  'amber',
  'emerald',
  'cyan',
  'blue',
  'violet',
  'pink'
)

const stringArraySchema = Schema.Array(Schema.String)
const nullableStringSchema = Schema.NullOr(Schema.String)

const jsonObjectSchema = Schema.Record({
  key: Schema.String,
  value: jsonValueSchema
})

export const launcherDefinitionsQuerySchema = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  worktreeId: Schema.optional(Schema.String)
})

export const operationQuerySchema = Schema.Struct({
  kind: Schema.optional(
    Schema.Literal(
      'create',
      'finish',
      'discard',
      'project_cleanup',
      'remove',
      'external_remove'
    )
  ),
  projectId: Schema.optional(Schema.String)
})

export const deleteAppQuerySchema = Schema.Struct({
  discardStoredData: Schema.optional(Schema.String),
  force: Schema.optional(Schema.String)
})

export const okResponseSchema = Schema.Struct({ ok: Schema.Literal(true) })

export const terminalRecordSchema = Schema.Struct({
  id: Schema.String,
  worktreeId: Schema.String,
  name: Schema.String,
  command: nullableStringSchema,
  status: Schema.Literal('running', 'exited', 'missing', 'unavailable'),
  exitCode: Schema.NullOr(Schema.Int),
  unavailableReason: Schema.optional(Schema.NullOr(Schema.String)),
  recoveryPending: Schema.optional(Schema.Boolean),
  commandExitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  createdAt: Schema.String,
  updatedAt: Schema.String
})

const launcherCommandSchema = Schema.Struct({
  executable: Schema.String,
  args: stringArraySchema
})

export const launcherSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  executable: Schema.String,
  args: stringArraySchema,
  closeOnSuccess: Schema.Boolean,
  treeTitle: Schema.NullOr(launcherCommandSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String
})

const webAppLaunchSchema = Schema.Struct({
  input: Schema.NullOr(jsonObjectSchema),
  cwd: nullableStringSchema
})

const webAppSandboxSchema = Schema.Struct({
  enabled: Schema.Boolean,
  allowSameOrigin: Schema.Boolean
})

export const webAppSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal('web'),
  worktreeId: Schema.String,
  definitionId: Schema.String,
  title: Schema.String,
  launch: webAppLaunchSchema,
  permissions: Schema.Array(webAppPermissionSchema),
  sandbox: webAppSandboxSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String
})

export const browserAppSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal('browser'),
  worktreeId: Schema.String,
  title: Schema.String,
  url: Schema.Union(Schema.Literal('about:blank'), browserObservedUrlSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String
})

const terminalWorkspaceItemSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal('terminal'),
  worktreeId: Schema.String,
  terminalId: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String
})

const workspaceItemSchema = Schema.Union(
  terminalWorkspaceItemSchema,
  webAppSchema,
  browserAppSchema
)

const treeDecorationSchema = Schema.Struct({
  key: Schema.String,
  text: Schema.String,
  title: Schema.String,
  tone: Schema.Literal(
    'neutral',
    'info',
    'success',
    'warning',
    'danger',
    'done'
  ),
  url: nullableStringSchema,
  icon: nullableStringSchema,
  source: nullableStringSchema,
  updatedAt: Schema.String
})

const dirtyStateSchema = Schema.Struct({
  dirty: Schema.Boolean,
  staged: Schema.NonNegativeInt,
  unstaged: Schema.NonNegativeInt,
  untracked: Schema.NonNegativeInt,
  conflicts: Schema.NonNegativeInt,
  total: Schema.NonNegativeInt
})

export const worktreeRecordSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  title: nullableStringSchema,
  path: Schema.String,
  head: Schema.String,
  branch: nullableStringSchema,
  detached: Schema.Boolean,
  locked: Schema.Boolean,
  lockReason: nullableStringSchema,
  prunable: Schema.Boolean,
  kind: Schema.Literal('main', 'linked', 'folder'),
  managedWrapperPath: nullableStringSchema,
  decorations: Schema.Array(treeDecorationSchema),
  dirty: Schema.NullOr(dirtyStateSchema),
  terminals: Schema.Array(terminalRecordSchema),
  workspaceItems: Schema.Array(workspaceItemSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String
})

export const projectRecordSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literal('repository', 'folder'),
  rootPath: Schema.String,
  repositoryPath: Schema.String,
  mainWorktreePath: Schema.String,
  defaultBranch: Schema.String,
  originUrl: nullableStringSchema,
  color: Schema.NullOr(projectColorSchema),
  availability: Schema.Struct({
    state: Schema.Literal('available', 'unavailable'),
    message: nullableStringSchema
  }),
  worktrees: Schema.Array(worktreeRecordSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String
})

export const recentProjectRecordSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literal('repository', 'folder'),
  rootPath: Schema.String,
  repositoryPath: Schema.String,
  lastOpenedAt: Schema.String
})

const cleanupCommandProgressSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal('pending', 'running', 'completed', 'failed'),
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  error: nullableStringSchema,
  outputTruncated: Schema.Boolean
})

const removeCleanupProgressSchema = Schema.Struct({
  status: Schema.Literal(
    'pending',
    'running',
    'completed',
    'failed',
    'skipped'
  ),
  definitionHash: nullableStringSchema,
  skippedReason: nullableStringSchema,
  commands: Schema.Array(cleanupCommandProgressSchema)
})

export const removePreviewSchema = Schema.Struct({
  worktreeId: Schema.String,
  name: Schema.String,
  path: Schema.String,
  head: Schema.String,
  branch: nullableStringSchema,
  detached: Schema.Boolean,
  locked: Schema.Boolean,
  lockReason: nullableStringSchema,
  dirty: dirtyStateSchema,
  detachedHeadReachable: Schema.NullOr(Schema.Boolean),
  forceRequired: Schema.Boolean,
  eligible: Schema.Boolean,
  reasons: stringArraySchema,
  warnings: stringArraySchema,
  cleanup: Schema.Struct({
    commands: stringArraySchema,
    available: Schema.Boolean,
    unavailableReason: nullableStringSchema
  }),
  terminals: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: Schema.Literal('running', 'exited', 'missing', 'unavailable')
    })
  ),
  confirmationToken: Schema.String
})

const operationBaseFields = {
  id: Schema.String,
  projectId: nullableStringSchema,
  worktreeId: nullableStringSchema,
  status: Schema.Literal('pending', 'running', 'completed', 'failed'),
  error: nullableStringSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String
}

const createOperationRequestSchema = Schema.Struct({
  name: Schema.String,
  base: Schema.Literal('default', 'current'),
  context: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String })
  ),
  initialTerminal: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      initialTitle: Schema.optional(Schema.String),
      command: Schema.optional(Schema.String),
      afterExit: Schema.optional(
        Schema.Literal('shell', 'close', 'closeOnSuccess')
      ),
      initialSize: Schema.optional(
        Schema.Struct({ cols: Schema.Int, rows: Schema.Int })
      )
    })
  ),
  sourceWorktreeId: Schema.optional(Schema.String),
  treeTitleCommand: Schema.optional(stringArraySchema)
})

const createOperationResultSchema = Schema.Struct({
  worktreeId: Schema.String,
  terminalId: nullableStringSchema,
  terminalError: nullableStringSchema,
  setupError: nullableStringSchema
})

const removalCheckoutIdentitySchema = Schema.Struct({
  path: Schema.String,
  device: Schema.String,
  inode: Schema.String,
  gitWorktreeKey: Schema.String,
  gitMarker: Schema.String,
  repositoryIdentity: nullableStringSchema,
  managedWrapperPath: nullableStringSchema,
  quarantinePath: Schema.String
})

const removeOperationRequestSchema = Schema.Struct({
  confirmation: Schema.NullOr(Schema.Boolean),
  confirmationToken: nullableStringSchema,
  confirmDestructive: Schema.NullOr(Schema.Boolean),
  skipCleanup: Schema.Boolean,
  preview: Schema.NullOr(removePreviewSchema),
  checkoutIdentity: Schema.NullOr(removalCheckoutIdentitySchema),
  prunable: Schema.NullOr(Schema.Boolean),
  gitWorktreeKey: nullableStringSchema,
  repositoryIdentity: nullableStringSchema,
  phase: Schema.NullOr(
    Schema.Literal(
      'accepted',
      'terminals_stopped',
      'cleanup_commands_completed',
      'git_removed',
      'cleanup_pending'
    )
  ),
  managedWrapperPath: nullableStringSchema,
  cleanupCommands: removeCleanupProgressSchema
})

const removeOperationResultSchema = Schema.Struct({
  removed: Schema.Literal(true),
  worktreeId: Schema.String,
  name: Schema.String,
  branchPreserved: nullableStringSchema,
  path: Schema.String,
  recovered: Schema.Boolean,
  cleanup: Schema.Struct({
    status: Schema.Literal('completed', 'preserved'),
    residualPath: nullableStringSchema,
    warning: nullableStringSchema,
    commands: Schema.Array(cleanupCommandProgressSchema)
  })
})

const externalRemoveResultSchema = Schema.Struct({
  removed: Schema.Literal(true),
  external: Schema.Literal(true),
  worktreeId: Schema.String,
  path: Schema.String,
  head: Schema.String,
  branch: nullableStringSchema,
  cleanup: Schema.Struct({
    status: Schema.Literal('skipped'),
    skippedReason: Schema.String
  })
})

export const operationRecordSchema = Schema.Union(
  Schema.Struct({
    ...operationBaseFields,
    kind: Schema.Literal('create'),
    request: createOperationRequestSchema,
    result: Schema.NullOr(createOperationResultSchema)
  }),
  Schema.Struct({
    ...operationBaseFields,
    kind: Schema.Literal('remove'),
    request: removeOperationRequestSchema,
    result: Schema.NullOr(removeOperationResultSchema)
  }),
  Schema.Struct({
    ...operationBaseFields,
    kind: Schema.Literal('external_remove'),
    request: Schema.Struct({ source: Schema.Literal('git') }),
    result: Schema.NullOr(externalRemoveResultSchema)
  }),
  Schema.Struct({
    ...operationBaseFields,
    kind: Schema.Literal('finish', 'discard', 'project_cleanup'),
    request: jsonObjectSchema,
    result: Schema.NullOr(jsonObjectSchema)
  })
)

export const directoryBrowseResponseSchema = Schema.Struct({
  input: Schema.String,
  exact: Schema.Boolean,
  directory: Schema.Struct({
    path: Schema.String,
    parentPath: nullableStringSchema,
    homePath: Schema.String,
    rootPath: Schema.String,
    breadcrumbs: Schema.Array(
      Schema.Struct({ name: Schema.String, path: Schema.String })
    ),
    entries: Schema.Array(
      Schema.Struct({ name: Schema.String, path: Schema.String })
    ),
    truncated: Schema.Boolean
  }),
  project: Schema.Union(
    Schema.Struct({
      state: Schema.Literal('valid'),
      kind: Schema.Literal('repository', 'folder'),
      path: Schema.String
    }),
    Schema.Struct({
      state: Schema.Literal('incomplete'),
      message: Schema.String
    })
  ),
  repository: Schema.Union(
    Schema.Struct({
      state: Schema.Literal('valid'),
      repositoryPath: Schema.String
    }),
    Schema.Struct({
      state: Schema.Literal('incomplete'),
      message: Schema.String
    }),
    Schema.Struct({
      state: Schema.Literal('not-repository'),
      message: Schema.String
    })
  )
})

const packageDefinitionSourceSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal('user') }),
  Schema.Struct({
    type: Schema.Literal('repository'),
    format: Schema.Literal('treeport', 'zed')
  }),
  Schema.Struct({
    type: Schema.Literal('package'),
    packageId: Schema.String,
    source: Schema.String,
    scope: Schema.Literal('global', 'project')
  })
)

export const launcherDefinitionListingSchema = Schema.Struct({
  definitions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      executable: nullableStringSchema,
      args: stringArraySchema,
      shellCommand: nullableStringSchema,
      cwd: nullableStringSchema,
      env: Schema.Record({ key: Schema.String, value: Schema.String }),
      closeOnSuccess: Schema.Boolean,
      treeTitle: Schema.NullOr(launcherCommandSchema),
      source: packageDefinitionSourceSchema
    })
  ),
  diagnostics: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      itemId: nullableStringSchema,
      message: Schema.String
    })
  )
})

export const webAppDefinitionSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  icon: nullableStringSchema,
  source: Schema.Union(
    Schema.Struct({ type: Schema.Literal('project') }),
    Schema.Struct({
      type: Schema.Literal('package'),
      packageId: Schema.String,
      source: Schema.String,
      scope: Schema.Literal('global', 'project')
    })
  ),
  permissions: Schema.Array(webAppPermissionSchema),
  permissionsGranted: Schema.Boolean,
  sandbox: webAppSandboxSchema
})

export const webAppContextSchema = Schema.Struct({
  apiVersion: Schema.Literal(1),
  app: webAppSchema,
  launch: webAppLaunchSchema,
  project: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind: Schema.Literal('repository', 'folder'),
    defaultBranch: nullableStringSchema
  }),
  worktree: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind: Schema.Literal('main', 'linked', 'folder'),
    branch: nullableStringSchema,
    head: nullableStringSchema
  })
})

export const gitDiffImageSchema = Schema.Struct({
  dataUrl: Schema.String,
  byteLength: Schema.Number
})

const gitDiffFileSchema = Schema.Struct({
  path: Schema.String,
  previousPath: nullableStringSchema,
  status: Schema.Literal('modified', 'added', 'deleted', 'renamed', 'untracked')
})

export const gitDiffSchema = Schema.Struct({
  baseRef: Schema.String,
  baseCommit: Schema.String,
  headCommit: Schema.String,
  generatedAt: Schema.String,
  files: Schema.Array(gitDiffFileSchema),
  lineCounts: Schema.Struct({
    additions: Schema.NonNegativeInt,
    deletions: Schema.NonNegativeInt
  }),
  changeSets: Schema.Struct({
    branch: stringArraySchema,
    staged: stringArraySchema,
    unstaged: stringArraySchema,
    untracked: stringArraySchema
  })
})

export const worktreeListenerDiscoverySchema = Schema.Struct({
  supported: Schema.Boolean,
  message: nullableStringSchema,
  listeners: Schema.Array(
    Schema.Struct({
      pid: Schema.Int,
      command: Schema.String,
      host: Schema.String,
      port: Schema.Int,
      terminalId: nullableStringSchema
    })
  )
})

export const treeFileListingSchema = Schema.Struct({
  paths: stringArraySchema,
  truncated: Schema.Boolean
})

export const treeFileSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  revision: Schema.String
})

export const treeFileSearchResultSchema = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      matches: Schema.Array(
        Schema.Struct({
          lineNumber: Schema.Int,
          column: Schema.NonNegativeInt,
          length: Schema.NonNegativeInt,
          preview: Schema.String,
          previewStart: Schema.NonNegativeInt,
          lineLength: Schema.NonNegativeInt
        })
      )
    })
  ),
  truncated: Schema.Boolean
})

export const treeFileWriteResultSchema = Schema.Struct({
  path: Schema.String,
  revision: Schema.String
})

const packageResourceDiagnosticSchema = Schema.Struct({
  severity: Schema.Literal('warning', 'error'),
  message: Schema.String,
  scope: Schema.Literal('global', 'project'),
  source: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  resourceType: Schema.optional(Schema.Literal('web-app', 'launcher')),
  path: Schema.optional(Schema.String)
})

const packageListingSchema = Schema.Struct({
  source: Schema.String,
  identity: Schema.String,
  scope: Schema.Literal('global', 'project'),
  projectId: nullableStringSchema,
  projectName: nullableStringSchema,
  installedPath: nullableStringSchema,
  resources: Schema.Struct({
    webApps: Schema.NonNegativeInt,
    launchers: Schema.NonNegativeInt
  }),
  diagnostics: Schema.Array(packageResourceDiagnosticSchema)
})

const packageOperationResultSchema = Schema.Struct({
  action: Schema.Literal('install', 'remove', 'update', 'reload'),
  source: nullableStringSchema,
  scope: Schema.Literal('global', 'project'),
  projectId: nullableStringSchema,
  status: Schema.Literal(
    'installed',
    'removed',
    'updated',
    'reloaded',
    'skipped'
  ),
  reason: Schema.optional(Schema.String)
})

export const workspaceActivityResponseSchema = Schema.Struct({
  working: Schema.Int.pipe(Schema.nonNegative()),
  needsAttention: Schema.Int.pipe(Schema.nonNegative())
})

export type WorkspaceActivityResponse = Schema.Schema.Type<
  typeof workspaceActivityResponseSchema
>

export const phoneAccessResponseSchema = Schema.Struct({
  url: nullableStringSchema,
  error: nullableStringSchema,
  setupCommand: nullableStringSchema
})

export type PhoneAccessResponse = Schema.Schema.Type<
  typeof phoneAccessResponseSchema
>

export const healthResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  version: Schema.String,
  protocolVersion: Schema.Int,
  hostname: Schema.String,
  pid: Schema.Int,
  instanceId: nullableStringSchema,
  installationMethod: Schema.String,
  daemonLifecycle: Schema.Literal('treeport', 'service', 'external'),
  url: Schema.String
})

export type HealthResponse = Schema.Schema.Type<typeof healthResponseSchema>

export const browserInstallStatusSchema = Schema.Struct({
  installed: Schema.Boolean,
  executablePath: nullableStringSchema,
  playwrightVersion: Schema.String,
  browserRevision: Schema.String,
  channel: Schema.Literal('chromium', 'chrome'),
  launchReady: Schema.Boolean,
  launchError: nullableStringSchema
})

export const browserInstallResponseSchema = Schema.Struct({
  message: Schema.String
})

export const browserAgentResponseSchema = Schema.Struct({
  output: Schema.String
})

export const packageListingResponseSchema = Schema.Struct({
  packages: Schema.Array(packageListingSchema),
  diagnostics: Schema.Array(packageResourceDiagnosticSchema)
})

export const packageOperationResponseSchema = Schema.Struct({
  result: packageOperationResultSchema
})

export const packageOperationsResponseSchema = Schema.Struct({
  results: Schema.Array(packageOperationResultSchema)
})

export const packageReloadResponseSchema = Schema.Struct({
  results: Schema.Array(packageOperationResultSchema),
  diagnostics: Schema.Array(packageResourceDiagnosticSchema)
})

export const packageProjectResponseSchema = Schema.Struct({
  project: projectRecordSchema
})

export const packageServiceSelfResponseSchema = Schema.Struct({
  packageId: Schema.String,
  /** Null when the package is configured globally. */
  projectIds: Schema.NullOr(Schema.Array(Schema.String))
})

export const packageServiceProjectsResponseSchema = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      rootPath: Schema.String,
      availability: Schema.Struct({
        state: Schema.Literal('available', 'unavailable'),
        message: nullableStringSchema
      }),
      git: Schema.NullOr(
        Schema.Struct({
          defaultBranch: Schema.String,
          originUrl: nullableStringSchema
        })
      ),
      worktrees: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          git: Schema.NullOr(
            Schema.Struct({ branch: nullableStringSchema, head: Schema.String })
          ),
          decorations: Schema.Array(treeDecorationSchema)
        })
      )
    })
  )
})

export const projectsResponseSchema = Schema.Struct({
  projects: Schema.Array(projectRecordSchema)
})

export const recentProjectsResponseSchema = Schema.Struct({
  projects: Schema.Array(recentProjectRecordSchema)
})

export const projectResponseSchema = Schema.Struct({
  project: projectRecordSchema
})

export const worktreeResponseSchema = Schema.Struct({
  worktree: worktreeRecordSchema
})

export const worktreesResponseSchema = Schema.Struct({
  worktrees: Schema.Array(worktreeRecordSchema)
})

export const operationResponseSchema = Schema.Struct({
  operation: operationRecordSchema
})

export const operationsResponseSchema = Schema.Struct({
  operations: Schema.Array(operationRecordSchema)
})

export const launchersResponseSchema = Schema.Struct({
  launchers: Schema.Array(launcherSchema)
})

export const launcherResponseSchema = Schema.Struct({
  launcher: launcherSchema
})

export const webAppDefinitionsResponseSchema = Schema.Struct({
  definitions: Schema.Array(webAppDefinitionSchema)
})

export const openWebAppResponseSchema = Schema.Struct({
  app: webAppSchema,
  created: Schema.Boolean,
  reused: Schema.Boolean
})

export const openBrowserAppResponseSchema = Schema.Struct({
  app: browserAppSchema
})

export const terminalResponseSchema = Schema.Struct({
  terminal: terminalRecordSchema
})

export const terminalObservationResponseSchema = Schema.Struct({
  terminal: terminalRecordSchema,
  metadata: terminalRuntimeMetadataSchema
})

export const terminalCaptureResponseSchema = Schema.Struct({
  terminalId: Schema.String,
  capturedAt: Schema.String,
  lineLimit: Schema.Int.pipe(Schema.positive()),
  content: Schema.String
})

export const removePreviewResponseSchema = Schema.Struct({
  preview: removePreviewSchema
})

export const webAppContextResponseSchema = Schema.Struct({
  context: webAppContextSchema
})

export const gitDiffResponseSchema = Schema.Struct({ diff: gitDiffSchema })

export const gitFileDiffResponseSchema = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal('ready', 'oversized'),
  unified: nullableStringSchema,
  revision: nullableStringSchema,
  message: nullableStringSchema
})

export const listenerDiscoveryResponseSchema = Schema.Struct({
  discovery: worktreeListenerDiscoverySchema
})

export const webAppResponseSchema = Schema.Struct({ app: webAppSchema })

export const webAppDefinitionResponseSchema = Schema.Struct({
  definition: webAppDefinitionSchema
})

export const terminatedTerminalsResponseSchema = Schema.Struct({
  terminated: Schema.NonNegativeInt
})

export const hasDataResponseSchema = Schema.Struct({ hasData: Schema.Boolean })

export const storageValueResponseSchema = Schema.Struct({
  found: Schema.Boolean,
  value: jsonValueSchema
})

export const uploadedFileResponseSchema = Schema.Struct({
  file: Schema.Struct({ path: Schema.String })
})

export const applicationUpdateStatusSchema = Schema.Struct({
  currentVersion: Schema.String,
  latestVersion: nullableStringSchema,
  updateAvailable: Schema.Boolean,
  checkedAt: nullableStringSchema,
  canUpdate: Schema.Boolean,
  blockedReason: nullableStringSchema,
  phase: Schema.Literal(
    'idle',
    'checking',
    'starting',
    'inspect',
    'resolve',
    'stage',
    'verify',
    'stop',
    'activate',
    'restart',
    'health_check',
    'complete',
    'failed'
  ),
  operationId: nullableStringSchema,
  targetVersion: nullableStringSchema,
  error: nullableStringSchema
})
