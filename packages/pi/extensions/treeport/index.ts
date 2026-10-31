import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { Type, type Static } from 'typebox'
import { runTreeportJson } from './treeport-cli.ts'
import { registerTreeportTools, TREEPORT_GUIDELINES } from './tools.ts'

const CONTEXT_TIMEOUT_MS = 5_000
const CONTEXT_REFRESH_MS = 30_000

interface ManagedContext {
  project: {
    id: string
    name: string
  }
  worktree: {
    id: string
    projectId: string
    name: string
  }
  terminal: {
    id: string
    worktreeId: string
  }
}

const ContextSchema = Type.Union([
  Type.Object(
    {
      managed: Type.Literal(false),
      reason: Type.String()
    },
    { additionalProperties: true }
  ),
  Type.Object(
    {
      managed: Type.Literal(true),
      apiUrl: Type.String({ minLength: 1 }),
      project: Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          name: Type.String({ minLength: 1 }),
          kind: Type.Union([Type.Literal('repository'), Type.Literal('folder')])
        },
        { additionalProperties: true }
      ),
      worktree: Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          projectId: Type.String({ minLength: 1 }),
          name: Type.String({ minLength: 1 }),
          path: Type.String({ minLength: 1 })
        },
        { additionalProperties: true }
      ),
      terminal: Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          worktreeId: Type.String({ minLength: 1 }),
          name: Type.String({ minLength: 1 })
        },
        { additionalProperties: true }
      )
    },
    { additionalProperties: true }
  )
])

type ContextOutput = Static<typeof ContextSchema>

function managedContext(value: ContextOutput): ManagedContext | null {
  if (value.managed === false) {
    return null
  }

  if (
    value.worktree.projectId !== value.project.id ||
    value.terminal.worktreeId !== value.worktree.id
  ) {
    return null
  }

  let parsedApiUrl: URL

  try {
    parsedApiUrl = new URL(value.apiUrl)
  } catch {
    return null
  }

  if (!['http:', 'https:'].includes(parsedApiUrl.protocol)) {
    return null
  }

  return {
    project: value.project,
    worktree: value.worktree,
    terminal: value.terminal
  }
}

export default function treeportExtension(pi: ExtensionAPI): void {
  let badgeVisible = false
  let lastWarning: string | null = null
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let lifecycle: AbortController | null = null
  let refreshing = false

  const toolNames = registerTreeportTools(pi, ContextSchema)

  const enabledOnBranch = (ctx: ExtensionContext) =>
    ctx.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === 'custom' &&
          entry.customType === 'treeport-tools-enabled'
      )

  const restoreTools = (ctx: ExtensionContext) => {
    const others = pi
      .getActiveTools()
      .filter((name) => !toolNames.includes(name))

    pi.setActiveTools([
      ...new Set([
        ...others,
        'treeport_enable',
        ...(enabledOnBranch(ctx) ? toolNames : [])
      ])
    ])
  }

  pi.registerTool({
    name: 'treeport_enable',
    label: 'Enable Treeport',
    description:
      'Enable Treeport tools for persistent terminals, shared browser tabs, projects, and worktrees. Returns the current context. Tools are available on the next model request and callable from codemode.',
    promptSnippet:
      'Call treeport_enable before using Treeport terminals, browser tabs, projects, or worktrees. Prefer its typed tools over CLI help discovery.',
    promptGuidelines: TREEPORT_GUIDELINES,
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({
      enabled: Type.Array(Type.String()),
      context: ContextSchema
    }),
    async execute(_id, _params, signal, _update, ctx) {
      const context = await runTreeportJson(pi, ['context'], ContextSchema, {
        cwd: ctx.cwd,
        signal,
        timeout: CONTEXT_TIMEOUT_MS
      })

      if (context.managed && !managedContext(context)) {
        throw new Error('Treeport context is invalid. Tools were not enabled.')
      }

      signal?.throwIfAborted()
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...toolNames])])
      const active = new Set(pi.getActiveTools())
      const missing = toolNames.filter((name) => !active.has(name))

      if (missing.length > 0) {
        throw new Error(
          `Treeport tools could not be enabled: ${missing.join(', ')}`
        )
      }

      if (!enabledOnBranch(ctx)) {
        pi.appendEntry('treeport-tools-enabled', {})
      }

      const result = { enabled: toolNames, context }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        details: result
      }
    }
  })
  pi.on('session_tree', (_event, ctx) => restoreTools(ctx))

  const warn = (sessionContext: ExtensionContext, message: string) => {
    if (sessionContext.hasUI && lastWarning !== message) {
      sessionContext.ui.notify(message, 'warning')
    }

    lastWarning = message
  }

  const clearBadge = (sessionContext: ExtensionContext) => {
    if (badgeVisible) {
      sessionContext.ui.setStatus('treeport', undefined)
      badgeVisible = false
    }
  }

  const refreshContext = async (sessionContext: ExtensionContext) => {
    const currentLifecycle = lifecycle

    if (
      !currentLifecycle ||
      currentLifecycle.signal.aborted ||
      refreshing ||
      !sessionContext.isIdle()
    ) {
      return
    }

    refreshing = true
    const signal = currentLifecycle.signal

    try {
      let detectedValue: ContextOutput

      try {
        detectedValue = await runTreeportJson(pi, ['context'], ContextSchema, {
          cwd: sessionContext.cwd,
          signal,
          timeout: CONTEXT_TIMEOUT_MS
        })
      } catch {
        if (signal.aborted) {
          return
        }

        clearBadge(sessionContext)

        const injectedIds = [
          process.env.TREEPORT_PROJECT_ID,
          process.env.TREEPORT_WORKTREE_ID,
          process.env.TREEPORT_TERMINAL_ID
        ].some((value) => Boolean(value?.trim()))

        if (injectedIds && sessionContext.hasUI) {
          warn(
            sessionContext,
            'Treeport context is unavailable. The Treeport integration is inactive.'
          )
        }

        return
      }

      if (signal.aborted) {
        return
      }

      if (detectedValue.managed === false) {
        lastWarning = null
        clearBadge(sessionContext)

        return
      }

      const detected = managedContext(detectedValue)

      if (!detected) {
        clearBadge(sessionContext)

        const injectedIds = [
          process.env.TREEPORT_PROJECT_ID,
          process.env.TREEPORT_WORKTREE_ID,
          process.env.TREEPORT_TERMINAL_ID
        ].some((value) => Boolean(value?.trim()))

        if (injectedIds && sessionContext.hasUI) {
          warn(
            sessionContext,
            'Treeport context is invalid. The Treeport integration is inactive.'
          )
        }

        return
      }

      lastWarning = null

      if (sessionContext.hasUI) {
        sessionContext.ui.setStatus(
          'treeport',
          sessionContext.ui.theme.fg(
            'accent',
            `treeport · ${detected.worktree.name}`
          )
        )
        badgeVisible = true
      }
    } finally {
      if (lifecycle === currentLifecycle) {
        refreshing = false
      }
    }
  }

  pi.on('session_start', async (_event, sessionContext) => {
    if (refreshTimer) {
      clearInterval(refreshTimer)
    }

    lifecycle?.abort()
    const startedLifecycle = new AbortController()
    lifecycle = startedLifecycle
    refreshTimer = null
    restoreTools(sessionContext)
    refreshing = false
    lastWarning = null
    await refreshContext(sessionContext)

    if (startedLifecycle.signal.aborted) {
      return
    }

    refreshTimer = setInterval(() => {
      void refreshContext(sessionContext)
    }, CONTEXT_REFRESH_MS)
    refreshTimer.unref()
  })

  pi.on('agent_settled', (_event, sessionContext) => {
    void refreshContext(sessionContext)
  })

  pi.on('session_shutdown', (_event, sessionContext) => {
    if (refreshTimer) {
      clearInterval(refreshTimer)
    }

    refreshTimer = null
    lifecycle?.abort()
    clearBadge(sessionContext)
  })
}
