import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import { expect, it, vi } from 'vitest'
import treeportExtension from './index.ts'

it('loads tools on demand and calls structured tools from codemode across reload, branch navigation, and resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'treeport-pi-lifecycle-'))

  const sessions: Array<
    Awaited<ReturnType<typeof createAgentSession>>['session']
  > = []

  const fetch = vi.fn(() => {
    throw new Error('Unexpected network request')
  })

  vi.stubGlobal('fetch', fetch)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

  try {
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
                name: 'test-tree',
                path: root
              },
              terminal: { id: 'terminal', worktreeId: 'tree', name: 'Pi' }
            }
          : { content: 'Server ready' }
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

    let nextCall: { name: string; arguments: Record<string, string> } | null =
      null

    const stream = vi
      .spyOn(modelRuntime, 'streamSimple')
      .mockImplementation((model, context) => {
        requests.push(structuredClone(context))
        const call = nextCall
        nextCall = null

        const message: Awaited<ReturnType<ModelRuntime['completeSimple']>> = {
          role: 'assistant',
          content: call
            ? [{ type: 'toolCall', id: `call-${requests.length}`, ...call }]
            : [{ type: 'text', text: 'Mock reply' }],
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
          stopReason: call ? 'toolUse' : 'stop',
          timestamp: Date.now()
        }

        type Stream = ReturnType<ModelRuntime['streamSimple']>

        const fixture: Pick<Stream, typeof Symbol.asyncIterator | 'result'> = {
          async *[Symbol.asyncIterator]() {
            yield { type: 'done', reason: call ? 'toolUse' : 'stop', message }
          },
          result: async () => message
        }

        // SAFETY: The agent only consumes the iterator and result of this stream.
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
        extensionFactories: [
          createCodemodeExtension({ models: false }),
          (pi) => treeportExtension({ ...pi, exec })
        ]
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
        noTools: 'builtin',
        sessionStartEvent: { type: 'session_start', reason }
      })

      sessions.push(session)
      await session.bindExtensions({
        onError: (error) => {
          throw new Error(error.error)
        }
      })
      session.setActiveToolsByName([
        ...session.getActiveToolNames(),
        'codemode'
      ])

      return session
    }

    const sm = SessionManager.create(root, root)
    const session = await create(sm, 'startup')
    expect(session.getActiveToolNames().sort()).toEqual([
      'codemode',
      'treeport_enable'
    ])
    expect(session.messages).toEqual([])
    expect(stream).not.toHaveBeenCalled()
    const beforeSubmission = structuredClone(sm.getEntries())
    await session.reload()
    session.setActiveToolsByName([...session.getActiveToolNames(), 'codemode'])
    expect(session.messages).toEqual([])
    expect(sm.getEntries()).toEqual(beforeSubmission)

    await session.prompt('First request')
    expect(requests).toHaveLength(1)
    expect(
      session.messages.filter((message) => message.role !== 'system')[0]?.role
    ).toBe('user')
    const firstLeaf = sm.getLeafId()!
    const file = sm.getSessionFile()!
    const initialHistory = await readFile(file, 'utf8')
    nextCall = { name: 'treeport_enable', arguments: {} }
    await session.prompt('Enable Treeport')
    expect(requests).toHaveLength(3)
    expect(session.getActiveToolNames()).toContain('treeport_terminal_capture')
    expect((await readFile(file, 'utf8')).startsWith(initialHistory)).toBe(true)
    expect(session.messages.some((message) => message.role === 'custom')).toBe(
      false
    )

    const loaderResult = session.messages.find(
      (message) =>
        message.role === 'toolResult' && message.toolName === 'treeport_enable'
    )

    expect(loaderResult).toMatchObject({ isError: false })
    expect(JSON.stringify(loaderResult)).toContain('test-tree')

    nextCall = {
      name: 'codemode',
      arguments: {
        code: 'const results = await Promise.all([tools.treeport_context({}), tools.treeport_terminal_capture({terminal: "child"})]); return {tree: results[0].worktree.name, output: results[1].content};'
      }
    }
    await session.prompt('Read tree and terminal output in parallel')

    const codeResult = session.messages.find(
      (message) =>
        message.role === 'toolResult' && message.toolName === 'codemode'
    )

    expect(codeResult).toMatchObject({ isError: false })
    expect(JSON.stringify(codeResult)).toContain('Server ready')
    expect(JSON.stringify(codeResult)).toContain('test-tree')
    const enabledLeaf = sm.getLeafId()!
    const history = await readFile(file, 'utf8')
    const messages = structuredClone(session.messages)
    await session.reload()
    expect(session.getActiveToolNames()).toContain('treeport_context')
    expect(session.messages).toEqual(messages)
    expect(await readFile(file, 'utf8')).toBe(history)
    await session.navigateTree(firstLeaf, { summarize: false })
    expect(session.getActiveToolNames()).not.toContain('treeport_context')
    await session.navigateTree(enabledLeaf, { summarize: false })
    expect(session.getActiveToolNames()).toContain('treeport_context')
    expect(await readFile(file, 'utf8')).toBe(history)
    session.dispose()
    const resumed = await create(SessionManager.open(file), 'resume')
    expect(resumed.getActiveToolNames()).toContain('treeport_context')
    expect(resumed.messages).toEqual(messages)
    expect(await readFile(file, 'utf8')).toBe(history)
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
