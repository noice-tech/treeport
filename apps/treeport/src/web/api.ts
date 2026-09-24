import {
  presenceResponseSchema,
  apiErrorBodySchema,
  applicationUpdateStatusSchema,
  browserInstallResponseSchema,
  decodeUnknownOrNull,
  directoryBrowseResponseSchema,
  gitDiffResponseSchema,
  gitFileDiffResponseSchema,
  gitDiffImageSchema,
  hasDataResponseSchema,
  listenerDiscoveryResponseSchema,
  okResponseSchema,
  openBrowserTabResponseSchema,
  openWebPanelResponseSchema,
  operationResponseSchema,
  operationsResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  recentProjectsResponseSchema,
  removePreviewResponseSchema,
  storageValueResponseSchema,
  terminalPresetDefinitionListingSchema,
  terminalPresetResponseSchema,
  terminalPresetsResponseSchema,
  terminalResponseSchema,
  treeContextFieldListingSchema,
  treeFileListingSchema,
  treeFileSchema,
  treeFileSearchResultSchema,
  treeFileWriteResultSchema,
  uploadedFileResponseSchema,
  webPanelContextResponseSchema,
  webPanelDefinitionResponseSchema,
  webPanelDefinitionsResponseSchema
} from '@treeport/shared'
import type * as Schema from 'effect/Schema'
import type {
  PresenceUpdate,
  ViewerIdentity,
  DirectoryBrowseResponse,
  GitDiff,
  GitFileDiff,
  GitFileDiffRequest,
  GitDiffImage,
  GitDiffImageRequest,
  JsonValue,
  OpenBrowserTabResult,
  OpenWebPanelResult,
  OperationRecord,
  ProjectRecord,
  RecentProjectRecord,
  RemovePreview,
  TerminalPreset,
  TerminalPresetDefinitionListing,
  TerminalRecord,
  TreeContextFieldListing,
  TreeFileListing,
  TreeFileSearchResult,
  TreeFileWriteResult,
  WebPanelContext,
  WebPanelDefinition,
  WorktreeListenerDiscovery
} from '@treeport/shared'
import type { ApplicationUpdateStatus } from '../server/application-update'

export class RpcNetworkError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    cause: unknown
  ) {
    super('Treeport could not be reached', { cause })
    this.name = 'RpcNetworkError'
  }
}

export class DetailedError extends Error {
  readonly statusCode: number
  readonly detail: unknown

  constructor(
    message: string,
    options: { readonly statusCode: number; readonly detail?: unknown }
  ) {
    super(message)
    this.name = 'DetailedError'
    this.statusCode = options.statusCode
    this.detail = options.detail
  }
}

interface TypedResponse<A> {
  readonly request: Promise<Response>
  readonly schema: Schema.Schema<any, any, never>
  readonly _Success?: A
}
type Query = Readonly<object>
type RequestInput<Param extends object = Record<never, never>, Body = never> = {
  readonly param: Param
  readonly query?: Query
  readonly json?: Body
}

const rpcFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init)
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw cause
    }

    const request = input instanceof Request ? input : null
    const url = new URL(
      request?.url ?? String(input),
      globalThis.location?.href ?? 'http://localhost'
    )
    const method = String(init?.method ?? request?.method ?? 'GET')
      .toUpperCase()
      .slice(0, 16)
    throw new RpcNetworkError(method, url.pathname.slice(0, 2_048), cause)
  }
}

function endpoint<A>(
  method: string,
  pathname: string,
  schema: Schema.Schema<any, any, never>,
  options?: { readonly query?: Query; readonly json?: unknown },
  init?: RequestInit
): TypedResponse<A> {
  const url = new URL(pathname, globalThis.location?.href ?? 'http://localhost')
  for (const [key, value] of Object.entries(options?.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }
  const headers = new Headers(init?.headers)
  let body = init?.body
  if (options?.json !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(options.json)
  }

  const request: RequestInit = { ...init, method, headers }
  if (body !== undefined) {
    request.body = body
  }

  return { request: rpcFetch(url, request), schema }
}

export async function parseResponse<A>(
  response: Promise<TypedResponse<A>> | TypedResponse<A>
): Promise<A> {
  const contract = await response
  const resolved = await contract.request
  const data: unknown = await resolved.json().catch(() => null)
  if (!resolved.ok) {
    const failure = decodeUnknownOrNull(apiErrorBodySchema, data)
    throw new DetailedError(
      failure?.error.message ||
        `${resolved.status} ${resolved.statusText}`.trim(),
      {
        statusCode: resolved.status,
        detail: { data, statusText: resolved.statusText }
      }
    )
  }

  const decoded = decodeUnknownOrNull(contract.schema, data)
  if (decoded === null) {
    throw new DetailedError('Treeport returned an invalid response', {
      statusCode: 502,
      detail: { data, statusText: 'Invalid API response' }
    })
  }

  // SAFETY: Every endpoint pairs A with the Effect Schema that decoded data.
  return decoded as A
}

const id = (value: string) => encodeURIComponent(value)

export const rpc = {
  api: {
    presence: {
      $post: (json: PresenceUpdate, init?: RequestInit) =>
        endpoint<{ identity: ViewerIdentity }>(
          'POST',
          '/api/presence',
          presenceResponseSchema,
          { json },
          init
        )
    },
    browser: {
      install: {
        $post: () =>
          endpoint<{ message: string }>(
            'POST',
            '/api/browser/install',
            browserInstallResponseSchema
          )
      }
    },
    projects: Object.assign(
      {
        $get: () =>
          endpoint<{ projects: ProjectRecord[] }>(
            'GET',
            '/api/projects',
            projectsResponseSchema
          ),
        $post: ({ json }: { readonly json: unknown }) =>
          endpoint<{ project: ProjectRecord }>(
            'POST',
            '/api/projects',
            projectResponseSchema,
            { json }
          ),
        recent: {
          $get: () =>
            endpoint<{ projects: RecentProjectRecord[] }>(
              'GET',
              '/api/projects/recent',
              recentProjectsResponseSchema
            )
        }
      },
      {
        ':projectId': {
          close: {
            $post: ({ param }: RequestInput<{ projectId: string }>) =>
              endpoint<{ ok: true }>(
                'POST',
                `/api/projects/${id(param.projectId)}/close`,
                okResponseSchema
              )
          },
          open: {
            $post: ({ param }: RequestInput<{ projectId: string }>) =>
              endpoint<{ project: ProjectRecord }>(
                'POST',
                `/api/projects/${id(param.projectId)}/open`,
                projectResponseSchema
              )
          },
          recent: {
            $delete: ({ param }: RequestInput<{ projectId: string }>) =>
              endpoint<{ ok: true }>(
                'DELETE',
                `/api/projects/${id(param.projectId)}/recent`,
                okResponseSchema
              )
          },
          'worktree-operations': {
            $post: ({
              param,
              json
            }: RequestInput<{ projectId: string }, unknown>) =>
              endpoint<{ operation: OperationRecord }>(
                'POST',
                `/api/projects/${id(param.projectId)}/worktree-operations`,
                operationResponseSchema,
                { json }
              )
          }
        }
      }
    ),
    filesystem: {
      directories: {
        $get: ({ query }: { readonly query: Query }) =>
          endpoint<DirectoryBrowseResponse>(
            'GET',
            '/api/filesystem/directories',
            directoryBrowseResponseSchema,
            { query }
          )
      }
    },
    'terminal-presets': Object.assign(
      {
        $get: () =>
          endpoint<{ presets: TerminalPreset[] }>(
            'GET',
            '/api/terminal-presets',
            terminalPresetsResponseSchema
          ),
        $post: ({ json }: { readonly json: unknown }) =>
          endpoint<{ preset: TerminalPreset }>(
            'POST',
            '/api/terminal-presets',
            terminalPresetResponseSchema,
            { json }
          )
      },
      {
        ':presetId': {
          $patch: ({
            param,
            json
          }: RequestInput<{ presetId: string }, unknown>) =>
            endpoint<{ preset: TerminalPreset }>(
              'PATCH',
              `/api/terminal-presets/${id(param.presetId)}`,
              terminalPresetResponseSchema,
              { json }
            ),
          $delete: ({
            param,
            json
          }: RequestInput<{ presetId: string }, unknown>) =>
            endpoint<{ ok: true }>(
              'DELETE',
              `/api/terminal-presets/${id(param.presetId)}`,
              okResponseSchema,
              { json }
            )
        }
      }
    ),
    'tree-context-fields': {
      $get: ({ query }: { readonly query: Query }) =>
        endpoint<TreeContextFieldListing>(
          'GET',
          '/api/tree-context-fields',
          treeContextFieldListingSchema,
          { query }
        )
    },
    'terminal-preset-definitions': {
      $get: ({ query }: { readonly query: Query }) =>
        endpoint<TerminalPresetDefinitionListing>(
          'GET',
          '/api/terminal-preset-definitions',
          terminalPresetDefinitionListingSchema,
          { query }
        )
    },
    worktrees: {
      ':worktreeId': {
        'web-panel-definitions': Object.assign(
          {
            $get: ({ param }: RequestInput<{ worktreeId: string }>) =>
              endpoint<{ definitions: WebPanelDefinition[] }>(
                'GET',
                `/api/worktrees/${id(param.worktreeId)}/web-panel-definitions`,
                webPanelDefinitionsResponseSchema
              )
          },
          {
            ':definitionId': {
              'permission-grant': {
                $put: ({
                  param,
                  json
                }: RequestInput<
                  { worktreeId: string; definitionId: string },
                  unknown
                >) =>
                  endpoint<{ definition: WebPanelDefinition }>(
                    'PUT',
                    `/api/worktrees/${id(param.worktreeId)}/web-panel-definitions/${id(param.definitionId)}/permission-grant`,
                    webPanelDefinitionResponseSchema,
                    { json }
                  )
              }
            }
          }
        ),
        tabs: {
          open: {
            $post: (
              { param, json }: RequestInput<{ worktreeId: string }, unknown>,
              options?: { readonly init: RequestInit }
            ) =>
              endpoint<OpenWebPanelResult>(
                'POST',
                `/api/worktrees/${id(param.worktreeId)}/tabs/open`,
                openWebPanelResponseSchema,
                { json },
                options?.init
              )
          },
          order: {
            $put: ({
              param,
              json
            }: RequestInput<{ worktreeId: string }, unknown>) =>
              endpoint<{ ok: true }>(
                'PUT',
                `/api/worktrees/${id(param.worktreeId)}/tabs/order`,
                okResponseSchema,
                { json }
              )
          }
        },
        'browser-tabs': {
          $post: ({
            param,
            json
          }: RequestInput<{ worktreeId: string }, unknown>) =>
            endpoint<OpenBrowserTabResult>(
              'POST',
              `/api/worktrees/${id(param.worktreeId)}/browser-tabs`,
              openBrowserTabResponseSchema,
              { json }
            )
        },
        terminals: {
          $post: (
            { param, json }: RequestInput<{ worktreeId: string }, unknown>,
            options?: { readonly init: RequestInit }
          ) =>
            endpoint<{ terminal: TerminalRecord }>(
              'POST',
              `/api/worktrees/${id(param.worktreeId)}/terminals`,
              terminalResponseSchema,
              { json },
              options?.init
            ),
          order: {
            $put: ({
              param,
              json
            }: RequestInput<{ worktreeId: string }, unknown>) =>
              endpoint<{ ok: true }>(
                'PUT',
                `/api/worktrees/${id(param.worktreeId)}/terminals/order`,
                okResponseSchema,
                { json }
              )
          }
        },
        remove: {
          $post: ({
            param,
            json
          }: RequestInput<{ worktreeId: string }, unknown>) =>
            endpoint<{ operation: OperationRecord }>(
              'POST',
              `/api/worktrees/${id(param.worktreeId)}/remove`,
              operationResponseSchema,
              { json }
            )
        },
        'remove-preview': {
          $get: ({ param }: RequestInput<{ worktreeId: string }>) =>
            endpoint<{ preview: RemovePreview }>(
              'GET',
              `/api/worktrees/${id(param.worktreeId)}/remove-preview`,
              removePreviewResponseSchema
            )
        }
      }
    },
    tabs: {
      ':tabId': {
        $delete: (
          { param, query }: RequestInput<{ tabId: string }>,
          init?: RequestInit
        ) =>
          endpoint<{ ok: true }>(
            'DELETE',
            `/api/tabs/${id(param.tabId)}`,
            okResponseSchema,
            query ? { query } : undefined,
            init
          ),
        context: {
          $get: ({ param }: RequestInput<{ tabId: string }>) =>
            endpoint<{ context: WebPanelContext }>(
              'GET',
              `/api/tabs/${id(param.tabId)}/context`,
              webPanelContextResponseSchema
            )
        },
        diff: {
          file: {
            $post: ({
              param,
              json
            }: RequestInput<{ tabId: string }, GitFileDiffRequest>) =>
              endpoint<GitFileDiff>(
                'POST',
                `/api/tabs/${id(param.tabId)}/diff/file`,
                gitFileDiffResponseSchema,
                { json }
              )
          },
          image: {
            $post: ({
              param,
              json
            }: RequestInput<{ tabId: string }, GitDiffImageRequest>) =>
              endpoint<GitDiffImage>(
                'POST',
                `/api/tabs/${id(param.tabId)}/diff/image`,
                gitDiffImageSchema,
                { json }
              )
          },
          $get: ({ param }: RequestInput<{ tabId: string }>) =>
            endpoint<{ diff: GitDiff }>(
              'GET',
              `/api/tabs/${id(param.tabId)}/diff`,
              gitDiffResponseSchema
            )
        },
        network: {
          listeners: {
            $get: ({ param }: RequestInput<{ tabId: string }>) =>
              endpoint<{ discovery: WorktreeListenerDiscovery }>(
                'GET',
                `/api/tabs/${id(param.tabId)}/network/listeners`,
                listenerDiscoveryResponseSchema
              )
          }
        },
        storage: Object.assign(
          {
            $get: ({ param }: RequestInput<{ tabId: string }>) =>
              endpoint<{ hasData: boolean }>(
                'GET',
                `/api/tabs/${id(param.tabId)}/storage`,
                hasDataResponseSchema
              ),
            $put: ({ param, json }: RequestInput<{ tabId: string }, unknown>) =>
              endpoint<{ ok: true }>(
                'PUT',
                `/api/tabs/${id(param.tabId)}/storage`,
                okResponseSchema,
                { json }
              ),
            $delete: ({
              param,
              json
            }: RequestInput<{ tabId: string }, unknown>) =>
              endpoint<{ ok: true }>(
                'DELETE',
                `/api/tabs/${id(param.tabId)}/storage`,
                okResponseSchema,
                { json }
              )
          },
          {
            get: {
              $post: ({
                param,
                json
              }: RequestInput<{ tabId: string }, unknown>) =>
                endpoint<{ found: boolean; value: JsonValue }>(
                  'POST',
                  `/api/tabs/${id(param.tabId)}/storage/get`,
                  storageValueResponseSchema,
                  { json }
                )
            }
          }
        )
      }
    },
    terminals: {
      ':terminalId': {
        $delete: (
          { param }: RequestInput<{ terminalId: string }>,
          options?: { readonly init: RequestInit }
        ) =>
          endpoint<{ ok: true }>(
            'DELETE',
            `/api/terminals/${id(param.terminalId)}`,
            okResponseSchema,
            undefined,
            options?.init
          ),
        bell: {
          acknowledge: {
            $post: ({
              param,
              json
            }: RequestInput<{ terminalId: string }, unknown>) =>
              endpoint<{ ok: true }>(
                'POST',
                `/api/terminals/${id(param.terminalId)}/bell/acknowledge`,
                okResponseSchema,
                { json }
              )
          }
        },
        files: {
          $post: (
            { param }: RequestInput<{ terminalId: string }>,
            options: { readonly init: RequestInit }
          ) =>
            endpoint<{ file: { path: string } }>(
              'POST',
              `/api/terminals/${id(param.terminalId)}/files`,
              uploadedFileResponseSchema,
              undefined,
              options.init
            )
        }
      }
    },
    operations: Object.assign(
      {
        $get: ({ query }: { readonly query: Query }) =>
          endpoint<{ operations: OperationRecord[] }>(
            'GET',
            '/api/operations',
            operationsResponseSchema,
            { query }
          )
      },
      {
        ':operationId': {
          $get: ({ param }: RequestInput<{ operationId: string }>) =>
            endpoint<{ operation: OperationRecord }>(
              'GET',
              `/api/operations/${id(param.operationId)}`,
              operationResponseSchema
            )
        }
      }
    ),
    update: {
      $get: () =>
        endpoint<ApplicationUpdateStatus>(
          'GET',
          '/api/update',
          applicationUpdateStatusSchema
        ),
      $post: () =>
        endpoint<ApplicationUpdateStatus>(
          'POST',
          '/api/update',
          applicationUpdateStatusSchema
        )
    }
  }
}

export const treeFilesRpc = {
  api: {
    tabs: {
      ':tabId': {
        files: Object.assign(
          {
            $get: ({ param }: RequestInput<{ tabId: string }>) =>
              endpoint<TreeFileListing>(
                'GET',
                `/api/tabs/${id(param.tabId)}/files`,
                treeFileListingSchema
              ),
            $put: ({ param, json }: RequestInput<{ tabId: string }, unknown>) =>
              endpoint<TreeFileWriteResult>(
                'PUT',
                `/api/tabs/${id(param.tabId)}/files`,
                treeFileWriteResultSchema,
                { json }
              )
          },
          {
            search: {
              $post: ({
                param,
                json
              }: RequestInput<{ tabId: string }, unknown>) =>
                endpoint<TreeFileSearchResult>(
                  'POST',
                  `/api/tabs/${id(param.tabId)}/files/search`,
                  treeFileSearchResultSchema,
                  { json }
                )
            },
            read: {
              $post: ({
                param,
                json
              }: RequestInput<{ tabId: string }, unknown>) =>
                endpoint<{ path: string; content: string; revision: string }>(
                  'POST',
                  `/api/tabs/${id(param.tabId)}/files/read`,
                  treeFileSchema,
                  { json }
                )
            }
          }
        )
      }
    }
  }
}
