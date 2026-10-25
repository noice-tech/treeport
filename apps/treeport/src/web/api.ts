import {
  appServiceSchema,
  pushConfigResponseSchema,
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
  openBrowserAppResponseSchema,
  openWebAppResponseSchema,
  operationResponseSchema,
  operationsResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  recentProjectsResponseSchema,
  removePreviewResponseSchema,
  storageValueResponseSchema,
  launcherDefinitionListingSchema,
  launcherResponseSchema,
  launchersResponseSchema,
  terminalResponseSchema,
  treeFileListingSchema,
  treeFileSchema,
  treeFileSearchResultSchema,
  treeFileWriteResultSchema,
  uploadedFileResponseSchema,
  webAppContextResponseSchema,
  webAppDefinitionResponseSchema,
  webAppDefinitionsResponseSchema,
  worktreeResponseSchema
} from '@treeport/shared'
import type * as Schema from 'effect/Schema'
import type {
  AppService,
  WebPushSubscription,
  PresenceUpdate,
  ViewerIdentity,
  DirectoryBrowseResponse,
  GitDiff,
  GitDiffRequest,
  GitFileDiff,
  GitFileDiffRequest,
  GitDiffImage,
  GitDiffImageRequest,
  JsonValue,
  OpenBrowserAppResult,
  OpenWebAppResult,
  OperationRecord,
  ProjectRecord,
  RecentProjectRecord,
  RemovePreview,
  Launcher,
  LauncherDefinitionListing,
  TerminalRecord,
  TreeFileListing,
  TreeFileSearchResult,
  TreeFileWriteResult,
  WebAppContext,
  WebAppDefinition,
  WorktreeListenerDiscovery,
  WorktreeRecord
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

// EXTERNAL: XHR exposes bytes sent; fetch does not provide upload progress events.
function uploadRequest(
  url: URL,
  init: RequestInit & { readonly body: File },
  onProgress: (bytes: number) => void
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    let stalled: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (stalled !== null) {
        clearTimeout(stalled)
      }

      init.signal?.removeEventListener('abort', abort)
      request.onload = null
      request.onerror = null
      request.onabort = null
      request.onprogress = null
      request.upload.onprogress = null
    }

    const fail = (error: Error) => {
      cleanup()
      request.abort()
      reject(error)
    }

    const abort = () => fail(new DOMException('Upload cancelled', 'AbortError'))

    const resetStallTimer = () => {
      if (stalled !== null) {
        clearTimeout(stalled)
      }

      stalled = setTimeout(
        () => fail(new Error('Upload stalled for 2 minutes')),
        120_000
      )
    }

    request.open('POST', url.href)
    new Headers(init.headers).forEach((value, name) =>
      request.setRequestHeader(name, value)
    )
    request.upload.onprogress = (event) => {
      onProgress(event.loaded)
      resetStallTimer()
    }

    request.onprogress = resetStallTimer
    request.onerror = () =>
      fail(
        new RpcNetworkError('POST', url.pathname, new Error('Upload failed'))
      )
    request.onabort = abort
    request.onload = () => {
      cleanup()
      resolve(
        new Response(request.responseText || null, {
          status: request.status,
          statusText: request.statusText
        })
      )
    }

    init.signal?.addEventListener('abort', abort, { once: true })

    if (init.signal?.aborted) {
      abort()

      return
    }

    resetStallTimer()
    request.send(init.body)
  })
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
    push: {
      config: {
        $get: () =>
          endpoint<{ publicKey: string }>(
            'GET',
            '/api/push/config',
            pushConfigResponseSchema
          )
      },
      subscribe: {
        $post: (json: WebPushSubscription) =>
          endpoint<{ ok: true }>(
            'POST',
            '/api/push/subscribe',
            okResponseSchema,
            { json }
          )
      },
      unsubscribe: {
        $post: (endpointUrl: string) =>
          endpoint<{ ok: true }>(
            'POST',
            '/api/push/unsubscribe',
            okResponseSchema,
            { json: { endpoint: endpointUrl } }
          )
      }
    },
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
    files: {
      $post: (options: {
        readonly init: RequestInit & { readonly body: File }
        readonly onProgress: (bytes: number) => void
      }): TypedResponse<{ file: { path: string } }> => ({
        request: uploadRequest(
          new URL(
            '/api/files',
            globalThis.location?.href ?? 'http://localhost'
          ),
          options.init,
          options.onProgress
        ),
        schema: uploadedFileResponseSchema
      })
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
    launchers: Object.assign(
      {
        $get: () =>
          endpoint<{ launchers: Launcher[] }>(
            'GET',
            '/api/launchers',
            launchersResponseSchema
          ),
        $post: ({ json }: { readonly json: unknown }) =>
          endpoint<{ launcher: Launcher }>(
            'POST',
            '/api/launchers',
            launcherResponseSchema,
            { json }
          )
      },
      {
        ':launcherId': {
          $patch: ({
            param,
            json
          }: RequestInput<{ launcherId: string }, unknown>) =>
            endpoint<{ launcher: Launcher }>(
              'PATCH',
              `/api/launchers/${id(param.launcherId)}`,
              launcherResponseSchema,
              { json }
            ),
          $delete: ({
            param,
            json
          }: RequestInput<{ launcherId: string }, unknown>) =>
            endpoint<{ ok: true }>(
              'DELETE',
              `/api/launchers/${id(param.launcherId)}`,
              okResponseSchema,
              { json }
            )
        }
      }
    ),
    'launcher-definitions': {
      $get: ({ query }: { readonly query: Query }) =>
        endpoint<LauncherDefinitionListing>(
          'GET',
          '/api/launcher-definitions',
          launcherDefinitionListingSchema,
          { query }
        )
    },
    worktrees: {
      ':worktreeId': {
        $patch: ({
          param,
          json
        }: RequestInput<{ worktreeId: string }, unknown>) =>
          endpoint<{ worktree: WorktreeRecord }>(
            'PATCH',
            `/api/worktrees/${id(param.worktreeId)}`,
            worktreeResponseSchema,
            { json }
          ),
        'web-app-definitions': Object.assign(
          {
            $get: ({ param }: RequestInput<{ worktreeId: string }>) =>
              endpoint<{ definitions: WebAppDefinition[] }>(
                'GET',
                `/api/worktrees/${id(param.worktreeId)}/web-app-definitions`,
                webAppDefinitionsResponseSchema
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
                  endpoint<{ definition: WebAppDefinition }>(
                    'PUT',
                    `/api/worktrees/${id(param.worktreeId)}/web-app-definitions/${id(param.definitionId)}/permission-grant`,
                    webAppDefinitionResponseSchema,
                    { json }
                  )
              }
            }
          }
        ),
        apps: {
          open: {
            $post: (
              { param, json }: RequestInput<{ worktreeId: string }, unknown>,
              options?: { readonly init: RequestInit }
            ) =>
              endpoint<OpenWebAppResult>(
                'POST',
                `/api/worktrees/${id(param.worktreeId)}/apps/open`,
                openWebAppResponseSchema,
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
                `/api/worktrees/${id(param.worktreeId)}/apps/order`,
                okResponseSchema,
                { json }
              )
          }
        },
        'browser-apps': {
          $post: ({
            param,
            json
          }: RequestInput<{ worktreeId: string }, unknown>) =>
            endpoint<OpenBrowserAppResult>(
              'POST',
              `/api/worktrees/${id(param.worktreeId)}/browser-apps`,
              openBrowserAppResponseSchema,
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
    apps: {
      ':appId': {
        $delete: (
          { param, query }: RequestInput<{ appId: string }>,
          init?: RequestInit
        ) =>
          endpoint<{ ok: true }>(
            'DELETE',
            `/api/apps/${id(param.appId)}`,
            okResponseSchema,
            query ? { query } : undefined,
            init
          ),
        services: {
          $post: ({
            param,
            json
          }: RequestInput<
            { appId: string; action: 'ensure' | 'status' | 'stop' },
            { name: string }
          >) =>
            endpoint<AppService>(
              'POST',
              `/api/apps/${id(param.appId)}/services/${param.action}`,
              appServiceSchema,
              { json }
            )
        },
        context: {
          $get: ({ param }: RequestInput<{ appId: string }>) =>
            endpoint<{ context: WebAppContext }>(
              'GET',
              `/api/apps/${id(param.appId)}/context`,
              webAppContextResponseSchema
            )
        },
        diff: {
          file: {
            $post: ({
              param,
              json
            }: RequestInput<{ appId: string }, GitFileDiffRequest>) =>
              endpoint<GitFileDiff>(
                'POST',
                `/api/apps/${id(param.appId)}/diff/file`,
                gitFileDiffResponseSchema,
                { json }
              )
          },
          image: {
            $post: ({
              param,
              json
            }: RequestInput<{ appId: string }, GitDiffImageRequest>) =>
              endpoint<GitDiffImage>(
                'POST',
                `/api/apps/${id(param.appId)}/diff/image`,
                gitDiffImageSchema,
                { json }
              )
          },
          $get: ({
            param,
            query
          }: RequestInput<{ appId: string }> & { query?: GitDiffRequest }) =>
            endpoint<{ diff: GitDiff }>(
              'GET',
              `/api/apps/${id(param.appId)}/diff`,
              gitDiffResponseSchema,
              query ? { query } : undefined
            )
        },
        network: {
          listeners: {
            $get: ({ param }: RequestInput<{ appId: string }>) =>
              endpoint<{ discovery: WorktreeListenerDiscovery }>(
                'GET',
                `/api/apps/${id(param.appId)}/network/listeners`,
                listenerDiscoveryResponseSchema
              )
          }
        },
        storage: Object.assign(
          {
            $get: ({ param }: RequestInput<{ appId: string }>) =>
              endpoint<{ hasData: boolean }>(
                'GET',
                `/api/apps/${id(param.appId)}/storage`,
                hasDataResponseSchema
              ),
            $put: ({ param, json }: RequestInput<{ appId: string }, unknown>) =>
              endpoint<{ ok: true }>(
                'PUT',
                `/api/apps/${id(param.appId)}/storage`,
                okResponseSchema,
                { json }
              ),
            $delete: ({
              param,
              json
            }: RequestInput<{ appId: string }, unknown>) =>
              endpoint<{ ok: true }>(
                'DELETE',
                `/api/apps/${id(param.appId)}/storage`,
                okResponseSchema,
                { json }
              )
          },
          {
            get: {
              $post: ({
                param,
                json
              }: RequestInput<{ appId: string }, unknown>) =>
                endpoint<{ found: boolean; value: JsonValue }>(
                  'POST',
                  `/api/apps/${id(param.appId)}/storage/get`,
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
        $get: ({ param }: RequestInput<{ terminalId: string }>) =>
          endpoint<{ terminal: TerminalRecord }>(
            'GET',
            `/api/terminals/${id(param.terminalId)}`,
            terminalResponseSchema
          ),
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
        attention: {
          acknowledge: {
            $post: ({
              param,
              json
            }: RequestInput<{ terminalId: string }, unknown>) =>
              endpoint<{ ok: true }>(
                'POST',
                `/api/terminals/${id(param.terminalId)}/attention/acknowledge`,
                okResponseSchema,
                { json }
              )
          }
        },
        files: {
          $post: (
            { param }: RequestInput<{ terminalId: string }>,
            options: {
              readonly init: RequestInit & { readonly body: File }
              readonly onProgress: (bytes: number) => void
            }
          ): TypedResponse<{ file: { path: string } }> => ({
            request: uploadRequest(
              new URL(
                `/api/terminals/${id(param.terminalId)}/files`,
                globalThis.location?.href ?? 'http://localhost'
              ),
              options.init,
              options.onProgress
            ),
            schema: uploadedFileResponseSchema
          })
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
    apps: {
      ':appId': {
        files: Object.assign(
          {
            $get: ({ param }: RequestInput<{ appId: string }>) =>
              endpoint<TreeFileListing>(
                'GET',
                `/api/apps/${id(param.appId)}/files`,
                treeFileListingSchema
              ),
            $put: ({ param, json }: RequestInput<{ appId: string }, unknown>) =>
              endpoint<TreeFileWriteResult>(
                'PUT',
                `/api/apps/${id(param.appId)}/files`,
                treeFileWriteResultSchema,
                { json }
              )
          },
          {
            search: {
              $post: ({
                param,
                json
              }: RequestInput<{ appId: string }, unknown>) =>
                endpoint<TreeFileSearchResult>(
                  'POST',
                  `/api/apps/${id(param.appId)}/files/search`,
                  treeFileSearchResultSchema,
                  { json }
                )
            },
            read: {
              $post: ({
                param,
                json
              }: RequestInput<{ appId: string }, unknown>) =>
                endpoint<{ path: string; content: string; revision: string }>(
                  'POST',
                  `/api/apps/${id(param.appId)}/files/read`,
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
