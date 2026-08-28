import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type, type Static } from 'typebox'
import { runTreeportJson } from './treeport-cli.ts'

const CONTEXT_TIMEOUT_MS = 5_000

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

const BrowserStatusSchema = Type.Object(
  {
    installed: Type.Boolean(),
    launchReady: Type.Boolean()
  },
  { additionalProperties: true }
)
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
  let guidance: string | null = null
  let badgeVisible = false

  pi.on('session_start', async (_event, sessionContext) => {
    guidance = null
    let detectedValue: ContextOutput
    try {
      detectedValue = await runTreeportJson(pi, ['context'], ContextSchema, {
        cwd: sessionContext.cwd,
        signal: undefined,
        timeout: CONTEXT_TIMEOUT_MS
      })
    } catch {
      const injectedIds = [
        process.env.TREEPORT_PROJECT_ID,
        process.env.TREEPORT_WORKTREE_ID,
        process.env.TREEPORT_TERMINAL_ID
      ].some((value) => Boolean(value?.trim()))
      if (injectedIds && sessionContext.hasUI) {
        sessionContext.ui.notify(
          'Treeport context is unavailable. The Treeport integration is inactive.',
          'warning'
        )
      }

      return
    }

    if (detectedValue.managed === false) {
      return
    }

    const detected = managedContext(detectedValue)
    if (!detected) {
      const injectedIds = [
        process.env.TREEPORT_PROJECT_ID,
        process.env.TREEPORT_WORKTREE_ID,
        process.env.TREEPORT_TERMINAL_ID
      ].some((value) => Boolean(value?.trim()))
      if (injectedIds && sessionContext.hasUI) {
        sessionContext.ui.notify(
          'Treeport context is invalid. The Treeport integration is inactive.',
          'warning'
        )
      }

      return
    }

    let browserCommandsAvailable = true
    try {
      await runTreeportJson(pi, ['browser', 'status'], BrowserStatusSchema, {
        cwd: sessionContext.cwd,
        signal: undefined,
        timeout: CONTEXT_TIMEOUT_MS
      })
    } catch {
      browserCommandsAvailable = false
    }

    const guidanceLines = [
      'Treeport context:',
      browserCommandsAvailable
        ? 'Treeport is a worktree-first workspace for projects, trees, persistent terminals, and browser tabs.'
        : 'Treeport is a worktree-first workspace for projects, trees, and persistent terminals.',
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
      ...(browserCommandsAvailable
        ? [
            'Use `treeport browser` commands for visible browser tabs. Take a new snapshot after navigation or a runtime change.',
            'Leave browser tabs open for user inspection. Do not install Chromium without user approval.',
            'Do not put secrets in browser URLs or command arguments.'
          ]
        : []),
      'Use `treeport <area> <command> --help` for exact syntax. Do not load the Treeport skill for these routine operations.'
    ]
    guidance = guidanceLines.join('\n')

    if (!browserCommandsAvailable && sessionContext.hasUI) {
      sessionContext.ui.notify(
        'Treeport browser commands are unavailable in this session.',
        'warning'
      )
    }

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
  })

  pi.on('before_agent_start', (event) => {
    if (!guidance) {
      return
    }

    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` }
  })

  pi.on('session_shutdown', (_event, sessionContext) => {
    if (badgeVisible) {
      sessionContext.ui.setStatus('treeport', undefined)
      badgeVisible = false
    }
  })
}
