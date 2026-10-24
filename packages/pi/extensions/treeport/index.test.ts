import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import treeportExtension from './index.ts'

const managed = {
  managed: true,
  apiUrl: 'http://127.0.0.1:8733',
  daemonLifecycle: 'external',
  project: { id: 'project-1', name: 'Treeport', kind: 'repository' },
  worktree: {
    id: 'tree-1',
    projectId: 'project-1',
    name: 'pi-extension',
    path: '/repo/pi-extension'
  },
  terminal: { id: 'terminal-parent', worktreeId: 'tree-1', name: 'agent' }
}

interface ExecCall {
  command: string
  args: string[]
  options: { cwd?: string; signal?: AbortSignal; timeout?: number }
}

function harness(
  execute: (
    call: ExecCall
  ) => ReturnType<typeof success> | Promise<ReturnType<typeof success>>,
  sessionManager = SessionManager.inMemory('/repo/pi-extension')
) {
  const handlers = new Map<string, Array<(event: any, context: any) => any>>()
  const tools = new Map<
    string,
    Pick<ToolDefinition, 'parameters' | 'execute'>
  >()
  let active = ['read', 'bash', 'codemode']
  const execCalls: ExecCall[] = []
  const sent = vi.fn()
  const piFixture: Partial<ExtensionAPI> = {
    on(name: string, handler: (event: any, context: any) => any) {
      const current = handlers.get(name) ?? []
      current.push(handler)
      handlers.set(name, current)
      return () =>
        handlers.set(
          name,
          current.filter((value) => value !== handler)
        )
    },
    registerTool(tool) {
      tools.set(tool.name, {
        parameters: tool.parameters,
        execute: (id, params, signal, _update, ctx) =>
          tool.execute(
            id,
            Value.Parse(tool.parameters, params),
            signal,
            undefined,
            ctx
          )
      })
      active.push(tool.name)
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names]
    },
    appendEntry: (type, data) => sessionManager.appendCustomEntry(type, data),
    sendMessage: sent,
    async exec(command, args, options = {}) {
      const call = { command, args: [...args], options }
      execCalls.push(call)
      return execute(call)
    }
  }
  // SAFETY: The fixture implements every API method used by this extension.
  treeportExtension(piFixture as ExtensionAPI)
  const statuses: Array<{ key: string; text: string | undefined }> = []
  const notifications: Array<{ message: string; type: string | undefined }> = []
  const ui: Partial<ExtensionToolContext['ui']> = {
    // SAFETY: The badge only calls theme.fg; no other theme methods are used.
    theme: {
      fg: (_color: string, text: string) => text
    } as ExtensionToolContext['ui']['theme'],
    setStatus: (key, text) => {
      statuses.push({ key, text })
    },
    notify: (message, type) => {
      notifications.push({ message, type })
    }
  }
  const context: Pick<
    ExtensionToolContext,
    'cwd' | 'hasUI' | 'isIdle' | 'sessionManager' | 'ui'
  > = {
    cwd: '/repo/pi-extension',
    hasUI: true,
    isIdle: () => true,
    sessionManager,
    // SAFETY: Only status and notification UI methods are used by the extension.
    ui: ui as ExtensionToolContext['ui']
  }
  return {
    tools,
    execCalls,
    sent,
    sessionManager,
    context,
    statuses,
    notifications,
    active: () => [...active],
    async emit(name: string) {
      for (const handler of handlers.get(name) ?? []) {
        await handler({ type: name }, context)
      }
    },
    async call(
      name: string,
      params = {},
      signal = new AbortController().signal
    ) {
      const tool = tools.get(name)!
      expect(active).toContain(name)
      expect(Value.Check(tool.parameters, params)).toBe(true)
      // SAFETY: Tools under test only use cwd and sessionManager from this context.
      return tool.execute(
        'call',
        params,
        signal,
        undefined,
        context as ExtensionToolContext
      )
    }
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
  vi.stubEnv('TREEPORT_PROJECT_ID', '')
  vi.stubEnv('TREEPORT_WORKTREE_ID', '')
  vi.stubEnv('TREEPORT_TERMINAL_ID', '')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('Treeport Pi extension', () => {
  it('keeps only the loader active outside Treeport and warns only for invalid injected context', async () => {
    const outside = harness(() =>
      success({ managed: false, reason: 'outside_treeport' })
    )
    await outside.emit('session_start')
    await outside.emit('input')
    expect(outside.active()).toEqual([
      'read',
      'bash',
      'codemode',
      'treeport_enable'
    ])
    expect(outside.sent).not.toHaveBeenCalled()
    expect(outside.statuses).toEqual([])
    expect(outside.notifications).toEqual([])
    const missing = harness(() => ({
      stdout: '',
      stderr: 'spawn treeport ENOENT',
      code: 1,
      killed: false
    }))
    await missing.emit('session_start')
    expect(missing.notifications).toEqual([])
    await expect(missing.call('treeport_enable')).rejects.toThrow('ENOENT')
    expect(missing.active()).not.toContain('treeport_context')
    expect(missing.sessionManager.getEntries()).toEqual([])
    vi.stubEnv('TREEPORT_PROJECT_ID', 'project-1')
    await missing.emit('session_start')
    expect(missing.notifications[0]?.message).toContain('unavailable')
    const invalid = harness(() =>
      success({
        ...managed,
        worktree: { ...managed.worktree, projectId: 'wrong' }
      })
    )
    await invalid.emit('session_start')
    expect(invalid.notifications[0]?.message).toContain('invalid')
    await expect(invalid.call('treeport_enable')).rejects.toThrow('invalid')
    expect(invalid.active()).not.toContain('treeport_context')
    await outside.emit('session_shutdown')
  })

  it('enables tools explicitly without injecting messages and restores activation across reload and branch navigation', async () => {
    const runtime = harness(() => success(managed))
    await runtime.emit('session_start')
    await runtime.emit('input')
    expect(runtime.sent).not.toHaveBeenCalled()
    expect(runtime.sessionManager.getEntries()).toEqual([])
    runtime.sessionManager.appendMessage({
      role: 'user',
      content: 'Hello',
      timestamp: 1
    })
    const before = runtime.sessionManager.getLeafId()!
    const result = await runtime.call('treeport_enable')
    expect(result.structuredContent).toMatchObject({ context: managed })
    expect(runtime.active()).toContain('treeport_terminal_create')
    expect(runtime.active()).toContain('treeport_browser_snapshot')
    expect(runtime.active()).toContain('bash')
    expect(runtime.active()).not.toContain('treeport_browser_install')
    const enabled = runtime.sessionManager.getLeafId()!
    const history = structuredClone(runtime.sessionManager.getEntries())
    await runtime.call('treeport_enable')
    expect(runtime.sessionManager.getEntries()).toEqual(history)
    expect(new Set(runtime.active()).size).toBe(runtime.active().length)
    const restored = harness(() => success(managed), runtime.sessionManager)
    await restored.emit('session_start')
    expect(restored.active()).toEqual(runtime.active())
    runtime.sessionManager.branch(before)
    await restored.emit('session_tree')
    expect(restored.active()).not.toContain('treeport_context')
    runtime.sessionManager.branch(enabled)
    await restored.emit('session_tree')
    expect(restored.active()).toContain('treeport_context')
    expect(runtime.sessionManager.getEntries()).toEqual(history)
    expect(runtime.sent).not.toHaveBeenCalled()
  })

  it('refreshes its badge only while idle without transcript changes and cancels late results on shutdown', async () => {
    let slow = false
    let release = () => {}
    const pending = new Promise<ReturnType<typeof success>>((resolve) => {
      release = () =>
        resolve(
          success({
            ...managed,
            worktree: { ...managed.worktree, name: 'late' }
          })
        )
    })
    const runtime = harness(() => (slow ? pending : success(managed)))
    await runtime.emit('session_start')
    expect(runtime.statuses.at(-1)?.text).toBe('treeport · pi-extension')
    runtime.context.isIdle = () => false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(runtime.execCalls).toHaveLength(1)
    runtime.context.isIdle = () => true
    slow = true
    await runtime.emit('agent_settled')
    await vi.advanceTimersByTimeAsync(0)
    await runtime.emit('agent_settled')
    await runtime.emit('input')
    expect(runtime.execCalls).toHaveLength(2)
    expect(runtime.sent).not.toHaveBeenCalled()
    const signal = runtime.execCalls.at(-1)?.options.signal
    await runtime.emit('session_shutdown')
    expect(signal?.aborted).toBe(true)
    const statuses = structuredClone(runtime.statuses)
    release()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtime.statuses).toEqual(statuses)
    expect(runtime.sessionManager.getEntries()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('works without UI and preserves history when Treeport becomes unavailable', async () => {
    let available = true
    const runtime = harness(() => {
      if (!available) {
        throw new Error('CLI unavailable')
      }

      return success(managed)
    })
    runtime.context.hasUI = false
    await runtime.emit('session_start')
    await runtime.call('treeport_enable')
    const history = structuredClone(runtime.sessionManager.getEntries())
    available = false
    await runtime.emit('agent_settled')
    await vi.advanceTimersByTimeAsync(0)
    await expect(runtime.call('treeport_context')).rejects.toThrow(
      'CLI unavailable'
    )
    expect(runtime.sessionManager.getEntries()).toEqual(history)
    expect(runtime.statuses).toEqual([])
    expect(runtime.notifications).toEqual([])
    expect(runtime.sent).not.toHaveBeenCalled()
  })

  it('exposes typed operations using the configured CLI with structured results and cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'treeport-pi-cli-'))
    try {
      const cli = join(root, '.treeport-dev-dist/node/cli/index.js')
      await mkdir(dirname(cli), { recursive: true })
      await writeFile(cli, '#!/usr/bin/env node\n', { mode: 0o700 })
      vi.stubEnv(
        'TREEPORT_DAEMON_RECORD',
        join(root, '.treeport-dev/runtime/daemon.json')
      )
      vi.stubEnv('TREEPORT_TERMINAL_ID', 'terminal-parent')
      let response = success(managed)
      const runtime = harness(() => response)
      await runtime.emit('session_start')
      await runtime.call('treeport_enable')
      const signal = new AbortController().signal
      response = success({ id: 'terminal-child' })
      expect(
        (
          await runtime.call(
            'treeport_terminal_create',
            {
              name: 'Server with spaces',
              argv: ['bash', '-lc', 'echo "hello"; pnpm dev']
            },
            signal
          )
        ).structuredContent
      ).toEqual({ id: 'terminal-child' })
      expect(runtime.execCalls.at(-1)).toMatchObject({
        command: cli,
        args: [
          'terminal',
          'create',
          '--worktree=.',
          '--name=Server with spaces',
          '--json',
          '--',
          'bash',
          '-lc',
          'echo "hello"; pnpm dev'
        ],
        options: { signal, cwd: '/repo/pi-extension' }
      })
      response = success({ terminal: {}, condition: 'exit', observedAt: 'now' })
      await runtime.call(
        'treeport_terminal_wait',
        { terminal: 'terminal-child', until: 'exit', timeoutSeconds: 60 },
        signal
      )
      expect(runtime.execCalls.at(-1)).toMatchObject({
        args: [
          'terminal',
          'wait',
          'terminal-child',
          '--until=exit',
          '--timeout=60s',
          '--json'
        ],
        options: { signal, timeout: 65_000 }
      })
      response = success({ output: 'Clicked' })
      await runtime.call('treeport_browser_click', {
        app: 'browser-1',
        target: 'e5'
      })
      expect(runtime.execCalls.at(-1)?.args).toEqual([
        'browser',
        'click',
        'e5',
        '--app=browser-1',
        '--json'
      ])
      expect(
        Value.Check(runtime.tools.get('treeport_terminal_wait')!.parameters, {
          terminal: 't',
          until: 'unknown'
        })
      ).toBe(false)
      expect(
        Value.Check(runtime.tools.get('treeport_browser_click')!.parameters, {
          target: '--help'
        })
      ).toBe(false)
      const calls = runtime.execCalls.length
      await expect(
        runtime.call('treeport_terminal_delete', {
          terminal: 'terminal-parent'
        })
      ).rejects.toThrow('current Pi')
      await expect(
        runtime.call('treeport_terminal_delete', { terminal: '.' })
      ).rejects.toThrow('current Pi')
      expect(runtime.execCalls).toHaveLength(calls)
      response = {
        stdout: '',
        stderr: JSON.stringify({
          error: { code: 'WAIT_TIMEOUT', message: 'No exit yet' }
        }),
        code: 4,
        killed: false
      }
      await expect(
        runtime.call('treeport_terminal_wait', {
          terminal: 'child',
          until: 'exit'
        })
      ).rejects.toThrow('[WAIT_TIMEOUT] No exit yet')
      response = { stdout: 'not JSON', stderr: '', code: 0, killed: false }
      await expect(runtime.call('treeport_context')).rejects.toThrow(
        'TREEPORT_INVALID_JSON'
      )
      response = success({ content: 'x'.repeat(60_000) })
      const large = await runtime.call('treeport_terminal_capture', {
        terminal: 'child'
      })
      expect(large.structuredContent).toEqual({ content: 'x'.repeat(60_000) })
      const text = large.content.find((block) => block.type === 'text')!.text
      expect(text.length).toBeLessThan(55_000)
      // SAFETY: This tool's details always contain a nullable fullOutputPath.
      const { fullOutputPath } = large.details as { fullOutputPath: string }
      expect(JSON.parse(await readFile(fullOutputPath, 'utf8'))).toEqual(
        large.structuredContent
      )
      await rm(dirname(fullOutputPath), { recursive: true, force: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
