import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientMessage,
  BrowserFrame,
  BrowserServerMessage,
  ProductEvent,
  WebPanel
} from '@treeport/shared'
import type { PlaywrightBrowserCallbacks } from './playwright-browser'
import {
  BrowserSessionManager,
  type BrowserAgentCliRunner,
  type BrowserSessionBrowser,
  type BrowserSessionBrowserFactory,
  type BrowserSessionConfig,
  type BrowserSessionService,
  type BrowserTransport
} from './browser-sessions'

const browsers: FakeBrowser[] = []

class FakeBrowser implements BrowserSessionBrowser {
  state: BrowserSessionBrowser['state'] = {
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: { width: 1_280, height: 800 }
  }
  commands: BrowserClientMessage[] = []
  screencasting: boolean[] = []
  closes = 0
  constructor(
    _cachePath: string,
    _worktreePath: string,
    _title: string,
    _panelId: string,
    _worktreeId: string,
    readonly callbacks: PlaywrightBrowserCallbacks
  ) {
    browsers.push(this)
  }
  async launch() {}
  async command(message: BrowserClientMessage) {
    this.commands.push(message)
  }
  async setScreencasting(value: boolean) {
    this.screencasting.push(value)
  }
  async close() {
    this.closes += 1
  }
}

const browserFactory: BrowserSessionBrowserFactory = (
  cachePath,
  workspacePath,
  title,
  panelId,
  worktreeId,
  callbacks
) =>
  new FakeBrowser(
    cachePath,
    workspacePath,
    title,
    panelId,
    worktreeId,
    callbacks
  )

function fixture(agentCliRunner: BrowserAgentCliRunner | null = null) {
  const events = new EventEmitter()
  const panel: WebPanel = {
    id: 'panel_browser',
    kind: 'web',
    worktreeId: 'worktree',
    definitionId:
      'package:npm:@treeport/web-panel-browser:web-panel:remote-browser',
    title: 'Remote browser',
    launch: { input: null, cwd: null },
    permissions: ['host-browser'],
    sandbox: { allowSameOrigin: false },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const service = {
    authorizeHostBrowserPanel: vi.fn(async (_panelId: string) => ({
      panel,
      worktreePath: '/worktree'
    })),
    events: {
      subscribe(listener: (event: ProductEvent) => void) {
        events.on('event', listener)
        return () => events.off('event', listener)
      }
    }
  } satisfies BrowserSessionService
  const config = {
    cacheDir: '/cache',
    runtimeDir: '/tmp/treeport-browser-session-test'
  } satisfies BrowserSessionConfig
  const manager = new BrowserSessionManager(
    service,
    config,
    browserFactory,
    agentCliRunner
  )
  const transports: Array<{
    transport: BrowserTransport
    messages: BrowserServerMessage[]
    frames: BrowserFrame[]
    disconnects: number
  }> = []
  const transport = (id: string) => {
    const messages: BrowserServerMessage[] = []
    const frames: BrowserFrame[] = []
    let disconnects = 0
    const browserTransport: BrowserTransport = {
      id,
      isConnected: () => true,
      sendMessage: (message) => {
        messages.push(message)
        return true
      },
      sendFrame: (frame) => {
        frames.push(frame)
        return true
      },
      disconnect: () => {
        disconnects += 1
      }
    }
    const value = {
      transport: browserTransport,
      messages,
      frames,
      get disconnects() {
        return disconnects
      }
    }
    transports.push(value)
    return value
  }
  return { manager, service, events, transport, transports }
}

beforeEach(() => browsers.splice(0))

describe('Remote Browser sessions', () => {
  it('authorizes one-use attachment tickets, shares control, and drops stale frames', async () => {
    const value = fixture()
    const first = value.transport('first')
    const firstTicket = await value.manager.issueTicket(
      'panel_browser',
      'client-first'
    )
    await value.manager.accept(firstTicket, first.transport)
    expect(first.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controlled: true }
    })
    await expect(
      value.manager.accept(firstTicket, value.transport('reuse').transport)
    ).rejects.toThrow('INVALID_BROWSER_TICKET')

    const second = value.transport('second')
    await value.manager.accept(
      await value.manager.issueTicket('panel_browser', 'client-second'),
      second.transport
    )
    expect(second.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controlled: false, hasController: true }
    })

    const browser = browsers[0]!
    browser.callbacks.frame({
      mimeType: 'image/jpeg',
      timestamp: 1,
      width: 800,
      height: 600,
      data: new Uint8Array([1])
    })
    browser.callbacks.frame({
      mimeType: 'image/jpeg',
      timestamp: 2,
      width: 800,
      height: 600,
      data: new Uint8Array([2])
    })
    browser.callbacks.frame({
      mimeType: 'image/jpeg',
      timestamp: 3,
      width: 800,
      height: 600,
      data: new Uint8Array([3])
    })
    const lateObserver = value.transport('late-observer')
    await value.manager.accept(
      await value.manager.issueTicket('panel_browser', 'client-late'),
      lateObserver.transport
    )
    expect(lateObserver.frames).toHaveLength(1)
    expect([...lateObserver.frames[0]!.data]).toEqual([3])
    expect(first.frames).toHaveLength(1)
    value.manager.message('first', {
      type: 'frameAck',
      sequence: first.frames[0]!.sequence
    })
    expect(first.frames).toHaveLength(2)
    expect([...first.frames[1]!.data]).toEqual([3])

    const observerMessageCount = second.messages.length
    value.manager.message('second', {
      type: 'resize',
      width: 900,
      height: 500
    })
    expect(browser.commands).toEqual([])
    expect(second.messages).toHaveLength(observerMessageCount)

    value.manager.message('second', { type: 'back' })
    expect(browser.commands).toEqual([])
    expect(second.messages.at(-1)).toMatchObject({
      type: 'navigationError'
    })
    value.manager.message('second', { type: 'takeControl' })
    value.manager.message('second', { type: 'back' })
    await vi.waitFor(() =>
      expect(browser.commands.at(-1)).toEqual({ type: 'back' })
    )
    expect(browser.commands[0]).toEqual({
      type: 'resize',
      width: 900,
      height: 500
    })
    expect(first.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controlled: false }
    })

    await value.manager.dispose()
    expect(browser.closes).toBe(1)
    expect(first.disconnects).toBe(1)
    expect(second.disconnects).toBe(1)
  })

  it('serializes concurrent attachments into one browser process', async () => {
    const value = fixture()
    const firstTicket = await value.manager.issueTicket(
      'panel_browser',
      'client-first'
    )
    const secondTicket = await value.manager.issueTicket(
      'panel_browser',
      'client-second'
    )
    const authorized =
      await value.service.authorizeHostBrowserPanel('panel_browser')
    let finishAuthorization!: () => void
    const authorization = new Promise<void>((resolve) => {
      finishAuthorization = resolve
    })
    vi.mocked(value.service.authorizeHostBrowserPanel).mockImplementation(
      async () => {
        await authorization
        return authorized
      }
    )
    const first = value.transport('first')
    const second = value.transport('second')
    const attachments = Promise.all([
      value.manager.accept(firstTicket, first.transport),
      value.manager.accept(secondTicket, second.transport)
    ])
    finishAuthorization()
    await attachments

    expect(browsers).toHaveLength(1)
    expect(first.messages.at(-1)).toMatchObject({ type: 'controlChanged' })
    expect(second.messages.at(-1)).toMatchObject({ type: 'controlChanged' })
    await value.manager.dispose()
  })

  it('closes an active session when its permission is revoked', async () => {
    const value = fixture()
    const client = value.transport('client')
    await value.manager.accept(
      await value.manager.issueTicket('panel_browser', 'client'),
      client.transport
    )
    vi.mocked(value.service.authorizeHostBrowserPanel).mockRejectedValue(
      new Error('revoked')
    )
    value.events.emit('event', {
      type: 'panel.updated',
      data: { panelId: 'panel_browser', worktreeId: 'worktree' }
    })

    await vi.waitFor(() =>
      expect(client.messages.at(-1)).toEqual({
        type: 'closed',
        reason: 'Remote Browser permission revoked'
      })
    )
    expect(browsers[0]!.closes).toBe(1)
    expect(client.disconnects).toBe(1)
    await value.manager.dispose()
  })

  it('queues a user takeover until an agent command releases control', async () => {
    let finishAgent!: () => void
    const runAgentCli = vi
      .fn<BrowserAgentCliRunner>()
      .mockResolvedValue('detached')
      .mockResolvedValueOnce('attached')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishAgent = () => resolve('snapshot')
          })
      )
    const value = fixture(runAgentCli)
    const client = value.transport('client')
    await value.manager.accept(
      await value.manager.issueTicket('panel_browser', 'client'),
      client.transport
    )

    const agent = value.manager.agentCommand('panel_browser', {
      command: 'snapshot',
      args: []
    })
    await vi.waitFor(() =>
      expect(client.messages.at(-1)).toMatchObject({
        type: 'controlChanged',
        state: { controller: 'agent', controlled: false }
      })
    )
    value.manager.message('client', { type: 'takeControl' })
    value.manager.message('client', {
      type: 'pointer',
      phase: 'down',
      x: 20,
      y: 30,
      button: 'left'
    })
    expect(browsers[0]!.commands).toEqual([])

    finishAgent()
    await expect(agent).resolves.toBe('snapshot')
    await vi.waitFor(() =>
      expect(browsers[0]!.commands.at(-1)).toEqual({
        type: 'pointer',
        phase: 'down',
        x: 20,
        y: 30,
        button: 'left'
      })
    )
    expect(browsers[0]!.commands[0]).toEqual({
      type: 'resize',
      width: 1_280,
      height: 800
    })
    expect(client.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controller: 'you', controlled: true }
    })
    await value.manager.dispose()
  })

  it('closes the browser when the durable panel is removed', async () => {
    const value = fixture()
    const client = value.transport('client')
    await value.manager.accept(
      await value.manager.issueTicket('panel_browser', 'client'),
      client.transport
    )
    value.events.emit('event', {
      type: 'panel.removed',
      data: { panelId: 'panel_browser', worktreeId: 'worktree' }
    })
    await vi.waitFor(() => expect(browsers[0]!.closes).toBe(1))
    expect(client.messages.at(-1)).toEqual({
      type: 'closed',
      reason: 'Panel closed'
    })
    expect(client.disconnects).toBe(1)
    await value.manager.dispose()
  })
})
