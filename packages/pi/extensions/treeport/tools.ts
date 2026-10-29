import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  truncateHead,
  type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import { Type, type Static, type TSchema } from 'typebox'
import { runTreeportJson } from './treeport-cli.ts'

const identifier = Type.String({ minLength: 1, pattern: '^[^-]' })

const tree = Type.Optional(
  Type.String({
    description: 'Tree ID, path, or . for the current tree. Defaults to .'
  })
)

const project = Type.Optional(
  Type.String({
    description: 'Project ID or path. Defaults to the current project.'
  })
)

const app = Type.Optional(
  Type.String({
    description:
      'Browser app ID from treeport_browser_open or treeport_browser_list. Specify it when multiple tabs are open.'
  })
)

const argv = Type.Optional(
  Type.Array(Type.String(), {
    minItems: 1,
    description:
      'Executable and arguments, without shell parsing. For shell syntax use ["bash", "-lc", "..."] instead.'
  })
)

const object = Type.Record(Type.String(), Type.Unknown())

const browserResult = Type.Object(
  { output: Type.String() },
  { additionalProperties: true }
)

export const TREEPORT_GUIDELINES = [
  'Treeport terminals persist and are visible to the user. Use treeport_terminal_wait for runtime conditions instead of polling or sleeping.',
  'Create Treeport terminals only for long-running processes such as servers, watchers, and agents.',
  'Delete terminals you started once their processes are no longer needed. Delete other terminals only when the user asks. Never delete this Pi session terminal.',
  'After sending terminal input, use treeport_terminal_wait and treeport_terminal_capture to observe the result.',
  'Leave browser tabs open for user inspection. Do not install a browser runtime without user approval.',
  'Do not put secrets in browser URLs or command arguments.',
  'Treeport tools target the instance inherited by this terminal, which may differ from a development instance in the current worktree. Do not mutate another instance without explicit permission.'
]

export function registerTreeportTools(
  pi: ExtensionAPI,
  contextSchema: TSchema
): string[] {
  const names: string[] = []

  const register = <P extends TSchema, O extends TSchema>(
    command: string[],
    description: string,
    parameters: P,
    outputSchema: O,
    args: (params: Static<P>) => string[] = () => [],
    timeout: (params: Static<P>) => number = () => 30_000
  ) => {
    const name = `treeport_${command.join('_').replaceAll('-', '_')}`
    names.push(name)
    pi.registerTool({
      name,
      label: `Treeport ${command.join(' ')}`,
      description,
      namespace: {
        name: 'treeport',
        description:
          'Persistent terminals, shared browser tabs, projects, and worktrees.'
      },
      promptGuidelines: TREEPORT_GUIDELINES,
      parameters,
      outputSchema,
      async execute(_id, params, signal, _update, ctx) {
        const result = await runTreeportJson(
          pi,
          [...command, ...args(params)],
          outputSchema,
          {
            cwd: ctx.cwd,
            signal,
            timeout: timeout(params)
          }
        )

        const json = JSON.stringify(result, null, 2)
        const truncated = truncateHead(json)
        let text = truncated.content
        let fullOutputPath: string | null = null

        if (truncated.truncated) {
          fullOutputPath = join(
            await mkdtemp(join(tmpdir(), 'treeport-tool-')),
            'output.json'
          )
          await writeFile(fullOutputPath, json, { mode: 0o600 })
          text += `\nFull JSON output: ${fullOutputPath}`
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent: result,
          details: { fullOutputPath }
        }
      }
    })
  }

  register(
    ['context'],
    'Read the current project, tree, terminal, and API instance.',
    Type.Object({}),
    contextSchema
  )
  register(
    ['project', 'list'],
    'List registered projects, including their trees and terminals.',
    Type.Object({}),
    Type.Array(object)
  )
  register(
    ['project', 'add'],
    'Register an existing local folder or Git repository as a project.',
    Type.Object({ path: identifier }),
    object,
    (p) => [p.path]
  )
  register(
    ['worktree', 'list'],
    'List trees, optionally within one project.',
    Type.Object({ project }),
    Type.Array(object),
    (p) => (p.project ? [`--project=${p.project}`] : [])
  )
  register(
    ['worktree', 'create'],
    'Create a linked Git worktree. Runs configured project setup.',
    Type.Object({
      name: Type.String({ minLength: 1 }),
      project,
      fromCurrent: Type.Optional(Type.Boolean())
    }),
    object,
    (p) => [
      `--name=${p.name}`,
      ...(p.project ? [`--project=${p.project}`] : []),
      ...(p.fromCurrent ? ['--from-current'] : [])
    ],
    () => 660_000
  )
  register(
    ['spawn'],
    'Create a linked tree and its first persistent terminal for independent work. Runs configured project setup.',
    Type.Object({
      treeName: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1 }),
      project,
      fromCurrent: Type.Optional(Type.Boolean()),
      argv
    }),
    object,
    (p) => [
      `--worktree-name=${p.treeName}`,
      `--name=${p.name}`,
      ...(p.project ? [`--project=${p.project}`] : []),
      ...(p.fromCurrent ? ['--from-current'] : []),
      ...(p.argv ? ['--', ...p.argv] : [])
    ],
    () => 660_000
  )

  register(
    ['terminal', 'list'],
    'List persistent terminals. Defaults to the current tree.',
    Type.Object({ tree }),
    Type.Array(object),
    (p) => [`--worktree=${p.tree ?? '.'}`]
  )
  register(
    ['terminal', 'create'],
    'Start a long-running process such as a development server, watcher, or agent. Returns a persistent terminal ID nested under this terminal; use inspect, capture, or wait to observe it.',
    Type.Object({
      tree,
      name: Type.String({ minLength: 1 }),
      argv,
      closeOnExit: Type.Optional(
        Type.Boolean({
          description:
            'Remove the terminal when its command exits, including on failure. Output is not retained after removal.'
        })
      )
    }),
    object,
    (p) => [
      `--worktree=${p.tree ?? '.'}`,
      `--name=${p.name}`,
      ...(p.closeOnExit ? ['--close-on-exit'] : []),
      ...(p.argv ? ['--', ...p.argv] : [])
    ]
  )
  register(
    ['terminal', 'inspect'],
    'Read terminal status, launched-command exit status, activity, and attention. A running shell can have a completed command.',
    Type.Object({ terminal: identifier }),
    Type.Object(
      { terminal: object, metadata: object },
      { additionalProperties: true }
    ),
    (p) => [p.terminal]
  )
  register(
    ['terminal', 'capture'],
    'Read recent terminal output as content. Defaults to 200 lines; maximum 5000.',
    Type.Object({
      terminal: identifier,
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 }))
    }),
    Type.Object({ content: Type.String() }, { additionalProperties: true }),
    (p) => [
      p.terminal,
      ...(p.lines === undefined ? [] : [`--lines=${p.lines}`])
    ]
  )
  register(
    ['terminal', 'wait'],
    'Wait for idle, working, attention, or exit. Exit includes completion of the initial command even if its shell stays open. Timeout is an error, not success.',
    Type.Object({
      terminal: identifier,
      until: Type.Union(
        ['idle', 'working', 'attention', 'exit'].map((value) =>
          Type.Literal(value)
        )
      ),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 600,
          description: 'Defaults to 30 seconds.'
        })
      )
    }),
    Type.Object(
      { terminal: object, condition: Type.String(), observedAt: Type.String() },
      { additionalProperties: true }
    ),
    (p) => [
      p.terminal,
      `--until=${p.until}`,
      `--timeout=${p.timeoutSeconds ?? 30}s`
    ],
    (p) => ((p.timeoutSeconds ?? 30) + 5) * 1000
  )
  register(
    ['terminal', 'send-keys'],
    'Send keys like tmux send-keys. Each key that names a key, such as Enter, Escape, Tab, BSpace, Up, Down, PageUp, F1, or C-c, M-x, S-Tab, is sent as that key; any other key is typed literally. Fails if the terminal has exited.',
    Type.Object({
      terminal: identifier,
      keys: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          'Key names or text, for example ["npm test", "Enter"] or ["C-c"].'
      }),
      literal: Type.Optional(
        Type.Boolean({ description: 'Type every key literally.' })
      ),
      repeat: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 1024,
          description: 'Send the keys this many times.'
        })
      )
    }),
    Type.Object({ ok: Type.Boolean(), terminalId: Type.String() }),
    (p) => [
      p.terminal,
      ...(p.literal ? ['--literal'] : []),
      ...(p.repeat === undefined ? [] : [`--repeat=${p.repeat}`]),
      '--',
      ...p.keys
    ]
  )
  register(
    ['terminal', 'send-text'],
    'Paste text, such as a multi-line prompt, into a terminal. Uses bracketed paste when the application enables it, so newlines do not submit; send Enter with treeport_terminal_send_keys to submit. Fails if the terminal has exited.',
    Type.Object({
      terminal: identifier,
      text: Type.String({ minLength: 1, pattern: '^(?!-$)' }),
      paste: Type.Optional(
        Type.Boolean({
          description: 'Set false to type the text instead of pasting it.'
        })
      )
    }),
    Type.Object({ ok: Type.Boolean(), terminalId: Type.String() }),
    (p) => [
      p.terminal,
      ...(p.paste === false ? ['--no-paste'] : []),
      '--',
      p.text
    ]
  )
  register(
    ['terminal', 'delete'],
    'Delete a terminal you started once its process is no longer needed, or another terminal when the user asks. Never delete the current Pi terminal.',
    Type.Object({ terminal: identifier }),
    Type.Object({ ok: Type.Boolean(), terminalId: Type.String() }),
    (p) => {
      if (
        p.terminal === '.' ||
        p.terminal === process.env.TREEPORT_TERMINAL_ID?.trim()
      ) {
        throw new Error('Cannot delete the current Pi session terminal.')
      }

      return [p.terminal]
    }
  )

  register(
    ['browser', 'status'],
    'Check browser runtime availability. Does not install a browser.',
    Type.Object({}),
    object
  )
  register(
    ['browser', 'list'],
    'List open shared browser tabs and their app IDs.',
    Type.Object({}),
    Type.Array(object)
  )
  register(
    ['browser', 'open'],
    'Open a visible browser tab shared with the user. Keep it open for inspection. Use the returned app.id for subsequent browser calls.',
    Type.Object({ tree, url: Type.Optional(identifier) }),
    object,
    (p) => [...(p.url ? [p.url] : []), `--worktree=${p.tree ?? '.'}`]
  )

  for (const [command, description] of [
    [
      'snapshot',
      'Capture an accessibility snapshot. Use its element references for click and fill.'
    ],
    ['back', 'Go back in browser history.'],
    ['forward', 'Go forward in browser history.'],
    ['reload', 'Reload the shared page.'],
    ['network', 'Read page network requests.'],
    [
      'screenshot',
      'Capture a screenshot. The output contains the image path; use read to view it.'
    ]
  ] as const) {
    register(
      ['browser', command],
      description,
      Type.Object({ app }),
      browserResult,
      (p) => (p.app ? [`--app=${p.app}`] : []),
      () => 90_000
    )
  }

  register(
    ['browser', 'goto'],
    'Navigate the shared page to an absolute HTTP, HTTPS, or file URL. Local files must exist on the browser runtime filesystem.',
    Type.Object({ app, url: identifier }),
    browserResult,
    (p) => [p.url, ...(p.app ? [`--app=${p.app}`] : [])],
    () => 90_000
  )
  register(
    ['browser', 'click'],
    'Click an element reference from the latest snapshot or a Playwright selector.',
    Type.Object({ app, target: identifier }),
    browserResult,
    (p) => [p.target, ...(p.app ? [`--app=${p.app}`] : [])],
    () => 90_000
  )
  register(
    ['browser', 'fill'],
    'Fill an editable element reference or selector. Text beginning with a hyphen is not supported by the CLI.',
    Type.Object({
      app,
      target: identifier,
      text: Type.String({ pattern: '^(?!-)' })
    }),
    browserResult,
    (p) => [p.target, p.text, ...(p.app ? [`--app=${p.app}`] : [])],
    () => 90_000
  )
  register(
    ['browser', 'press'],
    'Press a Playwright key such as Enter, Tab, or Control+a.',
    Type.Object({ app, key: identifier }),
    browserResult,
    (p) => [p.key, ...(p.app ? [`--app=${p.app}`] : [])],
    () => 90_000
  )
  register(
    ['browser', 'console'],
    'Read page console messages, optionally filtered by minimum level.',
    Type.Object({ app, level: Type.Optional(identifier) }),
    browserResult,
    (p) => [
      ...(p.level ? [p.level] : []),
      ...(p.app ? [`--app=${p.app}`] : [])
    ],
    () => 90_000
  )

  return names
}
