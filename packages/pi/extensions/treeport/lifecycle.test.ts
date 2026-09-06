import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import { expect, it, vi } from 'vitest'
import treeportExtension from './index.ts'

it('uses Pi append-only delivery with stable request content across reload, updates, and resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'treeport-pi-lifecycle-'))
  const sessions: Array<
    Awaited<ReturnType<typeof createAgentSession>>['session']
  > = []
  // Fail closed: neither model traffic nor catalog discovery may use the network.
  const fetch = vi.fn(() => {
    throw new Error('Unexpected network request')
  })
  vi.stubGlobal('fetch', fetch)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    let treeName = 'test-tree'
    const exec: ExtensionAPI['exec'] = vi.fn(async (_command, args) => ({
      stdout: JSON.stringify(
        args.includes('context')
          ? {
              managed: true,
              apiUrl: 'http://127.0.0.1:1',
              daemonLifecycle: 'external',
              project: {
                id: 'project',
                name: 'Test project',
                kind: 'repository'
              },
              worktree: {
                id: 'tree',
                projectId: 'project',
                name: treeName,
                path: root
              },
              terminal: { id: 'terminal', worktreeId: 'tree', name: 'Pi' }
            }
          : { installed: true, launchReady: true }
      ),
      stderr: '',
      code: 0,
      killed: false
    }))
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false }
    })
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(root, 'models-store.json'),
      allowModelNetwork: false,
      refreshOnCreate: false
    })
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true)
    const model = modelRuntime.getModels()[0]!
    expect(model).toBeDefined()
    type Request = Parameters<ModelRuntime['streamSimple']>[1]
    const requests: Request[] = []
    const stream = vi
      .spyOn(modelRuntime, 'streamSimple')
      .mockImplementation((model, context) => {
        requests.push(structuredClone(context))
        const message: Awaited<ReturnType<ModelRuntime['completeSimple']>> = {
          role: 'assistant',
          content: [{ type: 'text', text: 'Mock reply' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'stop',
          timestamp: Date.now()
        }
        type Stream = ReturnType<ModelRuntime['streamSimple']>
        const fixture: Pick<Stream, typeof Symbol.asyncIterator | 'result'> = {
          async *[Symbol.asyncIterator]() {
            yield { type: 'done', reason: 'stop', message }
          },
          result: async () => message
        }
        // SAFETY: The agent only consumes the typed iterator and result; the mock
        // needs none of the real stream's producer methods or internal queue state.
        return fixture as Stream
      })
    const create = async (
      sessionManager: SessionManager,
      reason: 'startup' | 'resume'
    ) => {
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => 'Stable base prompt',
        extensionFactories: [(pi) => treeportExtension({ ...pi, exec })]
      })
      await resourceLoader.reload()
      const { session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        resourceLoader,
        settingsManager,
        modelRuntime,
        model,
        sessionManager,
        noTools: 'all',
        sessionStartEvent: { type: 'session_start', reason }
      })
      sessions.push(session)
      const events: AgentSessionEvent[] = []
      session.subscribe((event) => events.push(event))
      const baseSystemPrompt = session.systemPrompt
      await session.bindExtensions({
        onError: (error) => {
          throw new Error(error.error)
        }
      })
      return { session, events, baseSystemPrompt }
    }
    const sm = SessionManager.create(root, root)
    const { session, events, baseSystemPrompt } = await create(sm, 'startup')
    expect(stream).not.toHaveBeenCalled()
    expect(session.messages).toEqual([])
    expect(events).toEqual([])
    const beforeSubmission = structuredClone(sm.getEntries())
    await session.reload()
    expect(session.messages).toEqual([])
    expect(sm.getEntries()).toEqual(beforeSubmission)
    expect(stream).not.toHaveBeenCalled()

    await session.prompt('First request')
    expect(requests).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({
      role: 'custom',
      customType: 'treeport-context',
      display: false,
      content: expect.stringMatching(/^Treeport context:/)
    })
    expect(events.slice(0, 2).map((event) => event.type)).toEqual([
      'message_start',
      'message_end'
    ])
    const initial = structuredClone(session.messages[0])
    if (initial?.role !== 'custom') {
      throw new Error('Missing initial context')
    }

    expect(session.messages.slice(0, 2).map((message) => message.role)).toEqual(
      ['custom', 'user']
    )
    expect(session.messages[0]).toEqual(initial)
    expect(requests[0]?.systemPrompt).toBe(baseSystemPrompt)
    expect(baseSystemPrompt).not.toContain('Treeport context')
    expect(requests[0]?.messages[0]?.content).toContainEqual({
      type: 'text',
      text: initial?.content
    })

    // Pi flushes a new session file on its first assistant message, not startup.
    const file = sm.getSessionFile()!
    const firstHistory = await readFile(file, 'utf8')
    const persisted = SessionManager.open(file).getBranch()
    expect(
      persisted.filter((entry) => entry.type === 'custom_message')
    ).toHaveLength(1)
    expect(
      persisted.find((entry) => entry.type === 'custom_message')
    ).toMatchObject({ display: false })
    const beforeReload = structuredClone(session.messages)
    await session.reload()
    expect(session.messages).toEqual(beforeReload)
    expect(await readFile(file, 'utf8')).toBe(firstHistory)
    expect(requests).toHaveLength(1)
    await session.prompt('Second request')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.systemPrompt).toBe(requests[0]?.systemPrompt)
    expect(
      requests[1]?.messages.slice(0, requests[0]?.messages.length)
    ).toEqual(requests[0]?.messages)

    const beforeChange = await readFile(file, 'utf8')
    treeName = 'renamed-tree'
    await session.reload()
    expect(requests).toHaveLength(2)
    expect(await readFile(file, 'utf8')).toBe(beforeChange)
    expect(
      session.messages.filter((message) => message.role === 'custom')
    ).toHaveLength(1)
    await session.prompt('Third request')
    expect((await readFile(file, 'utf8')).startsWith(beforeChange)).toBe(true)
    expect(session.messages.at(-3)).toMatchObject({
      role: 'custom',
      display: false,
      content: expect.stringContaining('renamed-tree')
    })
    expect(requests[2]?.systemPrompt).toBe(requests[0]?.systemPrompt)
    expect(
      requests[2]?.messages.slice(0, requests[1]?.messages.length)
    ).toEqual(requests[1]?.messages)
    const roles = session.messages.map((message) => message.role)
    expect(roles).toEqual([
      'custom',
      'user',
      'assistant',
      'user',
      'assistant',
      'custom',
      'user',
      'assistant'
    ])

    const beforeNavigation = await readFile(file, 'utf8')
    const leaf = sm.getLeafId()!
    const earlier = sm
      .getBranch()
      .find(
        (entry) =>
          entry.type === 'message' && entry.message.role === 'assistant'
      )!
    for (let i = 0; i < 2; i++) {
      await session.navigateTree(earlier.id, { summarize: false })
      await session.navigateTree(leaf, { summarize: false })
    }
    expect(await readFile(file, 'utf8')).toBe(beforeNavigation)
    expect(requests).toHaveLength(3)

    session.dispose()
    const beforeResume = await readFile(file, 'utf8')
    const resumed = await create(SessionManager.open(file), 'resume')
    expect(resumed.session.messages).toEqual(session.messages)
    expect(await readFile(file, 'utf8')).toBe(beforeResume)
    expect(requests).toHaveLength(3)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    for (const session of sessions) {
      session.dispose()
    }
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  }
})
