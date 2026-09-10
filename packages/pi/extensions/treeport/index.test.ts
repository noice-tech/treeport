import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionManager,
  type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  execute: (call: ExecCall) =>
    | { stdout: string; stderr: string; code: number; killed: boolean }
    | Promise<{
        stdout: string
        stderr: string
        code: number
        killed: boolean
      }>,
  sessionManager = SessionManager.inMemory('/repo/pi-extension')
) {
  const sent: Array<{
    message: Parameters<ExtensionAPI['sendMessage']>[0]
    options: Parameters<ExtensionAPI['sendMessage']>[1]
  }> = []
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
    sendMessage(
      message: Parameters<ExtensionAPI['sendMessage']>[0],
      options: Parameters<ExtensionAPI['sendMessage']>[1]
    ) {
      sent.push({ message, options })
      expect(options).toEqual({ triggerTurn: false })
      sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details
      )
    },
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
    isIdle: () => true,
    sessionManager,
    ui: uiFixture
  }

  const emit = async (name: string, event: HarnessEvent = {}) => {
    const results = []
    for (const handler of handlers.get(name) ?? []) {
      results.push(await handler({ type: name, ...event }, context))
    }
    return results
  }

  return {
    emit,
    execCalls,
    notifications,
    statuses,
    tools,
    sent,
    sessionManager,
    context
  }
}

function success<T>(value: T) {
  return {
    stdout: `${JSON.stringify(value)}\n`,
    stderr: '',
    code: 0,
    killed: false
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('TREEPORT_CLI_ENTRYPOINT', '')
  vi.stubEnv('TREEPORT_DAEMON_RECORD', '')
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
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
    ).toEqual([])
    await outside.emit('input')
    expect(outside.sent).toEqual([])

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
    await missing.emit('session_start', { reason: 'reload' })
    expect(missing.sent).toEqual([])
    expect(missing.notifications).toEqual([
      {
        message:
          'Treeport context is unavailable. The Treeport integration is inactive.',
        type: 'warning'
      }
    ])
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

  it('waits for submission, hides context from chat, and deduplicates across fresh extension instances', async () => {
    const execute = () => success(managed)
    const runtime = harness(execute)
    for (const reason of ['startup', 'reload', 'resume', 'new', 'fork']) {
      await runtime.emit('session_start', { reason })
      expect(runtime.sent).toEqual([])
      expect(runtime.sessionManager.getEntries()).toEqual([])
    }
    await runtime.emit('input')
    expect(runtime.sent).toHaveLength(1)
    expect(runtime.sent[0]).toMatchObject({
      message: { customType: 'treeport-context', display: false },
      options: { triggerTurn: false }
    })
    expect(runtime.sent[0]?.message.content).toMatch(/^Treeport context:/)
    // Browser guidance does not depend on a runtime or capability probe.
    expect(runtime.sent[0]?.message.content).toContain('treeport browser')
    await runtime.emit('input')
    runtime.sessionManager.appendMessage({
      role: 'user',
      content: 'Hello',
      timestamp: 1
    })
    const messages = runtime.sessionManager.buildSessionContext().messages
    expect(messages.map((message) => message.role)).toEqual(['custom', 'user'])
    expect(runtime.sessionManager.getTree()[0]?.entry).toMatchObject({
      type: 'custom_message',
      customType: 'treeport-context',
      display: false
    })
    const history = structuredClone(runtime.sessionManager.getEntries())

    for (const reason of ['resume', 'reload', 'fork']) {
      const restored = harness(execute, runtime.sessionManager)
      await restored.emit('session_start', { reason })
      await restored.emit('input')
      expect(restored.sent).toEqual([])
      expect(runtime.sessionManager.getEntries()).toEqual(history)
    }
  })

  it('appends changed context before input without rewriting history, including A -> B -> A', async () => {
    let name = managed.worktree.name
    const runtime = harness(() =>
      success({ ...managed, worktree: { ...managed.worktree, name } })
    )
    await runtime.emit('session_start')
    await runtime.emit('input')
    runtime.sessionManager.appendMessage({
      role: 'user',
      content: 'First',
      timestamp: 1
    })
    const original = structuredClone(runtime.sessionManager.getEntries())
    for (const nextName of ['renamed', managed.worktree.name]) {
      name = nextName
      const beforeReload = structuredClone(runtime.sessionManager.getEntries())
      await runtime.emit('session_start', { reason: 'reload' })
      expect(runtime.sessionManager.getEntries()).toEqual(beforeReload)
      await runtime.emit('input')
      runtime.sessionManager.appendMessage({
        role: 'user',
        content: nextName,
        timestamp: 2
      })
    }
    expect(runtime.sent).toHaveLength(3)
    expect(runtime.sent[2]?.message).toEqual(runtime.sent[0]?.message)
    expect(
      runtime.sessionManager.getEntries().slice(0, original.length)
    ).toEqual(original)
    expect(
      runtime.sessionManager
        .buildSessionContext()
        .messages.map((message) => message.role)
    ).toEqual(['custom', 'user', 'custom', 'user', 'custom', 'user'])

    await runtime.emit('agent_settled')
    await vi.advanceTimersByTimeAsync(0)
    await runtime.emit('input')
    expect(runtime.sent).toHaveLength(3)
  })

  it('does not inject while browsing branches and checks only the active branch at input', async () => {
    const runtime = harness(() => success(managed))
    const sm = runtime.sessionManager
    const root = sm.appendMessage({
      role: 'user',
      content: 'Older session',
      timestamp: 1
    })
    await runtime.emit('session_start', { reason: 'resume' })
    await runtime.emit('input')
    const contextLeaf = sm.getLeafId()!
    const history = structuredClone(sm.getEntries())
    for (let i = 0; i < 3; i++) {
      sm.branch(root)
      await runtime.emit('session_tree')
      sm.branch(contextLeaf)
      await runtime.emit('session_tree')
      await runtime.emit('input')
    }
    expect(sm.getEntries()).toEqual(history)
    expect(runtime.sent).toHaveLength(1)

    sm.branch(root)
    await runtime.emit('session_tree')
    expect(sm.getEntries()).toEqual(history)
    await runtime.emit('input')
    expect(runtime.sent).toHaveLength(2)
    expect(sm.getEntries().slice(0, history.length)).toEqual(history)
    await runtime.emit('input')
    expect(runtime.sent).toHaveLength(2)
  })

  it('only appends when Treeport is discovered in the middle of an existing conversation', async () => {
    let managedSession = false
    const runtime = harness(() =>
      success(
        managedSession
          ? managed
          : { managed: false, reason: 'outside_treeport' }
      )
    )
    const sm = runtime.sessionManager
    await runtime.emit('session_start')
    await runtime.emit('input')
    sm.appendMessage({ role: 'user', content: 'Already working', timestamp: 1 })
    sm.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Existing answer' }],
      api: 'openai-completions',
      provider: 'mock',
      model: 'mock',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop',
      timestamp: 2
    })
    const history = structuredClone(sm.getEntries())
    const prefix = structuredClone(sm.buildSessionContext().messages)
    const leaf = sm.getLeafId()
    managedSession = true
    await runtime.emit('session_start', { reason: 'reload' })
    expect(sm.getEntries()).toEqual(history)
    await runtime.emit('input')
    expect(sm.getEntries().slice(0, history.length)).toEqual(history)
    expect(sm.getLeafEntry()).toMatchObject({
      type: 'custom_message',
      customType: 'treeport-context',
      parentId: leaf,
      display: false
    })
    sm.appendMessage({ role: 'user', content: 'Continue', timestamp: 3 })
    expect(sm.buildSessionContext().messages.slice(0, prefix.length)).toEqual(
      prefix
    )
    expect(
      sm.buildSessionContext().messages.map((message) => message.role)
    ).toEqual(['user', 'assistant', 'custom', 'user'])
    await runtime.emit('input')
    expect(runtime.sent).toHaveLength(1)
  })

  it('does not rewrite or duplicate previously visible context to hide it', async () => {
    const execute = () => success(managed)
    const original = harness(execute)
    await original.emit('session_start')
    await original.emit('input')
    const guidance = original.sent[0]?.message.content
    if (!guidance) {
      throw new Error('Missing fixture guidance')
    }

    const sm = SessionManager.inMemory('/repo/pi-extension')
    sm.appendCustomMessageEntry('treeport-context', guidance, true)
    const history = structuredClone(sm.getEntries())
    const resumed = harness(execute, sm)
    await resumed.emit('session_start', { reason: 'reload' })
    await resumed.emit('input')
    expect(resumed.sent).toEqual([])
    expect(sm.getEntries()).toEqual(history)
  })

  it('leaves running turns alone and refreshes in the background while idle', async () => {
    const runtime = harness(() => success(managed))
    runtime.context.isIdle = () => false
    await runtime.emit('session_start')
    await runtime.emit('input')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(runtime.execCalls).toEqual([])
    expect(runtime.sent).toEqual([])
    runtime.context.isIdle = () => true
    await runtime.emit('agent_settled')
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.sent).toEqual([])
    const calls = runtime.execCalls.length
    await runtime.emit('input')
    expect(runtime.execCalls).toHaveLength(calls)
    expect(runtime.sent).toHaveLength(1)
  })

  it('submits immediately from cache during slow refresh and appends updates only on later input', async () => {
    let slow = false
    let release = () => {}
    let started = () => {}
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = new Promise<ReturnType<typeof success>>((resolve) => {
      release = () =>
        resolve(
          success({
            ...managed,
            worktree: { ...managed.worktree, name: 'updated' }
          })
        )
    })
    const runtime = harness(() => {
      if (slow) {
        started()
        return pending
      }

      return success(managed)
    })
    await runtime.emit('session_start')
    expect(runtime.sent).toEqual([])
    slow = true
    await runtime.emit('agent_settled')
    await refreshStarted
    const calls = runtime.execCalls.length
    // Single-flight: another idle refresh does not launch a second CLI process.
    await runtime.emit('agent_settled')
    // This resolves while the discovery promise above is still unresolved.
    await runtime.emit('input')
    expect(runtime.execCalls).toHaveLength(calls)
    expect(runtime.sent[0]?.message.content).toContain('"pi-extension"')
    runtime.sessionManager.appendMessage({
      role: 'user',
      content: 'Continue',
      timestamp: 1
    })
    const history = structuredClone(runtime.sessionManager.getEntries())
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.sessionManager.getEntries()).toEqual(history)
    expect(runtime.sent).toHaveLength(1)
    const refreshedCalls = runtime.execCalls.length
    await runtime.emit('input')
    expect(runtime.execCalls).toHaveLength(refreshedCalls)
    expect(runtime.sent).toHaveLength(2)
    expect(runtime.sent[1]?.message.content).toContain('"updated"')
    expect(
      runtime.sessionManager.getEntries().slice(0, history.length)
    ).toEqual(history)
  })

  it('refreshes while idle without transcript changes and cancels late results on shutdown', async () => {
    let name = 'original'
    let slow = false
    let release = () => {}
    let started = () => {}
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = new Promise<ReturnType<typeof success>>((resolve) => {
      release = () =>
        resolve(
          success({
            ...managed,
            worktree: { ...managed.worktree, name: 'too-late' }
          })
        )
    })
    const runtime = harness(() => {
      if (slow) {
        started()
        return pending
      }

      return success({ ...managed, worktree: { ...managed.worktree, name } })
    })
    await runtime.emit('session_start')
    name = 'idle-update'
    await vi.advanceTimersByTimeAsync(30_000)
    expect(runtime.execCalls.map((call) => call.args)).toEqual([
      ['context', '--json'],
      ['context', '--json']
    ])
    expect(runtime.sent).toEqual([])
    await runtime.emit('input')
    expect(runtime.sent[0]?.message.content).toContain('"idle-update"')
    slow = true
    await runtime.emit('agent_settled')
    await refreshStarted
    const signal = runtime.execCalls.at(-1)?.options.signal
    expect(signal?.aborted).toBe(false)
    const history = structuredClone(runtime.sessionManager.getEntries())
    await runtime.emit('session_shutdown')
    const statuses = structuredClone(runtime.statuses)
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await runtime.emit('input')
    const calls = runtime.execCalls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtime.execCalls).toHaveLength(calls)
    expect(runtime.sessionManager.getEntries()).toEqual(history)
    expect(runtime.statuses).toEqual(statuses)
    expect(runtime.statuses.at(-1)).toEqual({
      key: 'treeport',
      text: undefined
    })
    expect(runtime.notifications).toEqual([])
  })

  it('persists guidance without UI and leaves history untouched if Treeport becomes unavailable', async () => {
    let available = true
    const runtime = harness(() => {
      if (!available) {
        throw new Error('CLI unavailable')
      }

      return success(managed)
    })
    runtime.context.hasUI = false
    await runtime.emit('session_start')
    expect(runtime.sent).toEqual([])
    await runtime.emit('input')
    expect(runtime.sent).toHaveLength(1)
    expect(runtime.statuses).toEqual([])
    expect(runtime.notifications).toEqual([])
    const history = structuredClone(runtime.sessionManager.getEntries())
    available = false
    await runtime.emit('agent_settled')
    await vi.advanceTimersByTimeAsync(0)
    await runtime.emit('input')
    expect(runtime.sessionManager.getEntries()).toEqual(history)
    expect(runtime.notifications).toEqual([])
  })

  it('describes the Treeport environment and capabilities with on-demand CLI help', async () => {
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

    const runtime = harness(() => success(managed))
    await runtime.emit('session_start', { reason: 'startup' })
    expect(runtime.tools).toEqual([])
    expect(runtime.execCalls.map((call) => call.args)).toEqual([
      ['context', '--json']
    ])
    expect(
      runtime.execCalls.every((call) => call.command === developmentCli)
    ).toBe(true)
    expect(runtime.statuses.at(-1)).toEqual({
      key: 'treeport',
      text: 'treeport · pi-extension'
    })

    expect(
      await runtime.emit('before_agent_start', {
        systemPrompt: 'Base prompt'
      })
    ).toEqual([])
    expect(runtime.sent).toEqual([])
    await runtime.emit('input')
    const guidance = runtime.sent[0]?.message.content
    for (const description of [
      'You are working inside Treeport',
      'This Pi session runs in a persistent terminal managed by Treeport.',
      'Your current Treeport project is "Treeport" and your tree is "pi-extension".',
      'Treeport provides persistent terminals for shells, development servers, and other agents.',
      'Treeport has browser support.',
      'You and the user share the same live page.',
      'creating a separate tree and terminal for independent work',
      'Use the `treeport` CLI through bash for Treeport operations.',
      'treeport browser --help',
      'treeport terminal --help',
      'Never delete this Pi session terminal.',
      'Do not install a browser runtime without user approval.'
    ]) {
      expect(guidance).toContain(description)
    }
    expect(guidance).not.toContain('treeport terminal create --worktree')
    expect(guidance).not.toContain('sleep 5;')
    expect(guidance).not.toContain('project-1')
    expect(guidance).not.toContain('/repo/pi-extension')

    await runtime.emit('input')
    expect(runtime.sent).toHaveLength(1)

    await runtime.emit('session_shutdown', { reason: 'quit' })
    expect(runtime.statuses.at(-1)).toEqual({
      key: 'treeport',
      text: undefined
    })

    await rm(developmentRoot, { recursive: true, force: true })
  })
})
