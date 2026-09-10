import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { Type, type Static } from 'typebox'
import { runTreeportJson } from './treeport-cli.ts'

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
      daemonLifecycle: Type.Union([
        Type.Literal('treeport'),
        Type.Literal('service'),
        Type.Literal('external')
      ]),
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
  let guidance: string | null = null
  let lastWarning: string | null = null
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let lifecycle: AbortController | null = null
  let refreshing = false

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

        guidance = null
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
        guidance = null
        lastWarning = null
        clearBadge(sessionContext)
        return
      }

      const detected = managedContext(detectedValue)
      if (!detected) {
        guidance = null
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

      const guidanceLines = [
        'Treeport context:',
        'You are working inside Treeport, a worktree-first workspace. This Pi session runs in a persistent terminal managed by Treeport.',
        `Your current Treeport project is ${JSON.stringify(
          detected.project.name
        )} and your tree is ${JSON.stringify(detected.worktree.name)}.`,
        'A project is a registered repository or folder. A tree is its main checkout or a linked Git worktree.',
        'Treeport provides persistent terminals for shells, development servers, and other agents. You can start processes, inspect their status, read their output, and wait for runtime conditions. The user can view and take control of these terminals.',
        'Treeport has browser support. You can open and control visible browser tabs, navigate pages, interact with page elements, inspect accessibility snapshots, and capture screenshots, console messages, and network requests. You and the user share the same live page.',
        'Treeport can manage projects and trees, including creating a separate tree and terminal for independent work.',
        'Use the `treeport` CLI through bash for Treeport operations. When you need command syntax or options, consult `treeport --help`, `treeport <area> --help`, or `treeport <area> <command> --help` (for example, `treeport browser --help` or `treeport terminal --help`).',
        'Delete a terminal only when the user asks to stop or close its process. Never delete this Pi session terminal.',
        'Leave browser tabs open for user inspection. Do not install a browser runtime without user approval.',
        'Do not put secrets in browser URLs or command arguments.'
      ]
      // Publish the complete snapshot atomically. Discovery never edits history,
      // including when a user submits while the context CLI call is in flight.
      guidance = guidanceLines.join('\n')

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
    guidance = null
    refreshing = false
    lastWarning = null
    // Warm the cache during initialization, without adding a transcript entry.
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
    // Do not move the CLI delay to Pi's completion/idle notification either.
    void refreshContext(sessionContext)
  })

  // Submission is the opt-in. Input runs before the user message is appended;
  // startup, reload, and merely browsing /tree must not create new entries.
  pi.on('input', (_event, sessionContext) => {
    // Never await discovery here. Use the last completed snapshot; a background
    // refresh can only affect a later submission, not this request's prefix.
    if (guidance && sessionContext.isIdle()) {
      // Compare the latest context on this branch, not all entries or process state.
      // A -> B -> A needs an update even though A already exists earlier in history.
      const previous = sessionContext.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === 'custom_message' &&
            entry.customType === 'treeport-context'
        )
        .pop()
      if (
        previous?.type !== 'custom_message' ||
        previous.content !== guidance
      ) {
        // Hidden in chat, retained in /tree and model context. Never rewrite older
        // entries (including their display flag) or insert at the conversation top.
        pi.sendMessage(
          { customType: 'treeport-context', content: guidance, display: false },
          { triggerTurn: false }
        )
      }
    }

    return { action: 'continue' }
  })

  pi.on('session_shutdown', (_event, sessionContext) => {
    if (refreshTimer) {
      clearInterval(refreshTimer)
    }

    refreshTimer = null
    lifecycle?.abort()
    guidance = null
    clearBadge(sessionContext)
  })
}
