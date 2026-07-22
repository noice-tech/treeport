import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { upgradeWebSocket } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import {
  createTerminalSchema,
  createWorktreeSchema,
  registerProjectSchema,
  TERMINAL_MAX_UPLOAD_BYTES,
  removeWorktreeSchema,
  spawnSchema,
  updateProjectSchema,
  updateTerminalSchema
} from '@tasktty/shared'
import type { ProductEvent } from '@tasktty/shared'
import type { AppConfig, TmuxAdapter, TaskTTYService } from '@tasktty/core'
import { DomainError } from '@tasktty/core'
import { TerminalAttachmentManager } from './attachments.js'
import { TerminalMetadataManager } from './terminal-metadata.js'

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
          (entry) => entry.isFile() && entry.name.startsWith('tasktty-upload-')
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
  service: TaskTTYService
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
      '[TaskTTY] Terminal metadata initialization failed:',
      error instanceof Error ? error.message : String(error)
    )
  })
  const attachments = new TerminalAttachmentManager(
    service,
    tmux,
    config.tmuxPath,
    metadata
  )
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
      '[TaskTTY]',
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

  app.get('/api/health', (context) => context.json({ ok: true, version: 1 }))

  app.get('/api/projects', async (context) =>
    context.json({ projects: await service.listProjects() })
  )

  app.get('/api/projects/recent', (context) =>
    context.json({ projects: service.listRecentProjects() })
  )

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
    service.updateProjectColor(projectId, body.color)
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

  app.get('/api/projects/:projectId/worktree-destination', async (context) => {
    const name = context.req.query('name')
    if (!name) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Worktree name is required',
        400
      )
    }

    return context.json({
      destination: await service.previewWorktreePath(
        context.req.param('projectId'),
        name
      )
    })
  })

  app.post('/api/projects/:projectId/worktrees', async (context) => {
    const body = await input(context, createWorktreeSchema)
    const initialTerminal = body.initialTerminal
      ? {
          name: body.initialTerminal.name,
          ...(body.initialTerminal.argv
            ? { argv: body.initialTerminal.argv }
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
      body.argv
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

  app.get('/api/terminals/:terminalId', async (context) => {
    const terminal = await service.refreshTerminalStatus(
      context.req.param('terminalId')
    )
    await metadataReady
    const worktree = service.database.worktree(terminal.worktreeId)
    if (worktree) {
      await metadata.trackTerminal(terminal, worktree)
    }

    return context.json({ terminal, metadata: metadata.get(terminal.id) })
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
      .header('x-tasktty-file-extension')
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
        `tasktty-upload-${crypto.randomUUID()}${extension ? `.${extension}` : ''}`
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

  app.get('/api/operations/:operationId', (context) =>
    context.json({
      operation: service.getOperation(context.req.param('operationId'))
    })
  )

  app.get('/api/events', (context) =>
    streamSSE(context, async (stream) => {
      const queuedEvents: ProductEvent[] = []
      let connected = false
      let aborted = false
      let heartbeat: NodeJS.Timeout | null = null
      let writeQueue = Promise.resolve()
      let resolveAbort!: () => void
      const abort = new Promise<void>((resolve) => {
        resolveAbort = resolve
      })
      const stop = () => {
        aborted = true
        resolveAbort()
      }
      stream.onAbort(stop)
      const writeSSE = (message: Parameters<typeof stream.writeSSE>[0]) => {
        writeQueue = writeQueue.then(() => stream.writeSSE(message))
        return writeQueue
      }
      const writeEvent = (event: ProductEvent) =>
        writeSSE({
          id: event.id,
          event: event.type,
          data: JSON.stringify(event)
        })
      const unsubscribe = service.events.subscribe((event) => {
        if (connected && !aborted) {
          void writeEvent(event).catch(stop)
        } else if (!aborted) {
          queuedEvents.push(event)
        }
      })
      try {
        await metadataReady
        if (aborted) {
          return
        }

        const terminalMetadata = metadata.snapshot()
        const representedEventCount = queuedEvents.length
        await writeSSE({
          event: 'connected',
          data: JSON.stringify({
            at: new Date().toISOString(),
            terminalMetadata
          })
        })
        queuedEvents.splice(0, representedEventCount)
        while (queuedEvents.length) {
          await writeEvent(queuedEvents.shift()!)
        }
        connected = true
        heartbeat = setInterval(
          () => void writeSSE({ event: 'heartbeat', data: '{}' }).catch(stop),
          15_000
        )
        await abort
      } finally {
        if (heartbeat) {
          clearInterval(heartbeat)
        }

        unsubscribe()
      }
    })
  )

  app.get(
    '/api/terminals/:terminalId/attach',
    upgradeWebSocket((context) => {
      const terminalId = context.req.param('terminalId')!
      let connectionId: string | null = null
      return {
        onOpen(_event, ws) {
          connectionId = attachments.accept(terminalId, ws)
        },
        onMessage(event) {
          if (connectionId) {
            attachments.message(connectionId, event.data)
          }
        },
        onClose() {
          if (connectionId) {
            attachments.close(connectionId)
          }
        },
        onError() {
          if (connectionId) {
            attachments.close(connectionId)
          }
        }
      }
    })
  )

  app.all('/api/*', (context) =>
    context.json(
      { error: { code: 'NOT_FOUND', message: 'API endpoint not found' } },
      404
    )
  )

  const staticRoot =
    webDist ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  app.use('/assets/*', serveStatic({ root: staticRoot }))
  app.get(
    '/manifest.webmanifest',
    serveStatic({ root: staticRoot, path: 'manifest.webmanifest' })
  )

  app.get('/sw.js', serveStatic({ root: staticRoot, path: 'sw.js' }))

  app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }))

  return app
}
