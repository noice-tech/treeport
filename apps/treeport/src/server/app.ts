import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as NodeHttpServerRequest from '@effect/platform-node/NodeHttpServerRequest'
import * as HttpApp from '@effect/platform/HttpApp'
import * as HttpRouter from '@effect/platform/HttpRouter'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import {
  appServiceSchema,
  appServiceRequestSchema,
  pushConfigResponseSchema,
  pushSubscriptionSchema,
  pushUnsubscribeSchema,
  presenceUpdateSchema,
  presenceResponseSchema,
  apiErrorBodySchema,
  applicationUpdateStatusSchema,
  browseDirectoryQuerySchema,
  browserAgentCommandSchema,
  browserAgentResponseSchema,
  browserInstallStatusSchema,
  browserInstallResponseSchema,
  browserOwnerTicketRequestSchema,
  browserOwnerTicketResponseSchema,
  browserTicketRequestSchema,
  browserTicketResponseSchema,
  createBrowserAppSchema,
  createLauncherSchema,
  createTerminalSchema,
  createWorktreeSchema,
  createWebAppSchema,
  deleteAppQuerySchema,
  deleteLauncherSchema,
  deleteWebAppStorageSchema,
  DESKTOP_PROTOCOL_VERSION,
  directoryBrowseResponseSchema,
  getWebAppStorageSchema,
  healthResponseSchema,
  phoneAccessResponseSchema,
  workspaceActivityResponseSchema,
  openBrowserAppFromTerminalSchema,
  openBrowserAppResponseSchema,
  openWebAppResponseSchema,
  openWebAppSchema,
  operationQuerySchema,
  operationResponseSchema,
  operationsResponseSchema,
  packageInstallSchema,
  packageListingResponseSchema,
  packageOperationResponseSchema,
  packageOperationsResponseSchema,
  packageProjectQuerySchema,
  packageProjectResponseSchema,
  packageReloadResponseSchema,
  packageReloadSchema,
  packageRemoveSchema,
  packageUpdateSchema,
  projectResponseSchema,
  projectsResponseSchema,
  readTreeFileSchema,
  recentProjectsResponseSchema,
  removePreviewResponseSchema,
  registerProjectSchema,
  removeWorktreeSchema,
  reorderWorkspaceItemsSchema,
  requestWorkspaceOpenSchema,
  searchTreeFilesSchema,
  setWebAppStorageSchema,
  storageValueResponseSchema,
  terminalAttentionAcknowledgementSchema,
  terminalCaptureQuerySchema,
  terminalCaptureResponseSchema,
  terminalObservationResponseSchema,
  launcherDefinitionListingSchema,
  launcherDefinitionsQuerySchema,
  launcherResponseSchema,
  launchersResponseSchema,
  terminalResponseSchema,
  TERMINAL_MAX_UPLOAD_BYTES,
  terminatedTerminalsResponseSchema,
  treeFileListingSchema,
  treeFileSchema,
  treeFileSearchResultSchema,
  treeFileWriteResultSchema,
  uploadedFileResponseSchema,
  updateProjectSchema,
  updateWorktreeTitleSchema,
  setTreeDecorationSchema,
  packageServiceProjectsResponseSchema,
  packageServiceSelfResponseSchema,
  TREE_DECORATION_KEY_PATTERN,
  updateLauncherSchema,
  updateTerminalSchema,
  updateWebAppPermissionGrantSchema,
  webAppContextResponseSchema,
  webAppDefinitionResponseSchema,
  webAppDefinitionsResponseSchema,
  webAppResponseSchema,
  worktreeResponseSchema,
  worktreesResponseSchema,
  gitDiffResponseSchema,
  gitFileDiffRequestSchema,
  gitDiffRequestSchema,
  gitFileDiffResponseSchema,
  gitDiffImageRequestSchema,
  gitDiffImageSchema,
  hasDataResponseSchema,
  listenerDiscoveryResponseSchema,
  okResponseSchema,
  writeTreeFileSchema,
  type ApiErrorBody,
  type TreeportEvent
} from '@treeport/shared'
import * as Headers from '@effect/platform/Headers'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Either from 'effect/Either'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as ParseResult from 'effect/ParseResult'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import type {
  AppConfig,
  TerminalSessionBackend,
  TreeportService
} from './core/index'
import { DomainError } from './core/index'
import type { ApplicationServices } from './core/services/infrastructure/application-runtime'
import {
  webAppBrowserOrigin,
  webAppContentSecurityPolicy
} from './core/web-app-csp'
import type { ApplicationUpdateManager } from './application-update'
import type { TerminalMetadataManager } from './terminal-metadata'
import type { BrowserSessionManager } from './browser-sessions'
import { authenticatedViewers, isLoopbackAddress } from './request-security'
import type { WorkspacePresenceManager } from './workspace-presence'
import type { WebPushManager } from './web-push'
import { findProjectIcon } from './project-icon'
import type { AppServices } from './app-services'
import { networkTelemetry } from './network-telemetry'

const UPLOAD_MIME_EXTENSIONS = new Map([
  ['application/pdf', 'pdf'],
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/svg+xml', 'svg'],
  ['image/webp', 'webp'],
  ['text/plain', 'txt']
])

const UPLOAD_RETENTION_MS = 24 * 60 * 60_000
const UPLOAD_DIRECTORY_MAX_BYTES = 10 * 1024 * 1024 * 1024

interface UploadFileInfo {
  path: string
  size: number
  mtimeMs: number
}

async function pruneTerminalUploads(
  directory: string,
  preservePaths: ReadonlySet<string>
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true })

  const files = (
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && entry.name.startsWith('treeport-upload-')
        )
        .map(async (entry): Promise<UploadFileInfo | null> => {
          const filePath = path.join(directory, entry.name)

          return fs
            .stat(filePath)
            .then((stat) => ({
              path: filePath,
              size: stat.size,
              mtimeMs: stat.mtimeMs
            }))
            .catch(() => null)
        })
    )
  )
    .filter((file): file is UploadFileInfo => file !== null)
    .sort((left, right) => {
      if (preservePaths.has(left.path) !== preservePaths.has(right.path)) {
        return preservePaths.has(left.path) ? -1 : 1
      }

      return right.mtimeMs - left.mtimeMs
    })

  const expiredBefore = Date.now() - UPLOAD_RETENTION_MS
  let retainedBytes = 0

  for (const file of files) {
    const expired = file.mtimeMs < expiredBefore
    const overQuota = retainedBytes + file.size > UPLOAD_DIRECTORY_MAX_BYTES

    if (!preservePaths.has(file.path) && (expired || overQuota)) {
      await fs.rm(file.path, { force: true })
      continue
    }

    retainedBytes += file.size
  }
}

interface AppDependencies {
  service: TreeportService
  config: AppConfig
  terminalHost: TerminalSessionBackend
  applicationUpdate: ApplicationUpdateManager
  terminalMetadata: TerminalMetadataManager
  appServices?: AppServices
  browserSessions?: BrowserSessionManager
  presence: WorkspacePresenceManager
  push?: WebPushManager
  rpcHttpApp?: HttpApp.Default<never, Scope.Scope>
  webDist?: string
}

type AppEffect<A> = Effect.Effect<A, unknown, ApplicationServices>

type RouteEffect<A> = Effect.Effect<
  A,
  unknown,
  | ApplicationServices
  | HttpRouter.RouteContext
  | HttpServerRequest.HttpServerRequest
  | HttpServerRequest.ParsedSearchParams
  | Scope.Scope
>

function operation<A>(
  evaluate: () =>
    | Effect.Effect<A, unknown, ApplicationServices>
    | PromiseLike<A>
    | A
): AppEffect<A> {
  return Effect.try({ try: evaluate, catch: (cause) => cause }).pipe(
    Effect.flatMap((value) =>
      Effect.isEffect(value)
        ? value
        : Effect.tryPromise({
            try: () => Promise.resolve(value),
            catch: (cause) => cause
          })
    )
  )
}

function jsonContractResponse<S extends Schema.Schema<any, any, never>>(
  schema: S,
  // eslint-disable-next-line anti-slop/no-unknown-parameters -- The supplied Effect Schema validates this response boundary before serialization.
  body: unknown,
  status = 200,
  headers?: Record<string, string>
) {
  const decoded = Schema.decodeUnknownEither(schema, {
    onExcessProperty: 'error'
  })(body)

  if (Either.isLeft(decoded)) {
    throw new Error(
      `Server response violated its network schema: ${ParseResult.TreeFormatter.formatErrorSync(
        decoded.left
      )}`
    )
  }

  return HttpServerResponse.unsafeJson(decoded.right, { status, headers })
}

function requestBody<S extends Schema.Schema<any, any, never>>(schema: S) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest

    const value = yield* request.json.pipe(
      Effect.mapError(
        () =>
          new DomainError(
            'INVALID_JSON',
            'Request body must be valid JSON',
            400
          )
      )
    )

    const parsed = Schema.decodeUnknownEither(schema, {
      onExcessProperty: 'error'
    })(value)

    if (Either.isLeft(parsed)) {
      return yield* Effect.fail(
        new DomainError(
          'VALIDATION_ERROR',
          'Request validation failed',
          400,
          ParseResult.ArrayFormatter.formatErrorSync(parsed.left)
        )
      )
    }

    return parsed.right
  })
}

function requestQuery<S extends Schema.Schema<any, any, never>>(
  schema: S,
  errorCode = 'VALIDATION_ERROR',
  errorMessage = 'Request validation failed'
) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, 'http://treeport.local')
    const value = Object.fromEntries(url.searchParams)

    const parsed = Schema.decodeUnknownEither(schema, {
      onExcessProperty: 'error'
    })(value)

    if (Either.isLeft(parsed)) {
      return yield* Effect.fail(new DomainError(errorCode, errorMessage, 400))
    }

    return parsed.right
  })
}

const routeParams = HttpRouter.params
const serverRequest = HttpServerRequest.HttpServerRequest

function route(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*',
  routePath: `/${string}` | '*',
  handler: RouteEffect<HttpServerResponse.HttpServerResponse>
) {
  return HttpRouter.makeRoute(method, routePath, handler)
}

function contentType(filePath: string): string {
  const types = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.gif', 'image/gif'],
    ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.webp', 'image/webp'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
    ['.webmanifest', 'application/manifest+json']
  ])

  return (
    types.get(path.extname(filePath).toLowerCase()) ??
    'application/octet-stream'
  )
}

function fileResponse(
  filePath: string,
  headers: Record<string, string> = {}
): AppEffect<HttpServerResponse.HttpServerResponse> {
  return operation(() => fs.readFile(filePath)).pipe(
    Effect.map((body) =>
      HttpServerResponse.uint8Array(body, {
        headers: { 'content-type': contentType(filePath), ...headers }
      })
    ),
    Effect.catchAll(() =>
      Effect.succeed(HttpServerResponse.empty({ status: 404 }))
    )
  )
}

export interface TreeportHttpApp {
  readonly httpApp: HttpApp.Default<unknown, ApplicationServices>
  request(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

export function createApp({
  service,
  config,
  terminalHost,
  applicationUpdate,
  terminalMetadata: metadata,
  browserSessions,
  appServices,
  presence,
  push,
  rpcHttpApp,
  webDist
}: AppDependencies): TreeportHttpApp {
  const activeUploadPaths = new Set<string>()

  const webAppAsset = Effect.gen(function* () {
    const params = yield* routeParams
    const request = yield* serverRequest
    const pathname = new URL(request.url, 'http://treeport.local').pathname
    const marker = `/api/web-apps/${encodeURIComponent(params.appId!)}/assets/`
    const markerStart = pathname.indexOf(marker)

    const requestedPath =
      markerStart < 0
        ? ''
        : decodeURI(pathname.slice(markerStart + marker.length))

    const resolution = yield* operation(() =>
      service.apps.resolveWebAppAsset(params.appId!, requestedPath)
    )

    if (resolution.kind === 'redirect') {
      return HttpServerResponse.redirect(resolution.location, {
        status: 307,
        headers: { 'cache-control': 'no-store' }
      })
    }

    const browserOrigin = webAppBrowserOrigin({
      referrer: request.headers.referer,
      forwardedHost: request.headers['x-forwarded-host'],
      host: request.headers.host,
      forwardedProtocol: request.headers['x-forwarded-proto'],
      requestProtocol: new URL(request.url, config.apiUrl).protocol
    })

    const commonHeaders = {
      'cache-control':
        resolution.kind === 'error'
          ? 'no-store'
          : 'public, max-age=31536000, immutable',
      'content-security-policy': webAppContentSecurityPolicy(
        resolution.kind === 'error' ? 'error' : 'immutable',
        browserOrigin,
        resolution.allowNetworkRequests
      ),
      'x-content-type-options': 'nosniff'
    }

    if (resolution.kind === 'error') {
      return HttpServerResponse.html(resolution.html).pipe(
        HttpServerResponse.setStatus(500),
        HttpServerResponse.setHeaders({
          ...commonHeaders,
          'content-type': 'text/html; charset=utf-8'
        })
      )
    }

    const body = yield* operation(() => fs.readFile(resolution.path))

    return HttpServerResponse.uint8Array(body, {
      headers: {
        ...commonHeaders,
        'content-type': contentType(resolution.path),
        'access-control-allow-origin': '*'
      }
    })
  })

  // A package service authenticates with the token Treeport started it with.
  const requirePackageAccess = Effect.gen(function* () {
    const request = yield* serverRequest

    const token = /^Bearer (\S+)$/u.exec(
      request.headers.authorization ?? ''
    )?.[1]

    const access = token ? (appServices?.access(token) ?? null) : null

    if (!token || !access) {
      return yield* Effect.fail(
        new DomainError(
          'INVALID_PACKAGE_TOKEN',
          'The package token is invalid or its package was removed',
          401
        )
      )
    }

    return { token, access }
  })

  const pushIdentity = Effect.gen(function* () {
    const request = yield* serverRequest

    const identity = authenticatedViewers.get(
      NodeHttpServerRequest.toIncomingMessage(request)
    )?.account

    if (!identity) {
      return yield* Effect.fail(
        new DomainError(
          'AUTHENTICATION_REQUIRED',
          'An authenticated request is required',
          401
        )
      )
    }

    return identity
  })

  const routes = [
    ...(push
      ? [
          route(
            'GET',
            '/api/push/config',
            Effect.gen(function* () {
              yield* pushIdentity

              return jsonContractResponse(
                pushConfigResponseSchema,
                { publicKey: push.publicKey },
                200,
                { 'cache-control': 'no-store' }
              )
            })
          ),
          route(
            'POST',
            '/api/push/subscribe',
            Effect.gen(function* () {
              const identity = yield* pushIdentity
              const subscription = yield* requestBody(pushSubscriptionSchema)
              yield* operation(() =>
                push.update(identity, subscription, subscription.endpoint)
              )

              return jsonContractResponse(okResponseSchema, { ok: true })
            })
          ),
          route(
            'POST',
            '/api/push/unsubscribe',
            Effect.gen(function* () {
              const identity = yield* pushIdentity
              const body = yield* requestBody(pushUnsubscribeSchema)
              yield* operation(() => push.update(identity, null, body.endpoint))

              return jsonContractResponse(okResponseSchema, { ok: true })
            })
          )
        ]
      : []),
    route(
      'POST',
      '/api/presence',
      Effect.gen(function* () {
        const request = yield* serverRequest

        const identity = authenticatedViewers.get(
          NodeHttpServerRequest.toIncomingMessage(request)
        )?.account

        if (!identity) {
          return yield* Effect.fail(
            new DomainError(
              'AUTHENTICATION_REQUIRED',
              'An authenticated request is required',
              401
            )
          )
        }

        const body = yield* requestBody(presenceUpdateSchema)

        if (body.worktreeId !== null) {
          const worktree = yield* operation(() =>
            service.projects.getWorktreeSnapshot(body.worktreeId!)
          )

          if (
            body.focusedAppId !== null &&
            !worktree.workspaceItems.some((app) => app.id === body.focusedAppId)
          ) {
            return yield* Effect.fail(
              new DomainError(
                'INVALID_PRESENCE_APP',
                'The focused app must belong to this tree',
                400
              )
            )
          }
        } else if (body.focusedAppId !== null) {
          return yield* Effect.fail(
            new DomainError(
              'INVALID_PRESENCE_APP',
              'A focused app requires a tree',
              400
            )
          )
        }

        yield* operation(() => presence.update(identity, body))

        return jsonContractResponse(presenceResponseSchema, { identity }, 200, {
          'cache-control': 'no-store'
        })
      })
    ),
    route(
      'GET',
      '/api/apps/:appId/files',
      Effect.gen(function* () {
        const params = yield* routeParams

        return jsonContractResponse(
          treeFileListingSchema,
          yield* operation(() => service.treeFiles.listTreeFiles(params.appId!))
        )
      })
    ),
    route(
      'POST',
      '/api/apps/:appId/files/search',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(searchTreeFilesSchema)

        return jsonContractResponse(
          treeFileSearchResultSchema,
          yield* operation(() =>
            service.treeFiles.searchTreeFiles(params.appId!, body.query)
          )
        )
      })
    ),
    route(
      'POST',
      '/api/apps/:appId/files/read',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(readTreeFileSchema)

        return jsonContractResponse(
          treeFileSchema,
          yield* operation(() =>
            service.treeFiles.readTreeFile(params.appId!, body.path)
          )
        )
      })
    ),
    route(
      'PUT',
      '/api/apps/:appId/files',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(writeTreeFileSchema)

        return jsonContractResponse(
          treeFileWriteResultSchema,
          yield* operation(() =>
            service.treeFiles.writeTreeFile(params.appId!, body)
          )
        )
      })
    ),

    route(
      'POST',
      '/api/browser/install',
      Effect.gen(function* () {
        if (!browserSessions) {
          return yield* Effect.fail(
            new DomainError(
              'BROWSER_UNAVAILABLE',
              'Hosted browser service is unavailable',
              503
            )
          )
        }

        return jsonContractResponse(browserInstallResponseSchema, {
          message: yield* operation(() => browserSessions.install())
        })
      })
    ),
    route(
      'GET',
      '/api/browser/status',
      Effect.gen(function* () {
        if (!browserSessions) {
          return yield* Effect.fail(
            new DomainError(
              'BROWSER_UNAVAILABLE',
              'Hosted browser service is unavailable',
              503
            )
          )
        }

        return jsonContractResponse(
          browserInstallStatusSchema,
          yield* operation(() => browserSessions.status())
        )
      })
    ),
    route(
      'PUT',
      '/api/worktrees/:worktreeId/web-app-definitions/:definitionId/permission-grant',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(updateWebAppPermissionGrantSchema)

        const definition = yield* operation(() =>
          service.apps.setWebAppPermissionGrant(
            params.worktreeId!,
            params.definitionId!,
            body.granted,
            [...body.permissions]
          )
        )

        return jsonContractResponse(webAppDefinitionResponseSchema, {
          definition
        })
      })
    ),
    route(
      'POST',
      '/api/apps/:appId/browser-agent',
      Effect.gen(function* () {
        if (!browserSessions) {
          return yield* Effect.fail(
            new DomainError(
              'BROWSER_UNAVAILABLE',
              'Hosted browser service is unavailable',
              503
            )
          )
        }

        const params = yield* routeParams
        const input = yield* requestBody(browserAgentCommandSchema)

        const output = yield* operation(() =>
          browserSessions.agentCommand(params.appId!, input)
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof DomainError
              ? cause
              : new DomainError(
                  'BROWSER_COMMAND_FAILED',
                  cause instanceof Error
                    ? cause.message
                    : 'The Browser command failed.',
                  409,
                  {
                    command: input.command,
                    recovery:
                      input.command === 'snapshot'
                        ? `Retry \`treeport browser snapshot --app ${params.appId}\`.`
                        : input.command === 'screenshot'
                          ? `Open Browser ${params.appId} in Treeport, then retry the screenshot.`
                          : `Run \`treeport browser snapshot --app ${params.appId}\`, then retry this Browser command.`
                  }
                )
          )
        )

        return jsonContractResponse(browserAgentResponseSchema, { output })
      })
    ),
    route(
      'POST',
      '/api/apps/:appId/browser-owner-ticket',
      Effect.gen(function* () {
        if (!browserSessions) {
          return yield* Effect.fail(
            new DomainError(
              'BROWSER_UNAVAILABLE',
              'Browser service is unavailable',
              503
            )
          )
        }

        const params = yield* routeParams
        const request = yield* serverRequest
        const body = yield* requestBody(browserOwnerTicketRequestSchema)
        const remoteAddress = Option.getOrNull(request.remoteAddress)

        const proxiedIdentity = [
          'tailscale-user-login',
          'tailscale-user-name',
          'tailscale-user-profile-pic'
        ].some((name) => request.headers[name] !== undefined)

        if (!isLoopbackAddress(remoteAddress ?? undefined) || proxiedIdentity) {
          return yield* Effect.fail(
            new DomainError(
              'BROWSER_LOCAL_OWNER_REQUIRED',
              'Only a local desktop app can own this Browser.',
              403
            )
          )
        }

        return jsonContractResponse(
          browserOwnerTicketResponseSchema,
          yield* operation(() =>
            browserSessions.issueOwnerTicket(params.appId!, body.clientId)
          )
        )
      })
    ),
    route(
      'POST',
      '/api/apps/:appId/browser-ticket',
      Effect.gen(function* () {
        if (!browserSessions) {
          return yield* Effect.fail(
            new DomainError(
              'BROWSER_UNAVAILABLE',
              'Hosted browser service is unavailable',
              503
            )
          )
        }

        const params = yield* routeParams
        const body = yield* requestBody(browserTicketRequestSchema)
        const request = yield* serverRequest

        const identity = authenticatedViewers.get(
          NodeHttpServerRequest.toIncomingMessage(request)
        )

        if (!identity) {
          return yield* Effect.fail(
            new DomainError(
              'AUTHENTICATION_REQUIRED',
              'An authenticated request is required',
              401
            )
          )
        }

        return jsonContractResponse(browserTicketResponseSchema, {
          ticket: yield* operation(() =>
            browserSessions.issueTicket(
              params.appId!,
              body.clientId,
              body.visible,
              identity
            )
          )
        })
      })
    ),

    route(
      'GET',
      '/api/health',
      Effect.succeed(
        jsonContractResponse(healthResponseSchema, {
          ok: true,
          version: config.appVersion ?? 'development',
          protocolVersion: DESKTOP_PROTOCOL_VERSION,
          hostname: os.hostname(),
          pid: process.pid,
          instanceId: config.instanceId ?? null,
          installationMethod: config.installationMethod ?? 'development',
          daemonLifecycle: config.daemonLifecycle,
          url: config.apiUrl
        })
      )
    ),
    route(
      'GET',
      '/api/activity',
      Effect.gen(function* () {
        const projects = yield* operation(() => service.projects.listProjects())
        let working = 0
        let needsAttention = 0

        for (const project of projects) {
          for (const worktree of project.worktrees) {
            for (const terminal of worktree.terminals) {
              const runtime = metadata.get(terminal.id)

              if (terminal.status !== 'running' || !runtime.program) {
                continue
              }

              // A read done or error outcome needs nothing more from the user.
              if (
                runtime.attention?.unread ||
                runtime.activity.state === 'blocked'
              ) {
                needsAttention += 1
              } else if (runtime.activity.state === 'working') {
                working += 1
              }
            }
          }
        }

        return jsonContractResponse(
          workspaceActivityResponseSchema,
          { working, needsAttention },
          200,
          { 'cache-control': 'no-store' }
        )
      })
    ),
    route(
      'GET',
      '/api/phone-access',
      operation(async () => {
        if (config.remoteUrl || config.daemonLifecycle === 'external') {
          return config.remoteUrl
        }

        // Read the URL recorded by remote enable/disable so changes are visible
        // without restarting. Never inspect Tailscale or infer reachability here.
        const saved = await fs
          .readFile(path.join(config.dataDir, 'config.json'), 'utf8')
          .then((value) =>
            Schema.decodeUnknownOption(
              Schema.Struct({
                remote: Schema.optional(
                  Schema.Struct({
                    target: Schema.String,
                    url: Schema.optional(Schema.String)
                  })
                )
              })
            )(JSON.parse(value))
          )
          .catch(() => Option.none())

        const remote = Option.getOrNull(saved)?.remote

        return remote?.target === config.apiUrl.replace(/\/$/, '')
          ? (remote.url ?? null)
          : null
      }).pipe(
        Effect.map((url) => ({
          url,
          error: url
            ? null
            : config.daemonLifecycle === 'external'
              ? 'No remote address is configured for this instance. Configure remote access through the process that started Treeport.'
              : 'No remote address is configured for this instance. Run treeport remote enable on this computer, then retry.',
          setupCommand:
            !url && config.daemonLifecycle !== 'external'
              ? 'treeport remote enable'
              : null
        })),
        Effect.map((body) =>
          jsonContractResponse(phoneAccessResponseSchema, body, 200, {
            'cache-control': 'no-store'
          })
        )
      )
    ),
    route(
      'GET',
      '/api/update',
      operation(() => applicationUpdate.status()).pipe(
        Effect.map((body) =>
          jsonContractResponse(applicationUpdateStatusSchema, body, 200, {
            'cache-control': 'no-store'
          })
        )
      )
    ),
    route(
      'POST',
      '/api/update',
      operation(() => applicationUpdate.start()).pipe(
        Effect.map((body) =>
          jsonContractResponse(applicationUpdateStatusSchema, body, 202, {
            'cache-control': 'no-store'
          })
        )
      )
    ),
    route(
      'GET',
      '/api/launchers',
      operation(() => service.launchers.listLaunchers()).pipe(
        Effect.map((launchers) =>
          jsonContractResponse(launchersResponseSchema, { launchers })
        )
      )
    ),
    route(
      'GET',
      '/api/launcher-definitions',
      Effect.gen(function* () {
        const query = yield* requestQuery(launcherDefinitionsQuerySchema)

        return jsonContractResponse(
          launcherDefinitionListingSchema,
          yield* operation(() =>
            service.launchers.listLauncherDefinitions(query)
          )
        )
      })
    ),
    route(
      'POST',
      '/api/launchers',
      Effect.gen(function* () {
        const body = yield* requestBody(createLauncherSchema)

        return jsonContractResponse(
          launcherResponseSchema,
          {
            launcher: yield* operation(() =>
              service.launchers.createLauncher({
                ...body,
                args: [...body.args]
              })
            )
          },
          201
        )
      })
    ),
    route(
      'PATCH',
      '/api/launchers/:launcherId',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(updateLauncherSchema)
        const { expectedUpdatedAt, ...input } = body

        return jsonContractResponse(launcherResponseSchema, {
          launcher: yield* operation(() =>
            service.launchers.updateLauncher(
              params.launcherId!,
              { ...input, args: [...input.args] },
              expectedUpdatedAt
            )
          )
        })
      })
    ),
    route(
      'DELETE',
      '/api/launchers/:launcherId',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(deleteLauncherSchema)
        yield* operation(() =>
          service.launchers.deleteLauncher(
            params.launcherId!,
            body.expectedUpdatedAt
          )
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),

    route(
      'GET',
      '/api/packages',
      operation(() => service.packageManagement.listPackages()).pipe(
        Effect.map((body) =>
          jsonContractResponse(packageListingResponseSchema, body)
        )
      )
    ),
    route(
      'GET',
      '/api/packages/project',
      Effect.gen(function* () {
        const query = yield* requestQuery(packageProjectQuerySchema)

        return jsonContractResponse(packageProjectResponseSchema, {
          project: yield* operation(() =>
            service.projects.resolveRegisteredProject(query.path)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/packages/install',
      Effect.gen(function* () {
        const body = yield* requestBody(packageInstallSchema)

        return jsonContractResponse(packageOperationResponseSchema, {
          result: yield* operation(() =>
            service.packageManagement.installPackage(
              body.source,
              body.projectId
            )
          )
        })
      })
    ),
    route(
      'POST',
      '/api/packages/remove',
      Effect.gen(function* () {
        const body = yield* requestBody(packageRemoveSchema)

        return jsonContractResponse(packageOperationResponseSchema, {
          result: yield* operation(() =>
            service.packageManagement.removePackage(body.source, body.projectId)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/packages/update',
      Effect.gen(function* () {
        const body = yield* requestBody(packageUpdateSchema)

        return jsonContractResponse(packageOperationsResponseSchema, {
          results: yield* operation(() =>
            service.packageManagement.updatePackages(body.source)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/packages/reload',
      Effect.gen(function* () {
        const body = yield* requestBody(packageReloadSchema)

        return jsonContractResponse(
          packageReloadResponseSchema,
          yield* operation(() =>
            service.packageManagement.reloadPackages(body.projectId)
          )
        )
      })
    ),

    route(
      'GET',
      '/api/projects',
      operation(() => service.projects.listProjects()).pipe(
        Effect.map((projects) =>
          jsonContractResponse(projectsResponseSchema, { projects })
        )
      )
    ),
    route(
      'GET',
      '/api/projects/recent',
      operation(() => service.projects.listRecentProjects()).pipe(
        Effect.map((projects) =>
          jsonContractResponse(recentProjectsResponseSchema, { projects })
        )
      )
    ),
    route(
      'GET',
      '/api/filesystem/directories',
      Effect.gen(function* () {
        const query = yield* requestQuery(browseDirectoryQuerySchema)

        return jsonContractResponse(
          directoryBrowseResponseSchema,
          yield* operation(() =>
            service.projects.browseDirectory(query.input, query.hidden)
          )
        )
      })
    ),
    route(
      'POST',
      '/api/projects',
      Effect.gen(function* () {
        const body = yield* requestBody(registerProjectSchema)

        const registered = yield* operation(() =>
          service.projects.registerProject(body.path, body.name)
        )

        return jsonContractResponse(
          projectResponseSchema,
          {
            project: yield* operation(() =>
              service.projects.getProjectSnapshot(registered.id)
            )
          },
          201
        )
      })
    ),
    route(
      'POST',
      '/api/projects/:projectId/open',
      Effect.gen(function* () {
        const params = yield* routeParams

        return jsonContractResponse(projectResponseSchema, {
          project: yield* operation(() =>
            service.projects.openProject(params.projectId!)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/projects/:projectId/close',
      Effect.gen(function* () {
        const params = yield* routeParams
        yield* operation(() => service.projects.closeProject(params.projectId!))

        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'DELETE',
      '/api/projects/:projectId/recent',
      Effect.gen(function* () {
        const params = yield* routeParams
        yield* operation(() =>
          service.projects.dismissRecentProject(params.projectId!)
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'GET',
      '/api/projects/:projectId',
      Effect.gen(function* () {
        const params = yield* routeParams

        const query = yield* requestQuery(
          Schema.Struct({ freshGitWorktreeId: Schema.optional(Schema.String) })
        )

        return jsonContractResponse(projectResponseSchema, {
          project: yield* operation(() =>
            service.projects.getProjectSnapshot(
              params.projectId!,
              query.freshGitWorktreeId
            )
          )
        })
      })
    ),
    route(
      'GET',
      '/api/projects/:projectId/icon',
      Effect.gen(function* () {
        const params = yield* routeParams

        const project = yield* operation(() =>
          service.projects.getProject(params.projectId!)
        )

        const iconPath = yield* operation(() =>
          findProjectIcon(project.mainWorktreePath)
        )

        const headers = { 'cache-control': 'private, max-age=300' }

        if (!iconPath) {
          return HttpServerResponse.empty({ status: 204, headers })
        }

        return yield* fileResponse(iconPath, {
          ...headers,
          // Icons come from repository content; keep SVG scripts inert when
          // the URL is opened directly.
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'x-content-type-options': 'nosniff'
        })
      })
    ),
    route(
      'PATCH',
      '/api/projects/:projectId',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(updateProjectSchema)
        yield* operation(() =>
          service.projects.updateProjectColor(params.projectId!, body.color)
        )

        return jsonContractResponse(projectResponseSchema, {
          project: yield* operation(() =>
            service.projects.getProjectSnapshot(params.projectId!)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/projects/:projectId/refresh',
      Effect.gen(function* () {
        const params = yield* routeParams
        yield* operation(() =>
          service.projects.refreshProject(params.projectId!)
        )

        return jsonContractResponse(projectResponseSchema, {
          project: yield* operation(() =>
            service.projects.getProjectSnapshot(params.projectId!)
          )
        })
      })
    ),
    route(
      'DELETE',
      '/api/projects/:projectId',
      Effect.gen(function* () {
        const params = yield* routeParams
        yield* operation(() =>
          service.projects.deleteProject(params.projectId!)
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'GET',
      '/api/projects/:projectId/worktrees',
      Effect.gen(function* () {
        const params = yield* routeParams

        const project = yield* operation(() =>
          service.projects.getProjectSnapshot(params.projectId!)
        )

        return jsonContractResponse(worktreesResponseSchema, {
          worktrees: project.worktrees
        })
      })
    ),
    route(
      'POST',
      '/api/projects/:projectId/worktree-operations',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(createWorktreeSchema)

        let initialTerminal:
          | NonNullable<
              Parameters<TreeportService['worktrees']['beginCreateWorktree']>[3]
            >
          | undefined

        if (body.initialTerminal) {
          initialTerminal = { name: body.initialTerminal.name }

          if (body.initialTerminal.initialTitle) {
            initialTerminal.initialTitle = body.initialTerminal.initialTitle
          }

          if (body.initialTerminal.argv) {
            initialTerminal.argv = [...body.initialTerminal.argv]
          }

          if (body.initialTerminal.returnToShell) {
            initialTerminal.returnToShell = true
          }

          if (body.initialTerminal.initialSize) {
            initialTerminal.initialSize = body.initialTerminal.initialSize
          }
        }

        const operationRecord = yield* operation(() =>
          service.worktrees.beginCreateWorktree(
            params.projectId!,
            body.name,
            body.base,
            initialTerminal,
            body.sourceWorktreeId,
            body.treeTitleCommand
          )
        )

        return jsonContractResponse(
          operationResponseSchema,
          { operation: operationRecord },
          202
        )
      })
    ),

    route(
      'GET',
      '/api/worktrees/:worktreeId',
      Effect.gen(function* () {
        const params = yield* routeParams

        return jsonContractResponse(worktreeResponseSchema, {
          worktree: yield* operation(() =>
            service.projects.getWorktreeSnapshot(params.worktreeId!)
          )
        })
      })
    ),
    route(
      'PATCH',
      '/api/worktrees/:worktreeId',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(updateWorktreeTitleSchema)
        yield* operation(() =>
          service.projects.updateWorktreeTitle(params.worktreeId!, body.title)
        )

        return jsonContractResponse(worktreeResponseSchema, {
          worktree: yield* operation(() =>
            service.projects.getWorktreeSnapshot(params.worktreeId!)
          )
        })
      })
    ),
    route(
      'GET',
      '/api/package-services/self',
      requirePackageAccess.pipe(
        Effect.map(({ access }) =>
          jsonContractResponse(packageServiceSelfResponseSchema, access)
        )
      )
    ),
    route(
      'GET',
      '/api/package-services/projects',
      Effect.gen(function* () {
        const { access } = yield* requirePackageAccess
        const projects = yield* operation(() => service.projects.listProjects())

        return jsonContractResponse(packageServiceProjectsResponseSchema, {
          projects: projects
            .filter(
              (project) =>
                !access.projectIds || access.projectIds.includes(project.id)
            )
            .map((project) => ({
              id: project.id,
              name: project.name,
              rootPath: project.rootPath,
              availability: project.availability,
              git:
                project.kind === 'repository'
                  ? {
                      defaultBranch: project.defaultBranch,
                      originUrl: project.originUrl
                    }
                  : null,
              worktrees: project.worktrees.map((tree) => ({
                id: tree.id,
                name: tree.name,
                git:
                  project.kind === 'repository'
                    ? { branch: tree.branch, head: tree.head }
                    : null,
                decorations: tree.decorations
              }))
            }))
        })
      })
    ),
    route(
      'GET',
      '/api/package-services/events',
      Effect.gen(function* () {
        const { token } = yield* requirePackageAccess
        const encoder = new TextEncoder()

        const message = (event: TreeportEvent) =>
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

        const publicTypes = {
          'worktree.created': 'tree.created',
          'worktree.removed': 'tree.removed',
          'worktree.git_changed': 'tree.changed'
        } as const

        return HttpServerResponse.stream(
          Stream.async<Uint8Array>((emit) => {
            void emit.single(message({ type: 'resync' }))

            const unsubscribe = service.events.subscribe((event) => {
              if (
                event.type !== 'worktree.created' &&
                event.type !== 'worktree.removed' &&
                event.type !== 'worktree.git_changed'
              ) {
                return
              }

              // Read scope per event: the package may be reconfigured or removed.
              const access = appServices?.access(token) ?? null

              if (!access) {
                void emit.end()
              } else if (
                event.data.worktreeId &&
                (!access.projectIds ||
                  access.projectIds.includes(event.data.projectId))
              ) {
                void emit.single(
                  message({
                    type: publicTypes[event.type],
                    projectId: event.data.projectId,
                    treeId: event.data.worktreeId
                  })
                )
              }
            })

            // Keeps proxies from closing a quiet stream.
            const heartbeat = setInterval(
              () => void emit.single(encoder.encode(': keepalive\n\n')),
              25_000
            )

            return Effect.sync(() => {
              unsubscribe()
              clearInterval(heartbeat)
            })
          }),
          {
            contentType: 'text/event-stream',
            headers: Headers.fromInput({ 'cache-control': 'no-store' })
          }
        )
      })
    ),
    ...(['PUT', 'DELETE'] as const).map((method) =>
      route(
        method,
        '/api/worktrees/:worktreeId/decorations/:decorationKey',
        Effect.gen(function* () {
          const params = yield* routeParams

          if (!TREE_DECORATION_KEY_PATTERN.test(params.decorationKey!)) {
            return yield* Effect.fail(
              new DomainError(
                'INVALID_DECORATION_KEY',
                'A decoration key uses lowercase letters, digits, dots, dashes, and underscores',
                400
              )
            )
          }

          // A package service's token makes its package the decoration owner.
          const request = yield* serverRequest

          const token = /^Bearer (\S+)$/u.exec(
            request.headers.authorization ?? ''
          )?.[1]

          const access = token ? (appServices?.access(token) ?? null) : null

          if (token && !access) {
            return yield* Effect.fail(
              new DomainError(
                'INVALID_PACKAGE_TOKEN',
                'The package token is invalid or its package was removed',
                401
              )
            )
          }

          if (access?.projectIds) {
            const worktree = yield* operation(() =>
              service.projects.getWorktree(params.worktreeId!)
            )

            if (!access.projectIds.includes(worktree.projectId)) {
              return yield* Effect.fail(
                new DomainError(
                  'PACKAGE_NOT_IN_PROJECT',
                  `${access.packageId} is not configured for this project`,
                  403
                )
              )
            }
          }

          const decoration =
            method === 'PUT'
              ? yield* requestBody(setTreeDecorationSchema)
              : null

          yield* operation(() =>
            service.projects.updateWorktreeDecoration(
              params.worktreeId!,
              params.decorationKey!,
              decoration,
              access?.packageId ?? null
            )
          )

          return jsonContractResponse(worktreeResponseSchema, {
            worktree: yield* operation(() =>
              service.projects.getWorktreeSnapshot(params.worktreeId!)
            )
          })
        })
      )
    ),
    route(
      'POST',
      '/api/worktrees/:worktreeId/open',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(requestWorkspaceOpenSchema)
        yield* operation(() =>
          service.projects.requestWorkspaceOpen(
            params.worktreeId!,
            body.sourceTerminalId
          )
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'PUT',
      '/api/worktrees/:worktreeId/terminals/order',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(reorderWorkspaceItemsSchema)
        yield* operation(() =>
          service.terminals.reorderTerminals(params.worktreeId!, body.itemIds)
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'PUT',
      '/api/worktrees/:worktreeId/apps/order',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(reorderWorkspaceItemsSchema)
        yield* operation(() =>
          service.apps.reorderApps(params.worktreeId!, body.itemIds)
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'POST',
      '/api/worktrees/:worktreeId/browser-apps',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(createBrowserAppSchema)

        return jsonContractResponse(
          openBrowserAppResponseSchema,
          yield* operation(() =>
            service.apps.openBrowserApp(
              params.worktreeId!,
              body.url,
              body.sourceTerminalId ?? null,
              null
            )
          ),
          201
        )
      })
    ),
    route(
      'POST',
      '/api/terminals/:terminalId/browser-apps/open',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(openBrowserAppFromTerminalSchema)
        const request = yield* HttpServerRequest.HttpServerRequest

        return jsonContractResponse(
          openBrowserAppResponseSchema,
          yield* operation(() =>
            service.apps.openBrowserAppFromTerminal(
              params.terminalId!,
              body.url,
              request.headers['x-request-id'] ?? null
            )
          ),
          201
        )
      })
    ),
    route(
      'GET',
      '/api/worktrees/:worktreeId/web-app-definitions',
      Effect.gen(function* () {
        const params = yield* routeParams

        return jsonContractResponse(webAppDefinitionsResponseSchema, {
          definitions: yield* operation(() =>
            service.apps.listWebAppDefinitions(params.worktreeId!)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/worktrees/:worktreeId/apps',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(createWebAppSchema)

        const app = yield* operation(() =>
          service.apps.createWebApp(params.worktreeId!, body.definitionId, {
            input: body.input ?? null,
            cwd: body.launchCwd ?? null
          })
        )

        return jsonContractResponse(webAppResponseSchema, { app }, 201)
      })
    ),
    route(
      'POST',
      '/api/worktrees/:worktreeId/apps/open',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(openWebAppSchema)
        const request = yield* serverRequest

        return jsonContractResponse(
          openWebAppResponseSchema,
          yield* operation(() =>
            service.apps.openWebApp(
              params.worktreeId!,
              body.definitionId,
              { input: body.input ?? null, cwd: body.launchCwd ?? null },
              body.newInstance ?? false,
              body.sourceTerminalId ?? null,
              request.headers['x-request-id'] ?? null
            )
          )
        )
      })
    ),
    route(
      'DELETE',
      '/api/apps/:appId',
      Effect.gen(function* () {
        const params = yield* routeParams
        yield* Effect.annotateCurrentSpan({
          'treeport.app.id': params.appId!
        })
        const query = yield* requestQuery(deleteAppQuerySchema)

        const canClose = browserSessions
          ? yield* operation(() =>
              browserSessions.requestAppClose(
                params.appId!,
                query.force === 'true'
              )
            ).pipe(Effect.withSpan('treeport.app.remove.close_guard'))
          : undefined

        if (canClose === false) {
          return yield* Effect.fail(
            new DomainError(
              'BROWSER_BEFORE_UNLOAD',
              'Changes you made may not be saved.',
              409
            )
          )
        }

        yield* operation(() =>
          service.apps.deleteApp(
            params.appId!,
            query.discardStoredData === 'true'
          )
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      }).pipe(Effect.withSpan('treeport.app.remove.request'))
    ),
    ...(['ensure', 'status', 'stop'] as const).map((action) =>
      route(
        'POST',
        `/api/apps/:appId/services/${action}`,
        Effect.gen(function* () {
          const params = yield* routeParams
          const body = yield* requestBody(appServiceRequestSchema)

          const context = yield* operation(() =>
            service.apps.getWebAppServiceContext(params.appId!)
          )

          if (!appServices) {
            return yield* Effect.fail(
              new DomainError(
                'SERVICES_UNAVAILABLE',
                'App services are unavailable',
                503
              )
            )
          }

          return jsonContractResponse(
            appServiceSchema,
            yield* operation(() => appServices[action](context, body.name))
          )
        })
      )
    ),
    route(
      'GET',
      '/api/apps/:appId/context',
      Effect.gen(function* () {
        const params = yield* routeParams

        return jsonContractResponse(webAppContextResponseSchema, {
          context: yield* operation(() =>
            service.apps.getWebAppContext(params.appId!)
          )
        })
      })
    ),
    route(
      'GET',
      '/api/apps/:appId/diff',
      Effect.gen(function* () {
        const params = yield* routeParams
        const query = yield* requestQuery(gitDiffRequestSchema)

        return jsonContractResponse(gitDiffResponseSchema, {
          diff: yield* operation(() =>
            service.apps.getWebAppDiff(params.appId!, query.scope)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/apps/:appId/diff/file',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(gitFileDiffRequestSchema)

        return jsonContractResponse(
          gitFileDiffResponseSchema,
          yield* operation(() =>
            service.apps.getWebAppFileDiff(params.appId!, body.path, body.scope)
          )
        )
      })
    ),
    route(
      'POST',
      '/api/apps/:appId/diff/image',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(gitDiffImageRequestSchema)

        return jsonContractResponse(
          gitDiffImageSchema,
          yield* operation(() =>
            service.apps.getWebAppDiffImage(params.appId!, body)
          )
        )
      })
    ),
    route(
      'GET',
      '/api/apps/:appId/network/listeners',
      Effect.gen(function* () {
        const params = yield* routeParams

        return jsonContractResponse(listenerDiscoveryResponseSchema, {
          discovery: yield* operation(() =>
            service.apps.getAppListeners(params.appId!)
          )
        })
      })
    ),
    route(
      'GET',
      '/api/apps/:appId/storage',
      Effect.gen(function* () {
        const params = yield* routeParams

        return jsonContractResponse(hasDataResponseSchema, {
          hasData: yield* operation(() =>
            service.apps.hasWebAppStorage(params.appId!)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/apps/:appId/storage/get',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(getWebAppStorageSchema)

        const value = yield* operation(() =>
          service.apps.getWebAppStorage(params.appId!, body.key, body.scope)
        )

        return jsonContractResponse(storageValueResponseSchema, {
          found: value !== undefined,
          value: value ?? null
        })
      })
    ),
    route(
      'PUT',
      '/api/apps/:appId/storage',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(setWebAppStorageSchema)
        yield* operation(() =>
          service.apps.setWebAppStorage(
            params.appId!,
            body.key,
            body.value,
            body.scope
          )
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'DELETE',
      '/api/apps/:appId/storage',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(deleteWebAppStorageSchema)
        yield* operation(() =>
          service.apps.deleteWebAppStorage(params.appId!, body.key, body.scope)
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route('GET', '/api/web-apps/:appId/assets', webAppAsset),
    route('GET', '/api/web-apps/:appId/assets/*', webAppAsset),

    route(
      'POST',
      '/api/worktrees/:worktreeId/terminals',
      Effect.gen(function* () {
        const params = yield* routeParams
        yield* Effect.annotateCurrentSpan({
          'treeport.worktree.id': params.worktreeId!
        })
        const body = yield* requestBody(createTerminalSchema)

        const options: NonNullable<
          Parameters<TreeportService['terminals']['createTerminal']>[3]
        > = {}

        if (body.initialTitle) {
          options.initialTitle = body.initialTitle
        }

        if (body.returnToShell) {
          options.returnToShell = true
        }

        if (body.closeOnSuccess) {
          options.closeOnSuccess = true
        }

        if (body.closeOnExit) {
          options.closeOnExit = true
        }

        if (body.initialSize) {
          options.initialSize = body.initialSize
        }

        if (body.cwd) {
          options.cwd = body.cwd
        }

        if (body.env) {
          options.env = { ...body.env }
        }

        if (body.shellCommand) {
          options.shellCommand = body.shellCommand
        }

        const terminal = yield* operation(() =>
          service.terminals.createTerminal(
            params.worktreeId!,
            body.name,
            body.argv ? [...body.argv] : undefined,
            Object.keys(options).length ? options : undefined
          )
        )

        return jsonContractResponse(terminalResponseSchema, { terminal }, 201)
      }).pipe(Effect.withSpan('treeport.terminal.create.request'))
    ),
    route(
      'GET',
      '/api/worktrees/:worktreeId/remove-preview',
      Effect.gen(function* () {
        const params = yield* routeParams

        return jsonContractResponse(removePreviewResponseSchema, {
          preview: yield* operation(() =>
            service.worktrees.removePreview(params.worktreeId!)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/worktrees/:worktreeId/remove',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(removeWorktreeSchema)

        return jsonContractResponse(
          operationResponseSchema,
          {
            operation: yield* operation(() =>
              service.worktrees.beginRemove(params.worktreeId!, body)
            )
          },
          202
        )
      })
    ),
    route(
      'GET',
      '/api/terminals/:terminalId/capture',
      Effect.gen(function* () {
        const params = yield* routeParams
        const query = yield* requestQuery(terminalCaptureQuerySchema)

        const terminal = yield* operation(() =>
          service.terminals.getTerminal(params.terminalId!)
        )

        const content = yield* operation(() =>
          terminalHost.captureTerminal(terminal.id, query.lines)
        )

        if (content === null) {
          return yield* Effect.fail(
            new DomainError(
              'TERMINAL_CAPTURE_UNAVAILABLE',
              'Terminal is unavailable',
              409,
              { terminalId: terminal.id }
            )
          )
        }

        return jsonContractResponse(terminalCaptureResponseSchema, {
          terminalId: terminal.id,
          capturedAt: new Date().toISOString(),
          lineLimit: query.lines,
          content
        })
      })
    ),
    route(
      'GET',
      '/api/terminals/:terminalId',
      Effect.gen(function* () {
        const params = yield* routeParams

        const terminal = yield* operation(() =>
          service.terminals.refreshTerminalStatus(params.terminalId!)
        )

        const worktree = yield* operation(() =>
          service.projects.getWorktree(terminal.worktreeId)
        )

        yield* operation(() => metadata.trackTerminal(terminal, worktree))

        return jsonContractResponse(terminalObservationResponseSchema, {
          terminal,
          metadata: metadata.get(terminal.id)
        })
      })
    ),
    route(
      'POST',
      '/api/terminals/:terminalId/attention/acknowledge',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(terminalAttentionAcknowledgementSchema)
        yield* Effect.annotateCurrentSpan({
          'treeport.terminal.id': params.terminalId!
        })
        yield* operation(() =>
          service.terminals.getKnownTerminal(params.terminalId!)
        ).pipe(
          Effect.withSpan('treeport.terminal.attention.acknowledge.lookup')
        )
        yield* operation(() =>
          metadata.acknowledgeAttention(params.terminalId!, body.sequence)
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      }).pipe(
        Effect.withSpan('treeport.terminal.attention.acknowledge.request')
      )
    ),
    ...(['/api/files', '/api/terminals/:terminalId/files'] as const).map(
      (routePath) =>
        route(
          'POST',
          routePath,
          Effect.gen(function* () {
            const params = yield* routeParams
            const request = yield* serverRequest

            if (params.terminalId) {
              yield* operation(() =>
                service.terminals.getTerminal(params.terminalId!)
              )
            }

            const contentLength = request.headers['content-length']

            if (contentLength) {
              const declaredBytes = Number(contentLength)

              if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
                return yield* Effect.fail(
                  new DomainError(
                    'VALIDATION_ERROR',
                    'File size is invalid',
                    400
                  )
                )
              }

              if (declaredBytes > TERMINAL_MAX_UPLOAD_BYTES) {
                return yield* Effect.fail(
                  new DomainError(
                    'FILE_TOO_LARGE',
                    'Uploaded files are limited to 50 GiB each',
                    413
                  )
                )
              }
            }

            const requestedExtension =
              request.headers['x-treeport-file-extension']?.toLowerCase()

            if (
              requestedExtension &&
              !/^[a-z0-9]{1,16}$/.test(requestedExtension)
            ) {
              return yield* Effect.fail(
                new DomainError(
                  'VALIDATION_ERROR',
                  'File extension is invalid',
                  400
                )
              )
            }

            const requestContentType =
              request.headers['content-type']
                ?.split(';', 1)[0]
                ?.toLowerCase() ?? ''

            const extension =
              requestedExtension ||
              UPLOAD_MIME_EXTENSIONS.get(requestContentType) ||
              ''

            const uploadDirectory = path.join(config.runtimeDir, 'uploads')

            const uploaded = yield* Effect.acquireUseRelease(
              operation(() =>
                service.terminalUploadMutation(
                  Effect.gen(function* () {
                    yield* Effect.promise(() =>
                      fs.mkdir(uploadDirectory, {
                        recursive: true,
                        mode: 0o700
                      })
                    )
                    yield* Effect.promise(() =>
                      fs.chmod(uploadDirectory, 0o700)
                    )
                    yield* Effect.promise(() =>
                      pruneTerminalUploads(uploadDirectory, activeUploadPaths)
                    )

                    const filePath = path.join(
                      uploadDirectory,
                      `treeport-upload-${crypto.randomUUID()}${extension ? `.${extension}` : ''}`
                    )

                    const file = yield* Effect.promise(() =>
                      fs.open(filePath, 'wx', 0o600)
                    )

                    activeUploadPaths.add(filePath)

                    return { filePath, file }
                  })
                )
              ),
              ({ filePath, file }) =>
                operation(() =>
                  Effect.gen(function* () {
                    let receivedBytes = 0
                    // Only directory mutations are serialized. File streams run in
                    // parallel, and pruning must never remove an active upload.
                    yield* Stream.runForEach(
                      request.stream.pipe(
                        Stream.timeoutFail(
                          () =>
                            new DomainError(
                              'UPLOAD_STALLED',
                              'Upload stalled for 2 minutes',
                              408
                            ),
                          '2 minutes'
                        )
                      ),
                      (value) => {
                        receivedBytes += value.byteLength

                        if (receivedBytes > TERMINAL_MAX_UPLOAD_BYTES) {
                          return Effect.fail(
                            new DomainError(
                              'FILE_TOO_LARGE',
                              'Uploaded files are limited to 50 GiB each',
                              413
                            )
                          )
                        }

                        return Effect.promise(() => file.writeFile(value)).pipe(
                          Effect.asVoid
                        )
                      }
                    )

                    return { file: { path: filePath } }
                  })
                ),
              ({ filePath, file }, exit) =>
                Effect.gen(function* () {
                  yield* Effect.promise(() =>
                    file.close().finally(() => {
                      activeUploadPaths.delete(filePath)

                      return Exit.isFailure(exit)
                        ? fs.rm(filePath, { force: true })
                        : undefined
                    })
                  )
                  yield* service.terminalUploadMutation(
                    Effect.promise(() =>
                      pruneTerminalUploads(
                        uploadDirectory,
                        new Set([...activeUploadPaths, filePath])
                      )
                    )
                  )
                })
            )

            return jsonContractResponse(
              uploadedFileResponseSchema,
              uploaded,
              201
            )
          })
        )
    ),
    route(
      'PATCH',
      '/api/terminals/:terminalId',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(updateTerminalSchema)

        return jsonContractResponse(terminalResponseSchema, {
          terminal: yield* operation(() =>
            service.terminals.renameTerminal(params.terminalId!, body.name)
          )
        })
      })
    ),
    route(
      'DELETE',
      '/api/terminals/:terminalId',
      Effect.gen(function* () {
        const params = yield* routeParams
        yield* Effect.annotateCurrentSpan({
          'treeport.terminal.id': params.terminalId!
        })
        yield* operation(() =>
          service.terminals.deleteTerminal(params.terminalId!)
        )

        return jsonContractResponse(okResponseSchema, { ok: true })
      }).pipe(Effect.withSpan('treeport.terminal.remove.request'))
    ),
    route(
      'GET',
      '/api/operations',
      Effect.gen(function* () {
        const query = yield* requestQuery(
          operationQuerySchema,
          'INVALID_OPERATION_KIND',
          'Invalid operation query'
        )

        const filters: Parameters<
          TreeportService['worktrees']['listActiveOperations']
        >[0] = {}

        if (query.projectId) {
          filters.projectId = query.projectId
        }

        if (query.kind) {
          filters.kind = query.kind
        }

        return jsonContractResponse(operationsResponseSchema, {
          operations: yield* operation(() =>
            service.worktrees.listActiveOperations(filters)
          )
        })
      })
    ),
    route(
      'GET',
      '/api/operations/:operationId',
      Effect.gen(function* () {
        const params = yield* routeParams

        return jsonContractResponse(operationResponseSchema, {
          operation: yield* operation(() =>
            service.projects.getOperation(params.operationId!)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/admin/terminate-terminals',
      Effect.gen(function* () {
        const terminated = yield* operation(() =>
          service.terminals.terminateAllTerminals()
        )

        yield* operation(() => terminalHost.shutdownIfEmpty())

        return jsonContractResponse(terminatedTerminalsResponseSchema, {
          terminated
        })
      })
    ),
    ...(rpcHttpApp ? [route('POST', '/api/rpc', rpcHttpApp)] : []),
    route(
      '*',
      '/api/*',
      Effect.succeed(
        jsonContractResponse(
          apiErrorBodySchema,
          { error: { code: 'NOT_FOUND', message: 'API endpoint not found' } },
          404
        )
      )
    )
  ]

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const builtStaticRoot = path.resolve(moduleDirectory, '../../web')
  const sourceStaticRoot = path.resolve(moduleDirectory, '../../dist/web')

  const staticRoot =
    webDist ??
    config.webDist ??
    (existsSync(builtStaticRoot) ? builtStaticRoot : sourceStaticRoot)

  routes.push(
    route(
      'GET',
      '/assets/*',
      Effect.gen(function* () {
        const request = yield* serverRequest

        const pathname = decodeURIComponent(
          new URL(request.url, 'http://treeport.local').pathname
        )

        const relative = pathname.slice('/assets/'.length)
        const candidate = path.resolve(staticRoot, 'assets', relative)
        const root = path.resolve(staticRoot, 'assets')

        if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
          return HttpServerResponse.empty({ status: 404 })
        }

        return yield* fileResponse(candidate, {
          'cache-control': 'public, max-age=31536000, immutable'
        })
      })
    ),
    route(
      'GET',
      '/manifest.webmanifest',
      fileResponse(path.join(staticRoot, 'manifest.webmanifest'))
    ),
    route(
      'GET',
      '/sw.js',
      fileResponse(path.join(staticRoot, 'sw.js'), {
        'cache-control': 'no-cache'
      })
    ),
    // Only hashed assets are immutable. Navigation after a daemon update must
    // always fetch the entry point belonging to the newly running release.
    route(
      'GET',
      '*',
      fileResponse(path.join(staticRoot, 'index.html'), {
        'cache-control': 'no-store'
      })
    )
  )

  const router = HttpRouter.fromIterable(routes)

  const routed = Effect.flatMap(
    HttpRouter.toHttpApp(router),
    (httpApp) => httpApp
  )

  const httpApp = Effect.gen(function* () {
    const request = yield* serverRequest
    const started = Date.now()

    const requestId = (
      request.headers['x-request-id'] ?? crypto.randomUUID()
    ).slice(0, 128)

    const requestPath = new URL(
      request.url,
      'http://treeport.local'
    ).pathname.slice(0, 2_048)

    yield* Effect.annotateCurrentSpan({
      'treeport.request.id': requestId,
      'http.request.method': request.method,
      'url.path': requestPath
    })
    yield* networkTelemetry.connectionOpened('http')
    const declaredRequestBytes = Number(request.headers['content-length'])
    yield* networkTelemetry.message(
      'http',
      'in',
      Number.isSafeInteger(declaredRequestBytes) && declaredRequestBytes >= 0
        ? declaredRequestBytes
        : 0
    )

    const response = yield* routed.pipe(
      Effect.provideService(
        serverRequest,
        request.modify({
          headers: Headers.set(request.headers, 'x-request-id', requestId)
        })
      ),
      Effect.catchAllCause((cause) => {
        if (Cause.isInterruptedOnly(cause)) {
          return Effect.failCause(cause)
        }

        const failure = Cause.failureOption(cause)

        if (Option.isSome(failure) && failure.value instanceof DomainError) {
          const error = failure.value

          const errorBody =
            error.details === undefined
              ? { code: error.code, message: error.message }
              : {
                  code: error.code,
                  message: error.message,
                  details: error.details
                }

          const body: ApiErrorBody = { error: errorBody }

          return Effect.succeed(
            jsonContractResponse(apiErrorBodySchema, body, error.status)
          )
        }

        const unexpected = Option.isSome(failure)
          ? failure.value
          : Cause.squash(cause)

        const error =
          unexpected instanceof Error ? unexpected.message : String(unexpected)

        return Effect.sync(() => {
          console.error('[Treeport] API request failed', {
            requestId,
            method: request.method,
            path: requestPath,
            status: 500,
            code: 'INTERNAL_ERROR',
            error
          })
        }).pipe(
          Effect.zipRight(
            Effect.logError('API request failed').pipe(
              Effect.annotateLogs({
                requestId,
                method: request.method,
                path: requestPath,
                cause: error
              })
            )
          ),
          Effect.as(
            jsonContractResponse(
              apiErrorBodySchema,
              {
                error: {
                  code: 'INTERNAL_ERROR',
                  message: 'Unexpected server error',
                  details: { requestId }
                }
              },
              500
            )
          )
        )
      }),
      Effect.onExit((exit) =>
        Effect.all([
          networkTelemetry.duration('http', 'request', Date.now() - started),
          ...(Exit.isInterrupted(exit)
            ? [networkTelemetry.interrupted('http')]
            : []),
          networkTelemetry.connectionClosed(
            'http',
            Exit.isInterrupted(exit)
              ? 'interrupted'
              : Exit.isFailure(exit)
                ? 'failed'
                : 'request_complete'
          )
        ]).pipe(Effect.asVoid)
      )
    )

    yield* Effect.annotateCurrentSpan({
      'http.response.status_code': response.status
    })
    yield* networkTelemetry.message(
      'http',
      'out',
      response.body.contentLength ?? 0
    )

    return requestPath.startsWith('/api')
      ? HttpServerResponse.setHeader(response, 'x-request-id', requestId)
      : response
  }).pipe(Effect.withSpan('treeport.http.request'))

  // SAFETY: Tests provide Promise doubles instead of the application Layer;
  // production passes the precisely typed httpApp to NodeHttpServer.
  const testHttpApp = httpApp as HttpApp.Default<unknown, Scope.Scope>
  const requestHandler = HttpApp.toWebHandler(testHttpApp)

  return {
    httpApp,
    request(input, init) {
      const request =
        input instanceof Request
          ? input
          : new Request(new URL(String(input), 'http://localhost'), init)

      return requestHandler(request)
    }
  }
}
