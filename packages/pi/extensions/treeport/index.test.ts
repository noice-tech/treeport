import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import treeportExtension from './index.ts'

const managed = {
  managed: true,
  apiUrl: 'http://127.0.0.1:8733',
  daemonLifecycle: 'external',
  project: {
    id: 'project-1',
    name: 'Treeport',
    kind: 'repository',
    rootPath: '/repo',
    repositoryPath: '/repo',
    mainWorktreePath: '/repo',
    defaultBranch: 'main',
    availability: { state: 'available', message: null }
  },
  worktree: {
    id: 'tree-1',
    projectId: 'project-1',
    name: 'pi-extension',
    path: '/repo/pi-extension',
    head: 'abc',
    branch: 'feature/pi-extension',
    detached: false,
    kind: 'linked'
  },
  terminal: {
    id: 'terminal-parent',
    worktreeId: 'tree-1',
    name: 'agent',
    status: 'running',
    exitCode: null
  }
}

interface HarnessEvent {
  reason?: string
  systemPrompt?: string
}

interface ExecCall {
  command: string
  args: string[]
  options: {
    cwd?: string
    signal?: AbortSignal
    timeout?: number
  }
}

function harness(
  execute: (
    call: ExecCall
  ) =>
    | { stdout: string; stderr: string; code: number; killed: boolean }
    | Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>
) {
  const handlers = new Map<string, Array<(event: any, context: any) => any>>()
  const tools: string[] = []
  const execCalls: ExecCall[] = []
  const notUsed = () => {
    throw new Error('Unexpected fixture API call')
  }
  const piFixture = {
    on(name: string, handler: (event: any, context: any) => any) {
      const current = handlers.get(name) ?? []
      current.push(handler)
      handlers.set(name, current)
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name)
    },
    async exec(command: string, args: string[], options: ExecCall['options']) {
      const call = { command, args: [...args], options }
      execCalls.push(call)
      return execute(call)
    },
    getActiveTools: notUsed,
    setActiveTools: notUsed,
    getAllTools: notUsed,
    registerCommand: notUsed,
    registerShortcut: notUsed,
    registerFlag: notUsed,
    getFlag: notUsed,
    registerMessageRenderer: notUsed,
    registerMarkdownTransformer: notUsed,
    registerEntryRenderer: notUsed,
    sendMessage: notUsed,
    sendUserMessage: notUsed,
    appendEntry: notUsed,
    setSessionName: notUsed,
    getSessionName: notUsed,
    setLabel: notUsed,
    getCommands: notUsed,
    setModel: notUsed,
    getThinkingLevel: notUsed,
    setThinkingLevel: notUsed,
    registerProvider: notUsed,
    unregisterProvider: notUsed,
    events: { on: notUsed, emit: notUsed }
  }
  // SAFETY: The fixture implements each ExtensionAPI method used by this extension.
  treeportExtension(piFixture as ExtensionAPI)

  const statuses: Array<{ key: string; text: string | undefined }> = []
  const notifications: Array<{ message: string; type: string | undefined }> = []
  const uiFixture = {
    theme: { fg: (_color: string, text: string) => text },
    setStatus: (key: string, text: string | undefined) =>
      statuses.push({ key, text }),
    notify: (message: string, type?: string) =>
      notifications.push({ message, type })
  }
  const context = {
    cwd: '/repo/pi-extension',
    hasUI: true,
    ui: uiFixture
  }

  const emit = async (name: string, event: HarnessEvent = {}) => {
    const results = []
    for (const handler of handlers.get(name) ?? []) {
      results.push(await handler({ type: name, ...event }, context))
    }
    return results
  }

  return { emit, execCalls, notifications, statuses, tools }
}

function success<T>(value: T) {
  return {
    stdout: `${JSON.stringify(value)}\n`,
    stderr: '',
    code: 0,
    killed: false
  }
}

function commandArgs(call: ExecCall): string[] {
  return call.args.filter((value) => value !== '--json')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Treeport Pi extension', () => {
  it('stays inert outside Treeport and warns only for an invalid injected context', async () => {
    vi.stubEnv('TREEPORT_PROJECT_ID', '')
    vi.stubEnv('TREEPORT_WORKTREE_ID', '')
    vi.stubEnv('TREEPORT_TERMINAL_ID', '')
    const outside = harness(() =>
      success({ managed: false, reason: 'outside_treeport' })
    )
    await outside.emit('session_start', { reason: 'startup' })
    await outside.emit('session_shutdown', { reason: 'quit' })
    expect(outside.tools).toEqual([])
    expect(outside.statuses).toEqual([])
    expect(outside.notifications).toEqual([])
    expect(
      await outside.emit('before_agent_start', { systemPrompt: 'Base prompt' })
    ).toEqual([undefined])

    const missing = harness(() => ({
      stdout: '',
      stderr: 'spawn treeport ENOENT',
      code: 1,
      killed: false
    }))
    await missing.emit('session_start', { reason: 'startup' })
    expect(missing.tools).toEqual([])
    expect(missing.notifications).toEqual([])

    vi.stubEnv('TREEPORT_PROJECT_ID', 'project-1')
    vi.stubEnv('TREEPORT_WORKTREE_ID', 'tree-1')
    vi.stubEnv('TREEPORT_TERMINAL_ID', 'terminal-parent')
    const invalid = harness(() =>
      success({
        ...managed,
        worktree: { ...managed.worktree, projectId: 'wrong-project' }
      })
    )
    await invalid.emit('session_start', { reason: 'startup' })
    expect(invalid.tools).toEqual([])
    expect(invalid.notifications).toEqual([
      {
        message:
          'Treeport context is invalid. The Treeport integration is inactive.',
        type: 'warning'
      }
    ])
  })

  it('adds stable CLI guidance and the badge only in a managed session', async () => {
    const developmentRoot = await mkdtemp(join(tmpdir(), 'treeport-pi-cli-'))
    const developmentRecord = join(
      developmentRoot,
      '.treeport-dev/runtime/daemon.json'
    )
    const developmentCli = join(
      developmentRoot,
      '.treeport-dev-dist/node/cli/index.js'
    )
    await mkdir(join(developmentRoot, '.treeport-dev/runtime'), {
      recursive: true
    })
    await mkdir(join(developmentRoot, '.treeport-dev-dist/node/cli'), {
      recursive: true
    })
    await writeFile(developmentCli, '#!/usr/bin/env node\n', { mode: 0o700 })
    vi.stubEnv('TREEPORT_CLI_ENTRYPOINT', '')
    vi.stubEnv('TREEPORT_DAEMON_RECORD', developmentRecord)

    const runtime = harness((call) =>
      commandArgs(call).join(' ') === 'browser status'
        ? success({ installed: true, launchReady: true })
        : success(managed)
    )
    await runtime.emit('session_start', { reason: 'startup' })
    expect(runtime.tools).toEqual([])
    expect(
      runtime.execCalls.every((call) => call.command === developmentCli)
    ).toBe(true)
    expect(runtime.statuses.at(-1)).toEqual({
      key: 'treeport',
      text: 'treeport · pi-extension'
    })

    const [promptChange] = await runtime.emit('before_agent_start', {
      systemPrompt: 'Base prompt'
    })
    expect(promptChange.systemPrompt).toContain(
      'Treeport is a worktree-first workspace for projects, trees, persistent terminals, and browser tabs.'
    )
    expect(promptChange.systemPrompt).toContain(
      'This session runs in project "Treeport" and tree "pi-extension".'
    )
    expect(promptChange.systemPrompt).toContain(
      'Use the `treeport` CLI through bash for Treeport operations.'
    )
    expect(promptChange.systemPrompt).toContain(
      'treeport terminal create --worktree . --name <name> -- <program> <arg> ...'
    )
    expect(promptChange.systemPrompt).toContain(
      'sleep 5; treeport terminal capture <id>'
    )
    expect(promptChange.systemPrompt).toContain(
      'It is not a readiness check and can return immediately.'
    )
    expect(promptChange.systemPrompt).toContain(
      'Never delete this Pi session terminal.'
    )
    expect(promptChange.systemPrompt).toContain(
      'Use `treeport terminal create` here or `treeport spawn` for another tree.'
    )
    expect(promptChange.systemPrompt).toContain(
      'Use `treeport browser` commands for visible browser tabs.'
    )
    expect(promptChange.systemPrompt).toContain(
      'Do not load the Treeport skill for these routine operations.'
    )
    expect(promptChange.systemPrompt).not.toContain('project-1')
    expect(promptChange.systemPrompt).not.toContain('/repo/pi-extension')

    const [repeatedPromptChange] = await runtime.emit('before_agent_start', {
      systemPrompt: 'Base prompt'
    })
    expect(repeatedPromptChange).toEqual(promptChange)

    await runtime.emit('session_shutdown', { reason: 'quit' })
    expect(runtime.statuses.at(-1)).toEqual({
      key: 'treeport',
      text: undefined
    })

    const oldCli = harness((call) =>
      commandArgs(call)[0] === 'context'
        ? success(managed)
        : {
            stdout: '',
            stderr: JSON.stringify({
              error: {
                code: 'USAGE_ERROR',
                message: "error: unknown command 'browser'"
              }
            }),
            code: 2,
            killed: false
          }
    )
    await oldCli.emit('session_start', { reason: 'startup' })
    expect(oldCli.tools).toEqual([])
    expect(oldCli.notifications).toContainEqual({
      message: 'Treeport browser commands are unavailable in this session.',
      type: 'warning'
    })
    const [oldCliPrompt] = await oldCli.emit('before_agent_start', {
      systemPrompt: 'Base prompt'
    })
    expect(oldCliPrompt.systemPrompt).toContain(
      'projects, trees, and persistent terminals.'
    )
    expect(oldCliPrompt.systemPrompt).not.toContain('browser tabs')
    expect(oldCliPrompt.systemPrompt).not.toContain('treeport browser')

    await rm(developmentRoot, { recursive: true, force: true })
  })
})
