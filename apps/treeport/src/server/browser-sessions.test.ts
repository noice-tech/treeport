import { EventEmitter } from 'node:events'
import http from 'node:http'
import * as Effect from 'effect/Effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { BROWSER_PROTOCOL_VERSION } from '@treeport/shared'
import type {
  BrowserAgentCommand,
  BrowserClientMessage,
  BrowserFrame,
  BrowserOwnerServerMessage,
  BrowserPanel,
  BrowserServerMessage,
  ProductEvent
} from '@treeport/shared'
import type { PlaywrightBrowserCallbacks } from './playwright-browser'
import {
  BrowserSessionManager,
  type BrowserAgentCliRunner,
  type BrowserLocalAutomationConnector,
  type BrowserSessionBrowser,
  type BrowserSessionBrowserFactory,
  type BrowserSessionConfig,
  type BrowserOwnerTransport,
  type BrowserSessionService,
  type BrowserTransport
} from './browser-sessions'
import { testAccess } from './test-access'

const browsers: FakeBrowser[] = []

function runEffect<Result, Failure, Requirements>(
  effect: Effect.Effect<Result, Failure, Requirements>
): Promise<Result> {
  // SAFETY: Browser session test doubles provide every requested application service.
  return Effect.runPromise(effect as Effect.Effect<Result, Failure, never>)
}

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
  closeRequests: boolean[] = []
  closeRequiresConfirmation = false
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
    if (message.type === 'navigate') {
      this.state = { ...this.state, url: message.url }
      this.callbacks.state(this.state)
    }
  }
  async agentCommand(input: BrowserAgentCommand) {
    return input.command
  }
  async setScreencasting(value: boolean) {
    this.screencasting.push(value)
  }
  async requestClose(force: boolean) {
    this.closeRequests.push(force)
    return force || !this.closeRequiresConfirmation
  }
  async close() {
    this.closes += 1
  }
}

function fakeLocalBrowser() {
  interface CdpCommandParameters {
    sessionId?: number
    format?: string
    quality?: number
    maxWidth?: number
    maxHeight?: number
    everyNthFrame?: number
  }
  interface CdpCommand {
    method: string
    params: CdpCommandParameters | null
  }
  const commands: CdpCommand[] = []
  const cdp = Object.assign(new EventEmitter(), {
    commands,
    async send(method: string, params?: CdpCommandParameters) {
      commands.push({ method, params: params ?? null })
      return {}
    },
    async detach() {}
  })
  let currentUrl = 'https://example.com/local'
  const mouse = {
    move: vi.fn(async () => undefined),
    down: vi.fn(async () => undefined),
    up: vi.fn(async () => undefined),
    wheel: vi.fn(async () => undefined)
  }
  const keyboard = {
    down: vi.fn(async () => undefined),
    up: vi.fn(async () => undefined),
    insertText: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined)
  }
  const page = Object.assign(new EventEmitter(), {
    mouse,
    keyboard,
    url: () => currentUrl,
    goto: vi.fn(async (url: string) => {
      currentUrl = url
      return null
    }),
    goBack: vi.fn(async () => null),
    goForward: vi.fn(async () => null),
    reload: vi.fn(async () => null),
    screenshot: vi.fn(async () => Buffer.from([1])),
    ariaSnapshot: vi.fn(async () => '- button "Local target" [ref=e1]'),
    locator: vi.fn(() => ({
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined)
    }))
  })
  const context = {
    pages: () => [page],
    newCDPSession: vi.fn(async () => cdp)
  }
  let connected = true
  const browser = Object.assign(new EventEmitter(), {
    contexts: () => [context],
    isConnected: () => connected,
    close: vi.fn(async () => {
      connected = false
      browser.emit('disconnected')
    })
  })
  return { browser, cdp, page, mouse, keyboard }
}

const browserFactory: BrowserSessionBrowserFactory = (
  _host,
  workspacePath,
  title,
  panelId,
  worktreeId,
  callbacks
) =>
  new FakeBrowser(
    '/cache',
    workspacePath,
    title,
    panelId,
    worktreeId,
    callbacks
  )

function fixture(
  agentCliRunner: BrowserAgentCliRunner | null = null,
  options: {
    panelUrl?: string
    panelTitle?: string
    connectLocalAutomation?: BrowserLocalAutomationConnector
  } = {}
) {
  const events = new EventEmitter()
  const panel: BrowserPanel = {
    id: 'panel_browser',
    kind: 'browser',
    worktreeId: 'worktree',
    title: options.panelTitle ?? 'Browser',
    url: options.panelUrl ?? 'about:blank',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const panels = {
    authorizeBrowserPanel: vi.fn<
      (
        panelId: string
      ) => Effect.Effect<
        { panel: BrowserPanel; worktreePath: string },
        unknown,
        never
      >
    >((_panelId) => Effect.succeed({ panel, worktreePath: '/worktree' })),
    updateBrowserPanelState: vi.fn(
      (_panelId: string, state: { url: string; title: string }) =>
        Effect.sync(() => {
          panel.url = state.url
          panel.title = state.title || new URL(state.url).host || 'Browser'
          panel.updatedAt = '2026-01-01T00:00:01.000Z'
          return { ...panel }
        })
    ),
    openBrowserPanelFromPanel: vi.fn(() =>
      Effect.succeed({ panel: { ...panel, id: 'panel_popup' } })
    )
  }
  const service = testAccess<BrowserSessionService>({
    forkApplicationEffect: (effect: Effect.Effect<void, never, never>) => {
      Effect.runFork(effect)
    },
    panels,
    events: {
      subscribe(listener: (event: ProductEvent) => void) {
        events.on('event', listener)
        return () => events.off('event', listener)
      }
    }
  })
  const config = {
    cacheDir: '/cache',
    dataDir: '/data',
    runtimeDir: '/tmp/treeport-browser-session-test'
  } satisfies BrowserSessionConfig
  const manager = new BrowserSessionManager(
    service,
    config,
    browserFactory,
    agentCliRunner,
    options.connectLocalAutomation
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
  return { manager, service, panels, events, transport, transports }
}

beforeEach(() => browsers.splice(0))

describe('Browser sessions', () => {
  it('authorizes one-use attachment tickets, shares control, and drops stale frames', async () => {
    const value = fixture()
    const first = value.transport('first')
    const firstTicket = await runEffect(
      value.manager.issueTicket('panel_browser', 'client-first')
    )
    await runEffect(value.manager.accept(firstTicket, first.transport))
    expect(first.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controlled: true }
    })
    await expect(
      runEffect(
        value.manager.accept(firstTicket, value.transport('reuse').transport)
      )
    ).rejects.toThrow('INVALID_BROWSER_TICKET')

    const second = value.transport('second')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket('panel_browser', 'client-second')
        ),
        second.transport
      )
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
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket('panel_browser', 'client-late')
        ),
        lateObserver.transport
      )
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
    await vi.waitFor(() =>
      expect(second.messages.at(-1)).toMatchObject({
        type: 'navigationError'
      })
    )
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

    const forwardCommands = browser.commands.filter(
      (command) => command.type === 'forward'
    ).length
    value.manager.message('first', { type: 'takeControl' })
    value.manager.message('second', { type: 'forward' })
    await vi.waitFor(() =>
      expect(first.messages.at(-1)).toMatchObject({
        type: 'controlChanged',
        state: { controlled: true }
      })
    )
    await vi.waitFor(() =>
      expect(second.messages.at(-1)).toMatchObject({
        type: 'navigationError',
        message: 'Take control before you interact with this browser.'
      })
    )
    expect(
      browser.commands.filter((command) => command.type === 'forward')
    ).toHaveLength(forwardCommands)

    await value.manager.dispose()
    expect(browser.closes).toBe(1)
    expect(first.disconnects).toBe(1)
    expect(second.disconnects).toBe(1)
  })

  it('serializes concurrent attachments into one browser process', async () => {
    const value = fixture()
    const firstTicket = await runEffect(
      value.manager.issueTicket('panel_browser', 'client-first')
    )
    const secondTicket = await runEffect(
      value.manager.issueTicket('panel_browser', 'client-second')
    )
    const authorized = await runEffect(
      value.panels.authorizeBrowserPanel('panel_browser')
    )
    let finishAuthorization!: () => void
    const authorization = new Promise<void>((resolve) => {
      finishAuthorization = resolve
    })
    vi.mocked(value.panels.authorizeBrowserPanel).mockImplementation(() =>
      Effect.promise(async () => {
        await authorization
        return authorized
      })
    )
    const first = value.transport('first')
    const second = value.transport('second')
    const attachments = Promise.all([
      runEffect(value.manager.accept(firstTicket, first.transport)),
      runEffect(value.manager.accept(secondTicket, second.transport))
    ])
    finishAuthorization()
    await attachments

    expect(browsers).toHaveLength(1)
    expect(first.messages.at(-1)).toMatchObject({ type: 'controlChanged' })
    expect(second.messages.at(-1)).toMatchObject({ type: 'controlChanged' })
    await value.manager.dispose()
  })

  it('restores daemon-owned addresses and saves agent navigation without a client', async () => {
    const launchUrl = 'http://localhost:4173/from-launch'
    const agentUrl = 'http://localhost:4173/from-agent'
    const runAgentCli = vi.fn<BrowserAgentCliRunner>(async (_target, args) => {
      const browser = browsers[0]!
      if (args[0] === 'attach') {
        expect(browser.state.url).toBe(launchUrl)
        return 'attached'
      }

      if (args[1] === 'goto') {
        browser.state = {
          ...browser.state,
          url: agentUrl,
          title: 'Agent page'
        }
        browser.callbacks.state(browser.state)
        return 'navigated'
      }

      return 'detached'
    })
    const launchValue = fixture(runAgentCli, { panelUrl: launchUrl })

    await expect(
      runEffect(
        launchValue.manager.agentCommand('panel_browser', {
          command: 'goto',
          args: [agentUrl]
        })
      )
    ).resolves.toBe('navigated')
    expect(browsers[0]!.commands[0]).toEqual({
      type: 'navigate',
      url: launchUrl
    })
    expect(launchValue.panels.updateBrowserPanelState).toHaveBeenLastCalledWith(
      'panel_browser',
      {
        url: agentUrl,
        title: 'Agent page'
      }
    )
    await launchValue.manager.dispose()

    const storedUrl = 'http://localhost:4173/from-storage'
    const storedValue = fixture(null, { panelUrl: storedUrl })
    const client = storedValue.transport('stored-client')
    await runEffect(
      storedValue.manager.accept(
        await runEffect(
          storedValue.manager.issueTicket('panel_browser', 'stored-client')
        ),
        client.transport
      )
    )
    expect(browsers[1]!.commands[0]).toEqual({
      type: 'navigate',
      url: storedUrl
    })
    expect(client.messages).toContainEqual(
      expect.objectContaining({
        type: 'ready',
        state: expect.objectContaining({ url: storedUrl })
      })
    )
    await storedValue.manager.dispose()
  })

  it('streams and controls a verified local owner without a second browser runtime', async () => {
    const runAgentCli = vi.fn<BrowserAgentCliRunner>(async (_target, args) =>
      args[0] === 'attach' ? 'attached' : 'snapshot output'
    )
    const localBrowser = fakeLocalBrowser()
    // SAFETY: This faithful fake supplies every Playwright Browser method used by BrowserSessionManager.
    const connectLocalAutomation: BrowserLocalAutomationConnector = async () =>
      localBrowser.browser as never
    const value = fixture(runAgentCli, { connectLocalAutomation })
    const remote = value.transport('remote')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket('panel_browser', 'remote-client')
        ),
        remote.transport
      )
    )
    expect(browsers).toHaveLength(1)

    const ownerTicket = await runEffect(
      value.manager.issueOwnerTicket('panel_browser', 'desktop-client')
    )
    let automationRequests = 0
    const ownerServer = http.createServer((request, response) => {
      if (request.url === '/private/identity') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            panelId: 'panel_browser',
            challenge: ownerTicket.challenge
          })
        )
        return
      }

      automationRequests += 1
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) =>
      ownerServer.listen(0, '127.0.0.1', resolve)
    )
    const address = z
      .object({ port: z.number().int().positive() })
      .parse(ownerServer.address())

    const ownerMessages: BrowserOwnerServerMessage[] = []
    let ownerConnected = true
    let acceptRuntimeControl = true
    const ownerTransport: BrowserOwnerTransport = {
      id: 'local-owner',
      isConnected: () => ownerConnected,
      send: (message) => {
        ownerMessages.push(message)
        if (message.type === 'runtimeControl') {
          queueMicrotask(() =>
            value.manager.ownerMessage('local-owner', {
              type: 'runtimeControlResult',
              generation: message.generation,
              requestId: message.requestId,
              accepted: acceptRuntimeControl
            })
          )
        } else if (message.type === 'closeRequest') {
          queueMicrotask(() =>
            value.manager.ownerMessage('local-owner', {
              type: 'closeResult',
              generation: message.generation,
              requestId: message.requestId,
              canClose: false
            })
          )
        }

        return true
      },
      disconnect: () => {
        ownerConnected = false
      }
    }
    await runEffect(
      value.manager.acceptOwner(
        {
          ticket: ownerTicket.ticket,
          challenge: ownerTicket.challenge,
          endpoint: `http://127.0.0.1:${address.port}/private/`,
          protocolVersion: BROWSER_PROTOCOL_VERSION
        },
        ownerTransport
      )
    )
    expect(browsers[0]!.closes).toBe(1)
    expect(ownerMessages[0]).toMatchObject({
      type: 'claimGranted',
      panelId: 'panel_browser'
    })
    const claim = ownerMessages.find(
      (message) => message.type === 'claimGranted'
    )
    if (!claim || claim.type !== 'claimGranted') {
      throw new Error('The local owner claim was not granted.')
    }

    const generation = claim.generation
    let agentSettled = false
    const beforeReadyAgent = runEffect(
      value.manager.agentCommand('panel_browser', {
        command: 'snapshot',
        args: []
      })
    )
    void beforeReadyAgent
      .finally(() => {
        agentSettled = true
      })
      .catch(() => undefined)
    await vi.waitFor(() =>
      expect(ownerMessages).toContainEqual(
        expect.objectContaining({
          type: 'runtimeControl',
          controller: 'agent',
          retainPaint: true
        })
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(agentSettled).toBe(false)
    expect(automationRequests).toBe(0)

    value.manager.ownerMessage('local-owner', {
      type: 'ready',
      generation,
      revision: 1,
      state: {
        url: 'https://example.com/local',
        title: 'Visible local page',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        viewport: { width: 900, height: 600 }
      }
    })
    await vi.waitFor(() =>
      expect(value.panels.updateBrowserPanelState).toHaveBeenCalledWith(
        'panel_browser',
        {
          url: 'https://example.com/local',
          title: 'Visible local page'
        }
      )
    )
    value.manager.ownerMessage('local-owner', {
      type: 'popup',
      generation,
      url: 'https://example.com/popup'
    })
    await vi.waitFor(() =>
      expect(value.panels.openBrowserPanelFromPanel).toHaveBeenCalledWith(
        'panel_browser',
        'https://example.com/popup'
      )
    )

    const observer = value.transport('observer')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket('panel_browser', 'observer-client', false)
        ),
        observer.transport
      )
    )
    expect(observer.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controlled: false }
    })
    value.manager.message('observer', { type: 'setVisible', visible: true })
    await vi.waitFor(() =>
      expect(ownerMessages.at(-1)).toMatchObject({
        type: 'runtimeControl',
        controller: 'none',
        retainPaint: true
      })
    )
    expect(observer.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controlled: false, controller: 'other' }
    })
    expect(browsers).toHaveLength(1)
    await expect(
      value.manager.requestPanelClose('panel_browser')
    ).resolves.toBe(false)

    await expect(beforeReadyAgent).resolves.toBe(
      '- button "Local target" [ref=e1]'
    )
    expect(automationRequests).toBe(0)
    await vi.waitFor(() =>
      expect(localBrowser.cdp.commands).toContainEqual(
        expect.objectContaining({ method: 'Page.startScreencast' })
      )
    )
    localBrowser.cdp.emit('Page.screencastFrame', {
      data: Buffer.from([7]).toString('base64'),
      metadata: { timestamp: 1, deviceWidth: 900, deviceHeight: 600 },
      sessionId: 1
    })
    await vi.waitFor(() => expect(remote.frames).toHaveLength(1))
    expect([...remote.frames[0]!.data]).toEqual([7])
    expect(observer.frames).toHaveLength(1)

    value.manager.message('remote', { type: 'takeControl' })
    await vi.waitFor(() =>
      expect(remote.messages.at(-1)).toMatchObject({
        type: 'controlChanged',
        state: { controlled: true, controller: 'you' }
      })
    )
    value.manager.message('remote', {
      type: 'pointer',
      phase: 'down',
      x: 40,
      y: 50,
      button: 'left'
    })
    await vi.waitFor(() =>
      expect(localBrowser.mouse.down).toHaveBeenCalledWith({ button: 'left' })
    )

    value.manager.close('remote')
    const reconnectedRemote = value.transport('remote-reconnected')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket('panel_browser', 'remote-client', true)
        ),
        reconnectedRemote.transport
      )
    )
    expect(reconnectedRemote.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controlled: true, controller: 'you' }
    })
    const resumedFrame = reconnectedRemote.frames.at(-1)
    if (resumedFrame) {
      value.manager.message('remote-reconnected', {
        type: 'frameAck',
        sequence: resumedFrame.sequence
      })
    }

    value.manager.ownerMessage('local-owner', {
      type: 'takeControl',
      generation
    })
    await vi.waitFor(() =>
      expect(ownerMessages.at(-1)).toMatchObject({
        type: 'runtimeControl',
        controller: 'none',
        retainPaint: true
      })
    )
    await vi.waitFor(() =>
      expect(reconnectedRemote.messages.at(-1)).toMatchObject({
        type: 'controlChanged',
        state: { controlled: false, controller: 'other' }
      })
    )
    expect(browsers).toHaveLength(1)
    expect(runAgentCli).not.toHaveBeenCalled()

    acceptRuntimeControl = false
    value.manager.message('observer', { type: 'takeControl' })
    await vi.waitFor(() =>
      expect(observer.messages.at(-1)).toEqual({
        type: 'navigationError',
        message: 'The local Browser owner did not accept control.'
      })
    )
    expect(
      [...observer.messages]
        .reverse()
        .find(
          (message) =>
            message.type === 'ready' ||
            message.type === 'state' ||
            message.type === 'controlChanged'
        )
    ).toMatchObject({ state: { controlled: false, controller: 'other' } })
    acceptRuntimeControl = true

    ownerConnected = false
    value.manager.closeOwner('local-owner')
    localBrowser.cdp.emit('Page.screencastFrame', {
      data: Buffer.from([8]).toString('base64'),
      metadata: { timestamp: 2, deviceWidth: 900, deviceHeight: 600 },
      sessionId: 2
    })
    await vi.waitFor(() => expect(reconnectedRemote.frames).toHaveLength(2))
    expect([...reconnectedRemote.frames[1]!.data]).toEqual([8])

    const resumedTicket = await runEffect(
      value.manager.issueOwnerTicket('panel_browser', 'desktop-client')
    )
    expect(resumedTicket.challenge).toBe(ownerTicket.challenge)
    const resumedMessages: BrowserOwnerServerMessage[] = []
    let resumedConnected = true
    const resumedTransport: BrowserOwnerTransport = {
      id: 'local-owner-resumed',
      isConnected: () => resumedConnected,
      send: (message) => {
        resumedMessages.push(message)
        if (message.type === 'runtimeControl') {
          queueMicrotask(() =>
            value.manager.ownerMessage('local-owner-resumed', {
              type: 'runtimeControlResult',
              generation: message.generation,
              requestId: message.requestId,
              accepted: true
            })
          )
        }

        return true
      },
      disconnect: () => {
        resumedConnected = false
      }
    }
    await runEffect(
      value.manager.acceptOwner(
        {
          ticket: resumedTicket.ticket,
          challenge: resumedTicket.challenge,
          endpoint: `http://127.0.0.1:${address.port}/private/`,
          protocolVersion: BROWSER_PROTOCOL_VERSION
        },
        resumedTransport
      )
    )
    expect(resumedMessages[0]).toMatchObject({
      type: 'claimGranted',
      generation,
      resumed: true
    })
    value.manager.ownerMessage('local-owner-resumed', {
      type: 'ready',
      generation,
      revision: 1,
      state: {
        url: 'https://example.com/local',
        title: 'Visible local page',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        viewport: { width: 900, height: 600 }
      }
    })
    await expect(
      runEffect(
        value.manager.agentCommand('panel_browser', {
          command: 'snapshot',
          args: []
        })
      )
    ).resolves.toBe('- button "Local target" [ref=e1]')
    expect(browsers).toHaveLength(1)
    expect(runAgentCli).not.toHaveBeenCalled()

    value.manager.ownerMessage('local-owner-resumed', {
      type: 'released',
      generation
    })
    await vi.waitFor(() => expect(browsers).toHaveLength(2))
    expect(localBrowser.browser.close).toHaveBeenCalledOnce()

    await value.manager.dispose()
    await new Promise<void>((resolve) => ownerServer.close(() => resolve()))
  })

  it('uses a page beforeunload request instead of a generic close confirmation', async () => {
    const value = fixture()
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('panel_browser', 'client')),
        client.transport
      )
    )
    const browser = browsers[0]!
    browser.closeRequiresConfirmation = true

    await expect(
      value.manager.requestPanelClose('panel_browser')
    ).resolves.toBe(false)
    expect(browser.closeRequests).toEqual([false])
    expect(browser.closes).toBe(0)

    await expect(
      value.manager.requestPanelClose('panel_browser', true)
    ).resolves.toBe(true)
    expect(browser.closeRequests).toEqual([false, true])
    await value.manager.closePanel('panel_browser', 'Browser closed.')
    expect(browser.closes).toBe(1)
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
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('panel_browser', 'client')),
        client.transport
      )
    )

    const agent = runEffect(
      value.manager.agentCommand('panel_browser', {
        command: 'snapshot',
        args: []
      })
    )
    await vi.waitFor(() =>
      expect(client.messages.at(-1)).toMatchObject({
        type: 'controlChanged',
        state: { controller: 'agent', controlled: false }
      })
    )
    value.manager.message('client', { type: 'takeControl' })
    for (let index = 0; index < 100; index += 1) {
      value.manager.message('client', {
        type: 'pointer',
        phase: 'move',
        x: index,
        y: index + 1
      })
      value.manager.message('client', {
        type: 'wheel',
        deltaX: 1,
        deltaY: -2
      })
    }
    value.manager.message('client', {
      type: 'pointer',
      phase: 'down',
      x: 20,
      y: 30,
      button: 'left'
    })
    for (let index = 0; index < 60; index += 1) {
      value.manager.message('client', {
        type: 'key',
        phase: 'down',
        key: `Key${index}`
      })
    }
    expect(browsers[0]!.commands).toEqual([])
    expect(client.messages).toContainEqual({
      type: 'navigationError',
      message: 'The Browser command queue is full. Wait and try again.'
    })

    finishAgent()
    await expect(agent).resolves.toBe('snapshot')
    await vi.waitFor(() =>
      expect(browsers[0]!.commands).toContainEqual({
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
    expect(browsers[0]!.commands).toContainEqual({
      type: 'pointer',
      phase: 'move',
      x: 99,
      y: 100
    })
    expect(browsers[0]!.commands).toContainEqual({
      type: 'wheel',
      deltaX: 100,
      deltaY: -200
    })
    expect(client.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controller: 'you', controlled: true }
    })
    await value.manager.dispose()
  })

  it('routes browser popups through durable BrowserPanel creation', async () => {
    const value = fixture()
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('panel_browser', 'client')),
        client.transport
      )
    )

    browsers[0]!.callbacks.popup('https://example.com/popup')
    await vi.waitFor(() =>
      expect(value.panels.openBrowserPanelFromPanel).toHaveBeenCalledWith(
        'panel_browser',
        'https://example.com/popup'
      )
    )
    await value.manager.dispose()
  })

  it('closes the browser when its owning worktree is removed', async () => {
    const value = fixture()
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('panel_browser', 'client')),
        client.transport
      )
    )
    vi.mocked(value.panels.authorizeBrowserPanel).mockReturnValue(
      Effect.fail(new Error('removed'))
    )
    value.events.emit('event', {
      type: 'worktree.removed',
      data: { projectId: 'project', worktreeId: 'worktree' }
    })

    await vi.waitFor(() => expect(browsers[0]!.closes).toBe(1))
    expect(client.messages.at(-1)).toEqual({
      type: 'closed',
      reason: 'Worktree removed'
    })
    await value.manager.dispose()
  })

  it('closes the browser when the durable panel is removed', async () => {
    const value = fixture()
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('panel_browser', 'client')),
        client.transport
      )
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
