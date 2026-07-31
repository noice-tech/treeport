import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { serveStatic } from '@hono/node-server/serve-static'
import {
  browseDirectoryQuerySchema,
  createTerminalPresetSchema,
  createTerminalSchema,
  deleteTerminalPresetSchema,
  DESKTOP_PROTOCOL_VERSION,
  createWorktreeSchema,
  registerProjectSchema,
  TERMINAL_MAX_UPLOAD_BYTES,
  removeWorktreeSchema,
  spawnSchema,
  terminalBellAcknowledgementSchema,
  terminalCaptureQuerySchema,
  updateProjectSchema,
  updateTerminalPresetSchema,
  updateTerminalSchema
} from '@treeport/shared'
import type { AppConfig, TmuxAdapter, TreeportService } from './core/index'
import { DomainError } from './core/index'
import { TerminalMetadataManager } from './terminal-metadata'

const UPLOAD_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/plain': 'txt'
}
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
  tmux: TmuxAdapter
  terminalMetadata?: TerminalMetadataManager
  webDist?: string
}

async function input<T>(context: Context, schema: ZodType<T>): Promise<T> {
  let body: unknown
  try {
    body = await context.req.json()
  } catch {
    throw new DomainError(
      'INVALID_JSON',
      'Request body must be valid JSON',
      400
    )
  }
  const result = schema.safeParse(body)
  if (!result.success) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Request validation failed',
      400,
      result.error.flatten()
    )
  }

  return result.data
}

export function createApp({
  service,
  config,
  tmux,
  terminalMetadata,
  webDist
}: AppDependencies): Hono {
  const app = new Hono()
  const metadata =
    terminalMetadata ??
    new TerminalMetadataManager(service, tmux, config.tmuxPath)
  const metadataReady = metadata.initialize().catch((error: unknown) => {
    console.error(
      '[Treeport] Terminal metadata initialization failed:',
      error instanceof Error ? error.message : String(error)
    )
  })
  let terminalUploadQueue = Promise.resolve()

  app.onError((error, context) => {
    if (error instanceof DomainError) {
      return context.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details })
          }
        },
        error.status as any
      )
    }

    console.error(
      '[Treeport]',
      error instanceof Error ? error.message : String(error)
    )
    return context.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message:
            error instanceof Error ? error.message : 'Unexpected server error'
        }
      },
      500
    )
  })

  app.get('/api/health', (context) =>
    context.json({
      ok: true,
      version: config.appVersion ?? 'development',
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      hostname: os.hostname(),
      pid: process.pid,
      instanceId: config.instanceId ?? null,
      installationMethod: config.installationMethod ?? 'development',
      url: config.apiUrl
    })
  )

  app.get('/api/terminal-presets', async (context) =>
    context.json({ presets: await service.listTerminalPresets() })
  )

  app.post('/api/terminal-presets', async (context) => {
    const body = await input(context, createTerminalPresetSchema)
    return context.json(
      { preset: await service.createTerminalPreset(body) },
      201
    )
  })

  app.patch('/api/terminal-presets/:presetId', async (context) => {
    const body = await input(context, updateTerminalPresetSchema)
    const { expectedUpdatedAt, ...presetInput } = body
    return context.json({
      preset: await service.updateTerminalPreset(
        context.req.param('presetId'),
        presetInput,
        expectedUpdatedAt
      )
    })
  })

  app.delete('/api/terminal-presets/:presetId', async (context) => {
    const body = await input(context, deleteTerminalPresetSchema)
    await service.deleteTerminalPreset(
      context.req.param('presetId'),
      body.expectedUpdatedAt
    )
    return context.json({ ok: true })
  })

  app.get('/api/projects', async (context) =>
    context.json({ projects: await service.listProjects() })
  )

  app.get('/api/projects/recent', async (context) =>
    context.json({ projects: await service.listRecentProjects() })
  )

  app.get('/api/filesystem/directories', async (context) => {
    const result = browseDirectoryQuerySchema.safeParse(context.req.query())
    if (!result.success) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Request validation failed',
        400,
        result.error.flatten()
      )
    }

    return context.json(
      await service.browseDirectory(result.data.input, result.data.hidden)
    )
  })

  app.post('/api/projects', async (context) => {
    const body = await input(context, registerProjectSchema)
    const registered = await service.registerProject(body.path, body.name)
    return context.json(
      { project: await service.getProjectSnapshot(registered.id) },
      201
    )
  })

  app.post('/api/projects/:projectId/open', async (context) =>
    context.json({
      project: await service.openProject(context.req.param('projectId'))
    })
  )

  app.post('/api/projects/:projectId/close', async (context) => {
    await service.closeProject(context.req.param('projectId'))
    return context.json({ ok: true })
  })

  app.get('/api/projects/:projectId', async (context) =>
    context.json({
      project: await service.getProjectSnapshot(context.req.param('projectId'))
    })
  )

  app.patch('/api/projects/:projectId', async (context) => {
    const body = await input(context, updateProjectSchema)
    const projectId = context.req.param('projectId')
    await service.updateProjectColor(projectId, body.color)
    return context.json({
      project: await service.getProjectSnapshot(projectId)
    })
  })

  app.post('/api/projects/:projectId/refresh', async (context) => {
    const projectId = context.req.param('projectId')
    await service.refreshProject(projectId)
    return context.json({
      project: await service.getProjectSnapshot(projectId)
    })
  })

  app.delete('/api/projects/:projectId', async (context) => {
    await service.deleteProject(context.req.param('projectId'))
    return context.json({ ok: true })
  })

  app.get('/api/projects/:projectId/worktrees', async (context) =>
    context.json({
      worktrees: (
        await service.getProjectSnapshot(context.req.param('projectId'))
      ).worktrees
    })
  )

  app.post('/api/projects/:projectId/worktrees', async (context) => {
    const body = await input(context, createWorktreeSchema)
    const initialTerminal = body.initialTerminal
      ? {
          name: body.initialTerminal.name,
          ...(body.initialTerminal.argv
            ? { argv: body.initialTerminal.argv }
            : {}),
          ...(body.initialTerminal.returnToShell
            ? { returnToShell: true }
            : {}),
          ...(body.initialTerminal.initialSize
            ? { initialSize: body.initialTerminal.initialSize }
            : {})
        }
      : undefined
    const result = await service.createWorktree(
      context.req.param('projectId'),
      body.name,
      body.base,
      initialTerminal,
      body.sourceWorktreeId
    )
    return context.json(result, 201)
  })

  app.get('/api/worktrees/:worktreeId', async (context) => {
    const worktreeId = context.req.param('worktreeId')
    await service.refreshPr(worktreeId, false)
    return context.json({
      worktree: await service.getWorktreeSnapshot(worktreeId)
    })
  })

  app.post('/api/worktrees/:worktreeId/terminals', async (context) => {
    const body = await input(context, createTerminalSchema)
    const terminal = await service.createTerminal(
      context.req.param('worktreeId'),
      body.name,
      body.argv,
      body.returnToShell || body.closeOnSuccess || body.initialSize
        ? {
            ...(body.returnToShell ? { returnToShell: true } : {}),
            ...(body.closeOnSuccess ? { closeOnSuccess: true } : {}),
            ...(body.initialSize ? { initialSize: body.initialSize } : {})
          }
        : undefined
    )
    return context.json({ terminal }, 201)
  })

  app.get('/api/worktrees/:worktreeId/remove-preview', async (context) =>
    context.json({
      preview: await service.removePreview(context.req.param('worktreeId'))
    })
  )

  app.post('/api/worktrees/:worktreeId/remove', async (context) => {
    const body = await input(context, removeWorktreeSchema)
    return context.json(
      {
        operation: await service.beginRemove(
          context.req.param('worktreeId'),
          body
        )
      },
      202
    )
  })

  app.post('/api/worktrees/:worktreeId/pr/refresh', async (context) =>
    context.json({
      pr: await service.refreshPr(context.req.param('worktreeId'), true)
    })
  )

  app.get('/api/terminals/:terminalId/capture', async (context) => {
    const query = terminalCaptureQuerySchema.safeParse(context.req.query())
    if (!query.success) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Request validation failed',
        400,
        query.error.flatten()
      )
    }

    const terminal = await service.getTerminal(context.req.param('terminalId'))
    const worktree = await service.getWorktree(terminal.worktreeId)
    const content = await tmux.capturePane(
      worktree.tmuxSocketName,
      terminal.tmuxSessionName,
      query.data.lines
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
      lineLimit: query.data.lines,
      content
    })
  })

  app.get('/api/terminals/:terminalId', async (context) => {
    const terminal = await service.refreshTerminalStatus(
      context.req.param('terminalId')
    )
    await metadataReady
    const worktree = await service.database.worktree(terminal.worktreeId)
    if (worktree) {
      await metadata.trackTerminal(terminal, worktree)
    }

    return context.json({ terminal, metadata: metadata.get(terminal.id) })
  })

  app.post('/api/terminals/:terminalId/bell/acknowledge', async (context) => {
    const terminalId = context.req.param('terminalId')
    const body = await input(context, terminalBellAcknowledgementSchema)
    await metadataReady
    await service.getTerminal(terminalId)
    metadata.acknowledgeBell(terminalId, body.sequence)
    return context.json({ ok: true })
  })

  app.post('/api/terminals/:terminalId/files', async (context) => {
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
        requestedExtension || UPLOAD_MIME_EXTENSIONS[contentType] || ''
      const uploadDirectory = path.join(config.runtimeDir, 'uploads')
      await fs.mkdir(uploadDirectory, { recursive: true, mode: 0o700 })
      await fs.chmod(uploadDirectory, 0o700)
      await pruneTerminalUploads(uploadDirectory)
      const filePath = path.join(
        uploadDirectory,
        `treeport-upload-${crypto.randomUUID()}${extension ? `.${extension}` : ''}`
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

  app.patch('/api/terminals/:terminalId', async (context) => {
    const body = await input(context, updateTerminalSchema)
    return context.json({
      terminal: await service.renameTerminal(
        context.req.param('terminalId'),
        body.name
      )
    })
  })

  app.delete('/api/terminals/:terminalId', async (context) => {
    await service.deleteTerminal(context.req.param('terminalId'))
    return context.json({ ok: true })
  })

  app.post('/api/spawn', async (context) => {
    const body = await input(context, spawnSchema)
    const project = await service.resolveProject(body.project)
    const initialTerminal = {
      name: body.name,
      ...(body.argv ? { argv: body.argv } : {})
    }
    const result = await service.createWorktree(
      project.id,
      body.worktreeName,
      body.base,
      initialTerminal,
      body.sourceWorktreeId
    )
    return context.json(result, 201)
  })

  app.get('/api/operations/:operationId', async (context) =>
    context.json({
      operation: await service.getOperation(context.req.param('operationId'))
    })
  )

  app.post('/api/admin/terminate-terminals', async (context) =>
    context.json({ terminated: await service.terminateAllTerminals() })
  )

  app.all('/api/*', (context) =>
    context.json(
      { error: { code: 'NOT_FOUND', message: 'API endpoint not found' } },
      404
    )
  )

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

  return app
}
