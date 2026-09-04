import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as HttpApp from '@effect/platform/HttpApp'
import * as HttpRouter from '@effect/platform/HttpRouter'
import * as HttpServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import {
  apiErrorBodySchema,
  applicationUpdateStatusSchema,
  browseDirectoryQuerySchema,
  browserAgentCommandSchema,
  browserAgentResponseSchema,
  browserInstallResponseSchema,
  browserInstallStatusSchema,
  browserOwnerTicketRequestSchema,
  browserOwnerTicketResponseSchema,
  browserTicketRequestSchema,
  browserTicketResponseSchema,
  createBrowserPanelSchema,
  createTerminalPresetSchema,
  createTerminalSchema,
  createWorktreeSchema,
  createWebPanelSchema,
  deletePanelQuerySchema,
  deleteTerminalPresetSchema,
  deleteWebPanelStorageSchema,
  DESKTOP_PROTOCOL_VERSION,
  directoryBrowseResponseSchema,
  getWebPanelStorageSchema,
  healthResponseSchema,
  openBrowserPanelFromTerminalSchema,
  openBrowserPanelResponseSchema,
  openWebPanelResponseSchema,
  openWebPanelSchema,
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
  prResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  readTreeFileSchema,
  recentProjectsResponseSchema,
  removePreviewResponseSchema,
  registerProjectSchema,
  removeWorktreeSchema,
  requestWorkspaceOpenSchema,
  searchTreeFilesSchema,
  setWebPanelStorageSchema,
  storageValueResponseSchema,
  terminalBellAcknowledgementSchema,
  terminalCaptureQuerySchema,
  terminalCaptureResponseSchema,
  terminalObservationResponseSchema,
  terminalPresetDefinitionListingSchema,
  terminalPresetDefinitionsQuerySchema,
  terminalPresetResponseSchema,
  terminalPresetsResponseSchema,
  terminalResponseSchema,
  TERMINAL_MAX_UPLOAD_BYTES,
  terminatedTerminalsResponseSchema,
  treeContextFieldListingSchema,
  treeContextFieldsQuerySchema,
  treeContextResponseSchema,
  treeFileListingSchema,
  treeFileSchema,
  treeFileSearchResultSchema,
  treeFileWriteResultSchema,
  uploadedFileResponseSchema,
  updateProjectSchema,
  updateTerminalPresetSchema,
  updateTerminalSchema,
  updateWebPanelPermissionGrantSchema,
  webPanelContextResponseSchema,
  webPanelDefinitionResponseSchema,
  webPanelDefinitionsResponseSchema,
  webPanelResponseSchema,
  worktreeResponseSchema,
  worktreesResponseSchema,
  gitDiffResponseSchema,
  hasDataResponseSchema,
  listenerDiscoveryResponseSchema,
  okResponseSchema,
  writeTreeFileSchema,
  type ApiErrorBody
} from '@treeport/shared'
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
  webPanelBrowserOrigin,
  webPanelContentSecurityPolicy
} from './core/web-panel-csp'
import type { ApplicationUpdateManager } from './application-update'
import type { TerminalMetadataManager } from './terminal-metadata'
import type { BrowserSessionManager } from './browser-sessions'
import { isLoopbackAddress } from './request-security'
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
const UPLOAD_DIRECTORY_MAX_BYTES = 512 * 1024 * 1024

interface UploadFileInfo {
  path: string
  size: number
  mtimeMs: number
}

async function pruneTerminalUploads(
  directory: string,
  preservePath?: string
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
      if (left.path === preservePath) {
        return -1
      }

      if (right.path === preservePath) {
        return 1
      }

      return right.mtimeMs - left.mtimeMs
    })

  const expiredBefore = Date.now() - UPLOAD_RETENTION_MS
  let retainedBytes = 0
  for (const file of files) {
    const expired = file.mtimeMs < expiredBefore
    const overQuota = retainedBytes + file.size > UPLOAD_DIRECTORY_MAX_BYTES
    if (file.path !== preservePath && (expired || overQuota)) {
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
  browserSessions?: BrowserSessionManager
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
  rpcHttpApp,
  webDist
}: AppDependencies): TreeportHttpApp {
  const webPanelAsset = Effect.gen(function* () {
    const params = yield* routeParams
    const request = yield* serverRequest
    const pathname = new URL(request.url, 'http://treeport.local').pathname
    const marker = `/api/web-panels/${encodeURIComponent(
      params.panelId!
    )}/assets/`
    const markerStart = pathname.indexOf(marker)
    const requestedPath =
      markerStart < 0
        ? ''
        : decodeURI(pathname.slice(markerStart + marker.length))
    const resolution = yield* operation(() =>
      service.panels.resolveWebPanelAsset(params.panelId!, requestedPath)
    )
    if (resolution.kind === 'redirect') {
      return HttpServerResponse.redirect(resolution.location, {
        status: 307,
        headers: { 'cache-control': 'no-store' }
      })
    }

    const browserOrigin = webPanelBrowserOrigin({
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
      'content-security-policy': webPanelContentSecurityPolicy(
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
  const routes = [
    route(
      'GET',
      '/api/panels/:panelId/files',
      Effect.gen(function* () {
        const params = yield* routeParams
        return jsonContractResponse(
          treeFileListingSchema,
          yield* operation(() =>
            service.treeFiles.listTreeFiles(params.panelId!)
          )
        )
      })
    ),
    route(
      'POST',
      '/api/panels/:panelId/files/search',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(searchTreeFilesSchema)
        return jsonContractResponse(
          treeFileSearchResultSchema,
          yield* operation(() =>
            service.treeFiles.searchTreeFiles(params.panelId!, body.query)
          )
        )
      })
    ),
    route(
      'POST',
      '/api/panels/:panelId/files/read',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(readTreeFileSchema)
        return jsonContractResponse(
          treeFileSchema,
          yield* operation(() =>
            service.treeFiles.readTreeFile(params.panelId!, body.path)
          )
        )
      })
    ),
    route(
      'PUT',
      '/api/panels/:panelId/files',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(writeTreeFileSchema)
        return jsonContractResponse(
          treeFileWriteResultSchema,
          yield* operation(() =>
            service.treeFiles.writeTreeFile(params.panelId!, body)
          )
        )
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
      'DELETE',
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

        yield* operation(() => browserSessions.remove())
        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'PUT',
      '/api/worktrees/:worktreeId/web-panel-definitions/:definitionId/permission-grant',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(updateWebPanelPermissionGrantSchema)
        const definition = yield* operation(() =>
          service.panels.setWebPanelPermissionGrant(
            params.worktreeId!,
            params.definitionId!,
            body.granted,
            [...body.permissions]
          )
        )
        return jsonContractResponse(webPanelDefinitionResponseSchema, {
          definition
        })
      })
    ),
    route(
      'POST',
      '/api/panels/:panelId/browser-agent',
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
          browserSessions.agentCommand(params.panelId!, input)
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
                        ? `Retry \`treeport browser snapshot --panel ${params.panelId}\`.`
                        : input.command === 'screenshot'
                          ? `Open Browser ${params.panelId} in Treeport, then retry the screenshot.`
                          : `Run \`treeport browser snapshot --panel ${params.panelId}\`, then retry this Browser command.`
                  }
                )
          )
        )
        return jsonContractResponse(browserAgentResponseSchema, { output })
      })
    ),
    route(
      'POST',
      '/api/panels/:panelId/browser-owner-ticket',
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
            browserSessions.issueOwnerTicket(params.panelId!, body.clientId)
          )
        )
      })
    ),
    route(
      'POST',
      '/api/panels/:panelId/browser-ticket',
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
        return jsonContractResponse(browserTicketResponseSchema, {
          ticket: yield* operation(() =>
            browserSessions.issueTicket(
              params.panelId!,
              body.clientId,
              body.visible
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
      '/api/terminal-presets',
      operation(() => service.terminalPresets.listTerminalPresets()).pipe(
        Effect.map((presets) =>
          jsonContractResponse(terminalPresetsResponseSchema, { presets })
        )
      )
    ),
    route(
      'GET',
      '/api/tree-context-fields',
      Effect.gen(function* () {
        const query = yield* requestQuery(treeContextFieldsQuerySchema)
        return jsonContractResponse(
          treeContextFieldListingSchema,
          yield* operation(() =>
            service.projects.listTreeContextFields(query.projectId)
          )
        )
      })
    ),
    route(
      'GET',
      '/api/terminal-preset-definitions',
      Effect.gen(function* () {
        const query = yield* requestQuery(terminalPresetDefinitionsQuerySchema)
        return jsonContractResponse(
          terminalPresetDefinitionListingSchema,
          yield* operation(() =>
            service.terminalPresets.listTerminalPresetDefinitions(query)
          )
        )
      })
    ),
    route(
      'POST',
      '/api/terminal-presets',
      Effect.gen(function* () {
        const body = yield* requestBody(createTerminalPresetSchema)
        return jsonContractResponse(
          terminalPresetResponseSchema,
          {
            preset: yield* operation(() =>
              service.terminalPresets.createTerminalPreset({
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
      '/api/terminal-presets/:presetId',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(updateTerminalPresetSchema)
        const { expectedUpdatedAt, ...input } = body
        return jsonContractResponse(terminalPresetResponseSchema, {
          preset: yield* operation(() =>
            service.terminalPresets.updateTerminalPreset(
              params.presetId!,
              { ...input, args: [...input.args] },
              expectedUpdatedAt
            )
          )
        })
      })
    ),
    route(
      'DELETE',
      '/api/terminal-presets/:presetId',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(deleteTerminalPresetSchema)
        yield* operation(() =>
          service.terminalPresets.deleteTerminalPreset(
            params.presetId!,
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
        return jsonContractResponse(projectResponseSchema, {
          project: yield* operation(() =>
            service.projects.getProjectSnapshot(params.projectId!)
          )
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
            body.context ? { ...body.context } : undefined
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
        yield* operation(() =>
          service.worktrees.refreshPr(params.worktreeId!, false)
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
      '/api/worktrees/:worktreeId/context',
      Effect.gen(function* () {
        const params = yield* routeParams
        return jsonContractResponse(treeContextResponseSchema, {
          context: yield* operation(() =>
            service.projects.getWorktreeContext(params.worktreeId!)
          )
        })
      })
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
      'POST',
      '/api/worktrees/:worktreeId/browser-panels',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(createBrowserPanelSchema)
        return jsonContractResponse(
          openBrowserPanelResponseSchema,
          yield* operation(() =>
            service.panels.openBrowserPanel(
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
      '/api/terminals/:terminalId/browser-panels/open',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(openBrowserPanelFromTerminalSchema)
        return jsonContractResponse(
          openBrowserPanelResponseSchema,
          yield* operation(() =>
            service.panels.openBrowserPanelFromTerminal(
              params.terminalId!,
              body.url
            )
          ),
          201
        )
      })
    ),
    route(
      'GET',
      '/api/worktrees/:worktreeId/web-panel-definitions',
      Effect.gen(function* () {
        const params = yield* routeParams
        return jsonContractResponse(webPanelDefinitionsResponseSchema, {
          definitions: yield* operation(() =>
            service.panels.listWebPanelDefinitions(params.worktreeId!)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/worktrees/:worktreeId/panels',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(createWebPanelSchema)
        const panel = yield* operation(() =>
          service.panels.createWebPanel(params.worktreeId!, body.definitionId, {
            input: body.input ?? null,
            cwd: body.launchCwd ?? null
          })
        )
        return jsonContractResponse(webPanelResponseSchema, { panel }, 201)
      })
    ),
    route(
      'POST',
      '/api/worktrees/:worktreeId/panels/open',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(openWebPanelSchema)
        return jsonContractResponse(
          openWebPanelResponseSchema,
          yield* operation(() =>
            service.panels.openWebPanel(
              params.worktreeId!,
              body.definitionId,
              { input: body.input ?? null, cwd: body.launchCwd ?? null },
              body.newInstance ?? false,
              body.sourceTerminalId ?? null
            )
          )
        )
      })
    ),
    route(
      'DELETE',
      '/api/panels/:panelId',
      Effect.gen(function* () {
        const params = yield* routeParams
        const query = yield* requestQuery(deletePanelQuerySchema)
        const canClose = browserSessions
          ? yield* operation(() =>
              browserSessions.requestPanelClose(
                params.panelId!,
                query.force === 'true'
              )
            )
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
          service.panels.deletePanel(
            params.panelId!,
            query.discardStoredData === 'true'
          )
        )
        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'GET',
      '/api/panels/:panelId/context',
      Effect.gen(function* () {
        const params = yield* routeParams
        return jsonContractResponse(webPanelContextResponseSchema, {
          context: yield* operation(() =>
            service.panels.getWebPanelContext(params.panelId!)
          )
        })
      })
    ),
    route(
      'GET',
      '/api/panels/:panelId/diff',
      Effect.gen(function* () {
        const params = yield* routeParams
        return jsonContractResponse(gitDiffResponseSchema, {
          diff: yield* operation(() =>
            service.panels.getWebPanelDiff(params.panelId!)
          )
        })
      })
    ),
    route(
      'GET',
      '/api/panels/:panelId/network/listeners',
      Effect.gen(function* () {
        const params = yield* routeParams
        return jsonContractResponse(listenerDiscoveryResponseSchema, {
          discovery: yield* operation(() =>
            service.panels.getPanelListeners(params.panelId!)
          )
        })
      })
    ),
    route(
      'GET',
      '/api/panels/:panelId/storage',
      Effect.gen(function* () {
        const params = yield* routeParams
        return jsonContractResponse(hasDataResponseSchema, {
          hasData: yield* operation(() =>
            service.panels.hasWebPanelStorage(params.panelId!)
          )
        })
      })
    ),
    route(
      'POST',
      '/api/panels/:panelId/storage/get',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(getWebPanelStorageSchema)
        return jsonContractResponse(storageValueResponseSchema, {
          value: yield* operation(() =>
            service.panels.getWebPanelStorage(params.panelId!, body.key)
          )
        })
      })
    ),
    route(
      'PUT',
      '/api/panels/:panelId/storage',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(setWebPanelStorageSchema)
        yield* operation(() =>
          service.panels.setWebPanelStorage(
            params.panelId!,
            body.key,
            body.value
          )
        )
        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'DELETE',
      '/api/panels/:panelId/storage',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(deleteWebPanelStorageSchema)
        yield* operation(() =>
          service.panels.deleteWebPanelStorage(params.panelId!, body.key)
        )
        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route('GET', '/api/web-panels/:panelId/assets', webPanelAsset),
    route('GET', '/api/web-panels/:panelId/assets/*', webPanelAsset),

    route(
      'POST',
      '/api/worktrees/:worktreeId/terminals',
      Effect.gen(function* () {
        const params = yield* routeParams
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
      })
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
      'POST',
      '/api/worktrees/:worktreeId/pr/refresh',
      Effect.gen(function* () {
        const params = yield* routeParams
        return jsonContractResponse(prResponseSchema, {
          pr: yield* operation(() =>
            service.worktrees.refreshPr(params.worktreeId!, true)
          )
        })
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
      '/api/terminals/:terminalId/bell/acknowledge',
      Effect.gen(function* () {
        const params = yield* routeParams
        const body = yield* requestBody(terminalBellAcknowledgementSchema)
        yield* operation(() =>
          service.terminals.getTerminal(params.terminalId!)
        )
        yield* operation(() =>
          metadata.acknowledgeBell(params.terminalId!, body.sequence)
        )
        return jsonContractResponse(okResponseSchema, { ok: true })
      })
    ),
    route(
      'POST',
      '/api/terminals/:terminalId/files',
      Effect.gen(function* () {
        const params = yield* routeParams
        const request = yield* serverRequest
        yield* operation(() =>
          service.terminals.getTerminal(params.terminalId!)
        )
        const contentLength = request.headers['content-length']
        if (contentLength) {
          const declaredBytes = Number(contentLength)
          if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
            return yield* Effect.fail(
              new DomainError('VALIDATION_ERROR', 'File size is invalid', 400)
            )
          }

          if (declaredBytes > TERMINAL_MAX_UPLOAD_BYTES) {
            return yield* Effect.fail(
              new DomainError(
                'FILE_TOO_LARGE',
                `Files are limited to ${TERMINAL_MAX_UPLOAD_BYTES} bytes`,
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
          request.headers['content-type']?.split(';', 1)[0]?.toLowerCase() ?? ''
        const extension =
          requestedExtension ||
          UPLOAD_MIME_EXTENSIONS.get(requestContentType) ||
          ''
        const uploaded = yield* operation(() =>
          service.terminalUploadMutation(
            Effect.gen(function* () {
              const uploadDirectory = path.join(config.runtimeDir, 'uploads')
              yield* Effect.promise(() =>
                fs.mkdir(uploadDirectory, { recursive: true, mode: 0o700 })
              )
              yield* Effect.promise(() => fs.chmod(uploadDirectory, 0o700))
              yield* Effect.promise(() => pruneTerminalUploads(uploadDirectory))
              const filePath = path.join(
                uploadDirectory,
                `treeport-upload-${crypto.randomUUID()}${
                  extension ? `.${extension}` : ''
                }`
              )
              yield* Effect.acquireUseRelease(
                Effect.promise(() => fs.open(filePath, 'wx', 0o600)),
                (file) =>
                  Effect.gen(function* () {
                    let receivedBytes = 0
                    yield* Stream.runForEach(request.stream, (value) => {
                      receivedBytes += value.byteLength
                      if (receivedBytes > TERMINAL_MAX_UPLOAD_BYTES) {
                        return Effect.fail(
                          new DomainError(
                            'FILE_TOO_LARGE',
                            `Files are limited to ${TERMINAL_MAX_UPLOAD_BYTES} bytes`,
                            413
                          )
                        )
                      }

                      return Effect.promise(() => file.writeFile(value)).pipe(
                        Effect.asVoid
                      )
                    })
                  }),
                (file, exit) =>
                  Effect.promise(() =>
                    file
                      .close()
                      .finally(() =>
                        Exit.isFailure(exit)
                          ? fs.rm(filePath, { force: true })
                          : undefined
                      )
                  )
              )
              yield* Effect.promise(() =>
                pruneTerminalUploads(uploadDirectory, filePath)
              )
              return { file: { path: filePath } }
            })
          )
        )
        return jsonContractResponse(uploadedFileResponseSchema, uploaded, 201)
      })
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
        yield* operation(() =>
          service.terminals.deleteTerminal(params.terminalId!)
        )
        return jsonContractResponse(okResponseSchema, { ok: true })
      })
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
      Effect.succeed(HttpServerResponse.empty({ status: 404 }))
    ),
    route('GET', '*', fileResponse(path.join(staticRoot, 'index.html')))
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
