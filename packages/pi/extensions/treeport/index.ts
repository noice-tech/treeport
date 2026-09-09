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
        'Treeport is a worktree-first workspace for projects, trees, persistent terminals, and browser tabs.',
        'A project is a registered repository or folder. A tree is its main checkout or a linked Git worktree.',
        `This session runs in project ${JSON.stringify(
          detected.project.name
        )} and tree ${JSON.stringify(detected.worktree.name)}.`,
        'Use the `treeport` CLI through bash for Treeport operations. Use `--json` when you must parse a result.',
        'Use bash directly for finite commands that Pi must await.',
        'For a persistent process, run `treeport terminal create --worktree . --name <name> -- <program> <arg> ...`.',
        'Pass the child program and its arguments after `--`. Do not use an implicit shell command string.',
        'Observe persistent terminals with `treeport terminal inspect`, `treeport terminal capture`, or `treeport terminal wait`.',
        'Do not poll through repeated model calls. Sleep and capture in one bash call, such as `sleep 5; treeport terminal capture <id>`.',
        '`treeport terminal wait --until idle` observes OSC progress. It is not a readiness check and can return immediately.',
        'Delete a terminal only when the user asks to stop or close its process. Never delete this Pi session terminal.',
        'A side quest is independent work in another persistent terminal. Use `treeport terminal create` here or `treeport spawn` for another tree.',
        'Use `treeport browser` commands for visible browser tabs. Take a new snapshot after navigation or a runtime change.',
        'Leave browser tabs open for user inspection. Do not install Chromium without user approval.',
        'Do not put secrets in browser URLs or command arguments.',
        'Use `treeport <area> <command> --help` for exact syntax. Do not load the Treeport skill for these routine operations.'
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
