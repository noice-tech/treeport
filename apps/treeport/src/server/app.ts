import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { requestId, type RequestIdVariables } from 'hono/request-id'
import { validator } from 'hono/validator'
import { z } from 'zod'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import {
  browseDirectoryQuerySchema,
  browserAgentCommandSchema,
  browserTicketRequestSchema,
  createTerminalPresetSchema,
  createTerminalSchema,
  createWebPanelSchema,
  deleteTerminalPresetSchema,
  openWebPanelSchema,
  deleteWebPanelStorageSchema,
  DESKTOP_PROTOCOL_VERSION,
  getWebPanelStorageSchema,
  createWorktreeSchema,
  packageInstallSchema,
  packageProjectQuerySchema,
  packageReloadSchema,
  packageRemoveSchema,
  packageUpdateSchema,
  registerProjectSchema,
  requestWorkspaceOpenSchema,
  TERMINAL_MAX_UPLOAD_BYTES,
  removeWorktreeSchema,
  setWebPanelStorageSchema,
  terminalBellAcknowledgementSchema,
  terminalCaptureQuerySchema,
  updateProjectSchema,
  updateTerminalPresetSchema,
  updateTerminalSchema,
  updateWebPanelPermissionGrantSchema
} from '@treeport/shared'
import type { ApiErrorBody } from '@treeport/shared'
import type { AppConfig, TmuxAdapter, TreeportService } from './core/index'
import { DomainError } from './core/index'
import {
  webPanelBrowserOrigin,
  webPanelContentSecurityPolicy
} from './core/web-panel-csp'
import type { ApplicationUpdateManager } from './application-update'
import { TerminalMetadataManager } from './terminal-metadata'
import type { BrowserSessionManager } from './browser-sessions'

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
const terminalPresetDefinitionsQuerySchema = z.object({
  projectId: z.string().optional(),
  worktreeId: z.string().optional()
})
const operationQuerySchema = z.object({
  kind: z
    .enum([
      'create',
      'finish',
      'discard',
      'project_cleanup',
      'remove',
      'external_remove'
    ])
    .optional(),
  projectId: z.string().optional()
})
const discardStoredDataQuerySchema = z.object({
  discardStoredData: z.string().optional()
})

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
  tmux: TmuxAdapter
  applicationUpdate: ApplicationUpdateManager
  terminalMetadata?: TerminalMetadataManager
  browserSessions?: BrowserSessionManager
  webDist?: string
}

function jsonInput<T extends z.ZodType>(schema: T) {
  return zValidator('json', schema, (result) => {
    if (!result.success) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Request validation failed',
        400,
        z.flattenError(result.error)
      )
    }
  })
}

function queryInput<T extends z.ZodType>(schema: T) {
  return zValidator('query', schema, (result) => {
    if (!result.success) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Request validation failed',
        400,
        z.flattenError(result.error)
      )
    }
  })
}

export function createApp({
  service,
  config,
  tmux,
  applicationUpdate,
  terminalMetadata,
  browserSessions,
  webDist
}: AppDependencies) {
  const app = new Hono<{ Variables: RequestIdVariables }>()
  app.use(
    '/api/*',
    requestId({
      limitLength: 128,
      generator: () => crypto.randomUUID()
    })
  )
  const metadata =
    terminalMetadata ??
    new TerminalMetadataManager(service, tmux, config.tmuxPath)
  const metadataReady = metadata.initialize().catch((error) => {
    console.error(
      '[Treeport] Terminal metadata initialization failed:',
      error instanceof Error ? error.message : String(error)
    )
  })
  let terminalUploadQueue = Promise.resolve()

  app.onError((error, context) => {
    if (
      error instanceof HTTPException &&
      error.status === 400 &&
      error.message === 'Malformed JSON in request body'
    ) {
      return context.json(
        {
          error: {
            code: 'INVALID_JSON',
            message: 'Request body must be valid JSON'
          }
        },
        400
      )
    }

    if (error instanceof DomainError) {
      const body: ApiErrorBody = {
        error: { code: error.code, message: error.message }
      }
      if (error.details !== undefined) {
        body.error.details = error.details
      }

      return context.json(
        body,
        // SAFETY: The surrounding boundary contract establishes this asserted value.
        error.status as any
      )
    }

    const requestIdentifier = context.get('requestId') || crypto.randomUUID()
    context.header('X-Request-Id', requestIdentifier)
    console.error('[Treeport] API request failed', {
      requestId: requestIdentifier,
      method: context.req.method,
      path: new URL(context.req.url).pathname,
      status: 500,
      code: 'INTERNAL_ERROR',
      error: error instanceof Error ? error.message : String(error)
    })
    return context.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unexpected server error',
          details: { requestId: requestIdentifier }
        }
      },
      500
    )
  })

  const browserApi = new Hono()
    .get('/api/browser/status', async (context) => {
      if (!browserSessions) {
        throw new DomainError(
          'HOST_BROWSER_UNAVAILABLE',
          'Hosted browser service is unavailable',
          503
        )
      }

      return context.json(await browserSessions.status())
    })
    .post('/api/browser/install', async (context) => {
      if (!browserSessions) {
        throw new DomainError(
          'HOST_BROWSER_UNAVAILABLE',
          'Hosted browser service is unavailable',
          503
        )
      }

      return context.json({ message: await browserSessions.install() })
    })
    .delete('/api/browser/install', async (context) => {
      if (!browserSessions) {
        throw new DomainError(
          'HOST_BROWSER_UNAVAILABLE',
          'Hosted browser service is unavailable',
          503
        )
      }

      await browserSessions.remove()
      return context.json({ ok: true })
    })
    .put(
      '/api/worktrees/:worktreeId/web-panel-definitions/:definitionId/permission-grant',
      jsonInput(updateWebPanelPermissionGrantSchema),
      async (context) => {
        const body = context.req.valid('json')
        const definition = await service.setWebPanelPermissionGrant(
          context.req.param('worktreeId'),
          context.req.param('definitionId'),
          body.granted,
          body.permissions
        )
        return context.json({ definition })
      }
    )
    .post(
      '/api/panels/:panelId/browser-agent',
      jsonInput(browserAgentCommandSchema),
      async (context) => {
        if (!browserSessions) {
          throw new DomainError(
            'HOST_BROWSER_UNAVAILABLE',
            'Hosted browser service is unavailable',
            503
          )
        }

        return context.json({
          output: await browserSessions.agentCommand(
            context.req.param('panelId'),
            context.req.valid('json')
          )
        })
      }
    )
    .post(
      '/api/panels/:panelId/browser-ticket',
      jsonInput(browserTicketRequestSchema),
      async (context) => {
        if (!browserSessions) {
          throw new DomainError(
            'HOST_BROWSER_UNAVAILABLE',
            'Hosted browser service is unavailable',
            503
          )
        }

        return context.json({
          ticket: await browserSessions.issueTicket(
            context.req.param('panelId'),
            context.req.valid('json').clientId
          )
        })
      }
    )

  app.route('/', browserApi)

  const api = new Hono()
    .get('/api/health', (context) =>
      context.json({
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

    .get('/api/update', async (context) => {
      context.header('Cache-Control', 'no-store')
      return context.json(await applicationUpdate.status())
    })

    .post('/api/update', async (context) => {
      context.header('Cache-Control', 'no-store')
      return context.json(await applicationUpdate.start(), 202)
    })

    .get('/api/terminal-presets', async (context) =>
      context.json({ presets: await service.listTerminalPresets() })
    )

    .get(
      '/api/terminal-preset-definitions',
      queryInput(terminalPresetDefinitionsQuerySchema),
      async (context) =>
        context.json(
          await service.listTerminalPresetDefinitions(
            context.req.valid('query')
          )
        )
    )

    .post(
      '/api/terminal-presets',
      jsonInput(createTerminalPresetSchema),
      async (context) => {
        const body = context.req.valid('json')
        return context.json(
          { preset: await service.createTerminalPreset(body) },
          201
        )
      }
    )

    .patch(
      '/api/terminal-presets/:presetId',
      jsonInput(updateTerminalPresetSchema),
      async (context) => {
        const body = context.req.valid('json')
        const { expectedUpdatedAt, ...presetInput } = body
        return context.json({
          preset: await service.updateTerminalPreset(
            context.req.param('presetId'),
            presetInput,
            expectedUpdatedAt
          )
        })
      }
    )

    .delete(
      '/api/terminal-presets/:presetId',
      jsonInput(deleteTerminalPresetSchema),
      async (context) => {
        const body = context.req.valid('json')
        await service.deleteTerminalPreset(
          context.req.param('presetId'),
          body.expectedUpdatedAt
        )
        return context.json({ ok: true })
      }
    )

    .get('/api/packages', async (context) =>
      context.json(await service.listPackages())
    )

    .get(
      '/api/packages/project',
      queryInput(packageProjectQuerySchema),
      async (context) =>
        context.json({
          project: await service.resolveRegisteredProject(
            context.req.valid('query').path
          )
        })
    )

    .post(
      '/api/packages/install',
      jsonInput(packageInstallSchema),
      async (context) => {
        const body = context.req.valid('json')
        return context.json({
          result: await service.installPackage(body.source, body.projectId)
        })
      }
    )

    .post(
      '/api/packages/remove',
      jsonInput(packageRemoveSchema),
      async (context) => {
        const body = context.req.valid('json')
        return context.json({
          result: await service.removePackage(body.source, body.projectId)
        })
      }
    )

    .post(
      '/api/packages/update',
      jsonInput(packageUpdateSchema),
      async (context) => {
        const body = context.req.valid('json')
        return context.json({
          results: await service.updatePackages(body.source)
        })
      }
    )

    .post(
      '/api/packages/reload',
      jsonInput(packageReloadSchema),
      async (context) => {
        const body = context.req.valid('json')
        return context.json(await service.reloadPackages(body.projectId))
      }
    )

    .get('/api/projects', async (context) =>
      context.json({ projects: await service.listProjects() })
    )

    .get('/api/projects/recent', async (context) =>
      context.json({ projects: await service.listRecentProjects() })
    )

    .get(
      '/api/filesystem/directories',
      queryInput(browseDirectoryQuerySchema),
      async (context) => {
        const query = context.req.valid('query')
        return context.json(
          await service.browseDirectory(query.input, query.hidden)
        )
      }
    )

    .post(
      '/api/projects',
      jsonInput(registerProjectSchema),
      async (context) => {
        const body = context.req.valid('json')
        const registered = await service.registerProject(body.path, body.name)
        return context.json(
          { project: await service.getProjectSnapshot(registered.id) },
          201
        )
      }
    )

    .post('/api/projects/:projectId/open', async (context) =>
      context.json({
        project: await service.openProject(context.req.param('projectId'))
      })
    )

    .post('/api/projects/:projectId/close', async (context) => {
      await service.closeProject(context.req.param('projectId'))
      return context.json({ ok: true })
    })

    .delete('/api/projects/:projectId/recent', async (context) => {
      await service.dismissRecentProject(context.req.param('projectId'))
      return context.json({ ok: true })
    })

    .get('/api/projects/:projectId', async (context) =>
      context.json({
        project: await service.getProjectSnapshot(
          context.req.param('projectId')
        )
      })
    )

    .patch(
      '/api/projects/:projectId',
      jsonInput(updateProjectSchema),
      async (context) => {
        const body = context.req.valid('json')
        const projectId = context.req.param('projectId')
        await service.updateProjectColor(projectId, body.color)
        return context.json({
          project: await service.getProjectSnapshot(projectId)
        })
      }
    )

    .post('/api/projects/:projectId/refresh', async (context) => {
      const projectId = context.req.param('projectId')
      await service.refreshProject(projectId)
      return context.json({
        project: await service.getProjectSnapshot(projectId)
      })
    })

    .delete('/api/projects/:projectId', async (context) => {
      await service.deleteProject(context.req.param('projectId'))
      return context.json({ ok: true })
    })

    .get('/api/projects/:projectId/worktrees', async (context) =>
      context.json({
        worktrees: (
          await service.getProjectSnapshot(context.req.param('projectId'))
        ).worktrees
      })
    )

    .post(
      '/api/projects/:projectId/worktree-operations',
      jsonInput(createWorktreeSchema),
      async (context) => {
        const body = context.req.valid('json')
        let initialTerminal:
          | NonNullable<Parameters<TreeportService['beginCreateWorktree']>[3]>
          | undefined
        if (body.initialTerminal) {
          initialTerminal = { name: body.initialTerminal.name }
          if (body.initialTerminal.argv) {
            initialTerminal.argv = body.initialTerminal.argv
          }

          if (body.initialTerminal.returnToShell) {
            initialTerminal.returnToShell = true
          }

          if (body.initialTerminal.initialSize) {
            initialTerminal.initialSize = body.initialTerminal.initialSize
          }
        }

        return context.json(
          {
            operation: await service.beginCreateWorktree(
              context.req.param('projectId'),
              body.name,
              body.base,
              initialTerminal,
              body.sourceWorktreeId
            )
          },
          202
        )
      }
    )

    .get('/api/worktrees/:worktreeId', async (context) => {
      const worktreeId = context.req.param('worktreeId')
      await service.refreshPr(worktreeId, false)
      return context.json({
        worktree: await service.getWorktreeSnapshot(worktreeId)
      })
    })

    .post(
      '/api/worktrees/:worktreeId/open',
      jsonInput(requestWorkspaceOpenSchema),
      async (context) => {
        await service.requestWorkspaceOpen(
          context.req.param('worktreeId'),
          context.req.valid('json').sourceTerminalId
        )
        return context.json({ ok: true })
      }
    )

    .get('/api/worktrees/:worktreeId/web-panel-definitions', async (context) =>
      context.json({
        definitions: await service.listWebPanelDefinitions(
          context.req.param('worktreeId')
        )
      })
    )

    .post(
      '/api/worktrees/:worktreeId/panels',
      jsonInput(createWebPanelSchema),
      async (context) => {
        const body = context.req.valid('json')
        return context.json(
          {
            panel: await service.createWebPanel(
              context.req.param('worktreeId'),
              body.definitionId,
              {
                input: body.input ?? null,
                cwd: body.launchCwd ?? null
              }
            )
          },
          201
        )
      }
    )

    .post(
      '/api/worktrees/:worktreeId/panels/open',
      jsonInput(openWebPanelSchema),
      async (context) => {
        const body = context.req.valid('json')
        return context.json(
          await service.openWebPanel(
            context.req.param('worktreeId'),
            body.definitionId,
            {
              input: body.input ?? null,
              cwd: body.launchCwd ?? null
            },
            body.newInstance ?? false,
            body.sourceTerminalId ?? null
          )
        )
      }
    )

    .delete(
      '/api/panels/:panelId',
      queryInput(discardStoredDataQuerySchema),
      async (context) => {
        await service.deleteWebPanel(
          context.req.param('panelId'),
          context.req.valid('query').discardStoredData === 'true'
        )
        return context.json({ ok: true })
      }
    )

    .get('/api/panels/:panelId/context', async (context) =>
      context.json({
        context: await service.getWebPanelContext(context.req.param('panelId'))
      })
    )

    .get('/api/panels/:panelId/diff', async (context) =>
      context.json({
        diff: await service.getWebPanelDiff(context.req.param('panelId'))
      })
    )

    .get('/api/panels/:panelId/network/listeners', async (context) =>
      context.json({
        discovery: await service.getWebPanelListeners(
          context.req.param('panelId')
        )
      })
    )

    .get('/api/panels/:panelId/storage', async (context) =>
      context.json({
        hasData: await service.hasWebPanelStorage(context.req.param('panelId'))
      })
    )

    .post(
      '/api/panels/:panelId/storage/get',
      jsonInput(getWebPanelStorageSchema),
      async (context) => {
        const body = context.req.valid('json')
        return context.json({
          value: await service.getWebPanelStorage(
            context.req.param('panelId'),
            body.key
          )
        })
      }
    )

    .put(
      '/api/panels/:panelId/storage',
      jsonInput(setWebPanelStorageSchema),
      async (context) => {
        const body = context.req.valid('json')
        await service.setWebPanelStorage(
          context.req.param('panelId'),
          body.key,
          body.value
        )
        return context.json({ ok: true })
      }
    )

    .delete(
      '/api/panels/:panelId/storage',
      jsonInput(deleteWebPanelStorageSchema),
      async (context) => {
        const body = context.req.valid('json')
        await service.deleteWebPanelStorage(
          context.req.param('panelId'),
          body.key
        )
        return context.json({ ok: true })
      }
    )

    .get('/api/web-panels/:panelId/assets/*', async (context) => {
      const pathname = new URL(context.req.url).pathname
      const assetMarker = `/api/web-panels/${encodeURIComponent(
        context.req.param('panelId')
      )}/assets/`
      const requestedPath = decodeURI(
        pathname.slice(pathname.indexOf(assetMarker) + assetMarker.length)
      )
      const resolution = await service.resolveWebPanelAsset(
        context.req.param('panelId'),
        requestedPath
      )
      if (resolution.kind === 'redirect') {
        context.header('cache-control', 'no-store')
        return context.redirect(resolution.location, 307)
      }

      const browserOrigin = webPanelBrowserOrigin({
        referrer: context.req.header('referer'),
        forwardedHost: context.req.header('x-forwarded-host'),
        host: context.req.header('host'),
        forwardedProtocol: context.req.header('x-forwarded-proto'),
        requestProtocol: new URL(context.req.url).protocol
      })

      if (resolution.kind === 'error') {
        context.header('content-type', 'text/html; charset=utf-8')
        context.header('cache-control', 'no-store')
        context.header('x-content-type-options', 'nosniff')
        context.header(
          'content-security-policy',
          webPanelContentSecurityPolicy(
            'error',
            browserOrigin,
            resolution.allowNetworkRequests
          )
        )
        return context.html(resolution.html, 500)
      }

      const extension = path.extname(resolution.path).toLowerCase()
      const body = await fs.readFile(resolution.path)
      const mimeTypes = new Map([
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
        ['.woff2', 'font/woff2']
      ])

      context.header(
        'content-type',
        mimeTypes.get(extension) ?? 'application/octet-stream'
      )
      context.header('cache-control', 'public, max-age=31536000, immutable')
      context.header('access-control-allow-origin', '*')
      context.header(
        'content-security-policy',
        webPanelContentSecurityPolicy(
          'immutable',
          browserOrigin,
          resolution.allowNetworkRequests
        )
      )
      context.header('x-content-type-options', 'nosniff')
      // SAFETY: The surrounding boundary contract establishes this asserted value.
      return context.body(body as any)
    })

    .post(
      '/api/worktrees/:worktreeId/terminals',
      jsonInput(createTerminalSchema),
      async (context) => {
        const body = context.req.valid('json')
        const options: NonNullable<
          Parameters<TreeportService['createTerminal']>[3]
        > = {}
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
          options.env = body.env
        }

        if (body.shellCommand) {
          options.shellCommand = body.shellCommand
        }

        const terminal = await service.createTerminal(
          context.req.param('worktreeId'),
          body.name,
          body.argv,
          Object.keys(options).length > 0 ? options : undefined
        )
        return context.json({ terminal }, 201)
      }
    )

    .get('/api/worktrees/:worktreeId/remove-preview', async (context) =>
      context.json({
        preview: await service.removePreview(context.req.param('worktreeId'))
      })
    )

    .post(
      '/api/worktrees/:worktreeId/remove',
      jsonInput(removeWorktreeSchema),
      async (context) => {
        const body = context.req.valid('json')
        return context.json(
          {
            operation: await service.beginRemove(
              context.req.param('worktreeId'),
              body
            )
          },
          202
        )
      }
    )

    .post('/api/worktrees/:worktreeId/pr/refresh', async (context) =>
      context.json({
        pr: await service.refreshPr(context.req.param('worktreeId'), true)
      })
    )

    .get(
      '/api/terminals/:terminalId/capture',
      queryInput(terminalCaptureQuerySchema),
      async (context) => {
        const query = context.req.valid('query')
        const terminal = await service.getTerminal(
          context.req.param('terminalId')
        )
        const worktree = await service.getWorktree(terminal.worktreeId)
        const content = await tmux.capturePane(
          worktree.tmuxSocketName,
          terminal.tmuxSessionName,
          query.lines
        )
        if (content === null) {
          throw new DomainError(
            'TERMINAL_CAPTURE_UNAVAILABLE',
            'Terminal pane is unavailable',
            409,
            { terminalId: terminal.id }
          )
        }

        return context.json({
          terminalId: terminal.id,
          capturedAt: new Date().toISOString(),
          lineLimit: query.lines,
          content
        })
      }
    )

    .get('/api/terminals/:terminalId', async (context) => {
      const terminal = await service.refreshTerminalStatus(
        context.req.param('terminalId')
      )
      await metadataReady
      const worktree = await service.getWorktree(terminal.worktreeId)
      await metadata.trackTerminal(terminal, worktree)

      return context.json({ terminal, metadata: metadata.get(terminal.id) })
    })

    .post(
      '/api/terminals/:terminalId/bell/acknowledge',
      jsonInput(terminalBellAcknowledgementSchema),
      async (context) => {
        const terminalId = context.req.param('terminalId')
        const body = context.req.valid('json')
        await metadataReady
        await service.getTerminal(terminalId)
        await metadata.acknowledgeBell(terminalId, body.sequence)
        return context.json({ ok: true })
      }
    )

    .post('/api/terminals/:terminalId/files', async (context) => {
      await service.getTerminal(context.req.param('terminalId'))

      const contentLength = context.req.header('content-length')
      if (contentLength) {
        const declaredBytes = Number(contentLength)
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
          throw new DomainError('VALIDATION_ERROR', 'File size is invalid', 400)
        }

        if (declaredBytes > TERMINAL_MAX_UPLOAD_BYTES) {
          throw new DomainError(
            'FILE_TOO_LARGE',
            `Files are limited to ${TERMINAL_MAX_UPLOAD_BYTES} bytes`,
            413
          )
        }
      }

      const requestedExtension = context.req
        .header('x-treeport-file-extension')
        ?.toLowerCase()
      if (requestedExtension && !/^[a-z0-9]{1,16}$/.test(requestedExtension)) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'File extension is invalid',
          400
        )
      }

      const waitForPreviousUpload = terminalUploadQueue
      let releaseUpload!: () => void
      terminalUploadQueue = new Promise<void>((resolve) => {
        releaseUpload = resolve
      })
      await waitForPreviousUpload

      try {
        const contentType =
          context.req.header('content-type')?.split(';', 1)[0]?.toLowerCase() ??
          ''
        const extension =
          requestedExtension || UPLOAD_MIME_EXTENSIONS.get(contentType) || ''
        const uploadDirectory = path.join(config.runtimeDir, 'uploads')
        await fs.mkdir(uploadDirectory, { recursive: true, mode: 0o700 })
        await fs.chmod(uploadDirectory, 0o700)
        await pruneTerminalUploads(uploadDirectory)
        const filePath = path.join(
          uploadDirectory,
          `treeport-upload-${crypto.randomUUID()}${
            extension ? `.${extension}` : ''
          }`
        )
        const file = await fs.open(filePath, 'wx', 0o600)
        let complete = false
        let receivedBytes = 0
        try {
          const reader = context.req.raw.body?.getReader()
          if (reader) {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                break
              }

              receivedBytes += value.byteLength
              if (receivedBytes > TERMINAL_MAX_UPLOAD_BYTES) {
                throw new DomainError(
                  'FILE_TOO_LARGE',
                  `Files are limited to ${TERMINAL_MAX_UPLOAD_BYTES} bytes`,
                  413
                )
              }

              await file.writeFile(value)
            }
          }

          complete = true
        } finally {
          await file.close()
          if (!complete) {
            await fs.rm(filePath, { force: true })
          }
        }

        await pruneTerminalUploads(uploadDirectory, filePath)
        return context.json({ file: { path: filePath } }, 201)
      } finally {
        releaseUpload()
      }
    })

    .patch(
      '/api/terminals/:terminalId',
      jsonInput(updateTerminalSchema),
      async (context) => {
        const body = context.req.valid('json')
        return context.json({
          terminal: await service.renameTerminal(
            context.req.param('terminalId'),
            body.name
          )
        })
      }
    )

    .delete('/api/terminals/:terminalId', async (context) => {
      await service.deleteTerminal(context.req.param('terminalId'))
      return context.json({ ok: true })
    })

    .get(
      '/api/operations',
      validator('query', (value) => {
        const parsed = operationQuerySchema.safeParse(value)
        if (!parsed.success) {
          throw new DomainError(
            'INVALID_OPERATION_KIND',
            'Invalid operation query',
            400
          )
        }

        return parsed.data
      }),
      async (context) => {
        const query = context.req.valid('query')
        const filters: Parameters<TreeportService['listActiveOperations']>[0] =
          {}
        if (query.projectId) {
          filters.projectId = query.projectId
        }

        if (query.kind) {
          filters.kind = query.kind
        }

        return context.json({
          operations: await service.listActiveOperations(filters)
        })
      }
    )

    .get('/api/operations/:operationId', async (context) =>
      context.json({
        operation: await service.getOperation(context.req.param('operationId'))
      })
    )

    .post('/api/admin/terminate-terminals', async (context) =>
      context.json({ terminated: await service.terminateAllTerminals() })
    )

    .all('/api/*', (context) =>
      context.json(
        { error: { code: 'NOT_FOUND', message: 'API endpoint not found' } },
        404
      )
    )

  const routes = app.route('/', api)

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const builtStaticRoot = path.resolve(moduleDirectory, '../../web')
  const sourceStaticRoot = path.resolve(moduleDirectory, '../../dist/web')
  const staticRoot =
    webDist ??
    config.webDist ??
    (existsSync(builtStaticRoot) ? builtStaticRoot : sourceStaticRoot)
  app.use('/assets/*', serveStatic({ root: staticRoot }))
  app.get(
    '/manifest.webmanifest',
    serveStatic({ root: staticRoot, path: 'manifest.webmanifest' })
  )

  // A 404 here makes browsers unregister service workers left over from
  // when the web app shipped one; the SPA fallback would keep them alive.
  app.get('/sw.js', (c) => c.body(null, 404))

  app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }))

  return routes
}

export type AppType = ReturnType<typeof createApp>
