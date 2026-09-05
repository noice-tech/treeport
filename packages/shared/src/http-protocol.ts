import * as Schema from 'effect/Schema'
import { browserUrlSchema } from './browser-protocol.js'
import { jsonValueSchema } from './json-schema.js'
import { terminalRuntimeMetadataSchema } from './terminal-protocol.js'
import { webPanelPermissionSchema } from './web-panel-protocol.js'

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

export const terminalPresetDefinitionsQuerySchema = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  worktreeId: Schema.optional(Schema.String)
})
export const treeContextFieldsQuerySchema = Schema.Struct({
  projectId: Schema.String.pipe(Schema.minLength(1))
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
export const deletePanelQuerySchema = Schema.Struct({
  discardStoredData: Schema.optional(Schema.String),
  force: Schema.optional(Schema.String)
})

export const okResponseSchema = Schema.Struct({ ok: Schema.Literal(true) })

export const terminalRecordSchema = Schema.Struct({
  id: Schema.String,
  worktreeId: Schema.String,
  name: Schema.String,
  argv: stringArraySchema,
  shellCommand: nullableStringSchema,
  interactiveShell: Schema.Boolean,
  status: Schema.Literal('running', 'exited', 'missing'),
  exitCode: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  updatedAt: Schema.String
})

export const terminalPresetSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  executable: Schema.String,
  args: stringArraySchema,
  closeOnSuccess: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String
})

const webPanelLaunchSchema = Schema.Struct({
  input: Schema.NullOr(jsonObjectSchema),
  cwd: nullableStringSchema
})
const webPanelSandboxSchema = Schema.Struct({
  allowSameOrigin: Schema.Boolean
})
export const webPanelSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal('web'),
  worktreeId: Schema.String,
  definitionId: Schema.String,
  title: Schema.String,
  launch: webPanelLaunchSchema,
  permissions: Schema.Array(webPanelPermissionSchema),
  sandbox: webPanelSandboxSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String
})
export const browserPanelSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal('browser'),
  worktreeId: Schema.String,
  title: Schema.String,
  url: Schema.Union(Schema.Literal('about:blank'), browserUrlSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String
})
const terminalPanelSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal('terminal'),
  worktreeId: Schema.String,
  terminalId: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String
})
const panelSchema = Schema.Union(
  terminalPanelSchema,
  webPanelSchema,
  browserPanelSchema
)

export const prInfoSchema = Schema.Struct({
  state: Schema.Literal('no_pr', 'open', 'merged', 'closed', 'unknown'),
  number: Schema.NullOr(Schema.Int),
  url: nullableStringSchema,
  baseBranch: nullableStringSchema,
  headBranch: nullableStringSchema,
  mergedAt: nullableStringSchema,
  refreshedAt: nullableStringSchema
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
  path: Schema.String,
  head: Schema.String,
  branch: nullableStringSchema,
  detached: Schema.Boolean,
  locked: Schema.Boolean,
  lockReason: nullableStringSchema,
  prunable: Schema.Boolean,
  kind: Schema.Literal('main', 'linked', 'folder'),
  managedWrapperPath: nullableStringSchema,
  pr: prInfoSchema,
  dirty: Schema.NullOr(dirtyStateSchema),
  terminals: Schema.Array(terminalRecordSchema),
  panels: Schema.Array(panelSchema),
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
      status: Schema.Literal('running', 'exited', 'missing')
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
      argv: Schema.optional(stringArraySchema),
      returnToShell: Schema.optional(Schema.Boolean),
      initialSize: Schema.optional(
        Schema.Struct({ cols: Schema.Int, rows: Schema.Int })
      )
    })
  ),
  sourceWorktreeId: Schema.optional(Schema.String)
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
export const terminalPresetDefinitionListingSchema = Schema.Struct({
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
export const treeContextFieldListingSchema = Schema.Struct({
  fields: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      input: Schema.Literal('text', 'textarea')
    })
  ),
  diagnostics: Schema.Array(
    Schema.Struct({
      scope: Schema.Literal('global', 'project'),
      path: Schema.String,
      message: Schema.String
    })
  )
})
export const webPanelDefinitionSchema = Schema.Struct({
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
  permissions: Schema.Array(webPanelPermissionSchema),
  permissionsGranted: Schema.Boolean,
  sandbox: webPanelSandboxSchema
})

export const webPanelContextSchema = Schema.Struct({
  apiVersion: Schema.Literal(1),
  panel: webPanelSchema,
  launch: webPanelLaunchSchema,
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
export const gitDiffSchema = Schema.Struct({
  baseRef: Schema.String,
  baseCommit: Schema.String,
  headCommit: Schema.String,
  generatedAt: Schema.String,
  unified: Schema.String,
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
  resourceType: Schema.optional(Schema.Literal('web-panel', 'terminal-preset')),
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
    webPanels: Schema.NonNegativeInt,
    terminalPresets: Schema.NonNegativeInt
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

// Desktop performs version negotiation before it can assume the current
// daemon health shape. Keep the fields introduced after version negotiation
// optional while still rejecting unknown or mistyped network data.
export const desktopHealthResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  version: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null
  }),
  protocolVersion: Schema.optional(Schema.Int),
  hostname: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Int),
  instanceId: Schema.optional(nullableStringSchema),
  installationMethod: Schema.optional(Schema.String),
  daemonLifecycle: Schema.optional(
    Schema.Literal('treeport', 'service', 'external')
  ),
  url: Schema.optional(Schema.String)
})
export type DesktopHealthResponse = Schema.Schema.Type<
  typeof desktopHealthResponseSchema
>

export const browserInstallStatusSchema = Schema.Struct({
  installed: Schema.Boolean,
  executablePath: Schema.String,
  playwrightVersion: Schema.String,
  browserRevision: Schema.String,
  channel: Schema.Literal('chromium'),
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
export const treeContextResponseSchema = Schema.Struct({
  context: Schema.Record({ key: Schema.String, value: Schema.String })
})
export const operationResponseSchema = Schema.Struct({
  operation: operationRecordSchema
})
export const operationsResponseSchema = Schema.Struct({
  operations: Schema.Array(operationRecordSchema)
})
export const terminalPresetsResponseSchema = Schema.Struct({
  presets: Schema.Array(terminalPresetSchema)
})
export const terminalPresetResponseSchema = Schema.Struct({
  preset: terminalPresetSchema
})
export const webPanelDefinitionsResponseSchema = Schema.Struct({
  definitions: Schema.Array(webPanelDefinitionSchema)
})
export const openWebPanelResponseSchema = Schema.Struct({
  panel: webPanelSchema,
  created: Schema.Boolean,
  reused: Schema.Boolean
})
export const openBrowserPanelResponseSchema = Schema.Struct({
  panel: browserPanelSchema
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
export const webPanelContextResponseSchema = Schema.Struct({
  context: webPanelContextSchema
})
export const gitDiffResponseSchema = Schema.Struct({ diff: gitDiffSchema })
export const listenerDiscoveryResponseSchema = Schema.Struct({
  discovery: worktreeListenerDiscoverySchema
})
export const webPanelResponseSchema = Schema.Struct({ panel: webPanelSchema })
export const webPanelDefinitionResponseSchema = Schema.Struct({
  definition: webPanelDefinitionSchema
})
export const prResponseSchema = Schema.Struct({ pr: prInfoSchema })
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
    'rollback',
    'complete',
    'recovery_required',
    'failed'
  ),
  operationId: nullableStringSchema,
  targetVersion: nullableStringSchema,
  error: nullableStringSchema
})
