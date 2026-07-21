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

  app.get('/api/terminals/:terminalId', async (context) =>
    context.json({
      terminal: await service.refreshTerminalStatus(
        context.req.param('terminalId')
      )
    })
  )

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
      let resolveAbort!: () => void
      const abort = new Promise<void>((resolve) => {
        resolveAbort = resolve
      })
      stream.onAbort(() => {
        aborted = true
        resolveAbort()
      })
      const writeEvent = (event: ProductEvent) =>
        stream.writeSSE({
          id: event.id,
          event: event.type,
          data: JSON.stringify(event)
        })
      const unsubscribe = service.events.subscribe((event) => {
        if (connected && !aborted) {
          void writeEvent(event)
        } else if (!aborted) {
          queuedEvents.push(event)
        }
      })
      try {
        await metadataReady
        if (aborted) {
          return
        }

        await stream.writeSSE({
          event: 'connected',
          data: JSON.stringify({
            at: new Date().toISOString(),
            terminalMetadata: metadata.snapshot()
          })
        })
        while (queuedEvents.length) {
          await writeEvent(queuedEvents.shift()!)
        }
        connected = true
        heartbeat = setInterval(
          () => void stream.writeSSE({ event: 'heartbeat', data: '{}' }),
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
