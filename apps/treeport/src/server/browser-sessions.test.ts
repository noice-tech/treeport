import { EventEmitter } from 'node:events'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import type {
  BrowserAgentCommand,
  BrowserClientMessage,
  BrowserOwnerServerMessage,
  BrowserApp,
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
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: { width: 1_280, height: 800 }
  }
  commands: BrowserClientMessage[] = []
  screencasting: boolean[] = []
  readonly negotiateVideo = vi.fn(
    async (_peerId: string, _sdp: string) => 'answer'
  )
  readonly closeVideoPeer = vi.fn(async (_peerId: string) => undefined)
  closeRequests: boolean[] = []
  closeRequiresConfirmation = false
  closes = 0
  constructor(
    _cachePath: string,
    _worktreePath: string,
    _title: string,
    _appId: string,
    _worktreeId: string,
    readonly callbacks: PlaywrightBrowserCallbacks
  ) {
    browsers.push(this)
  }
  async launch() {}
  async copy() {
    return null
  }

  async cursor() {
    return 'default' as const
  }

  async command(message: BrowserClientMessage) {
    this.commands.push(message)
    if (message.type === 'navigate') {
      this.state = { ...this.state, url: message.url }
      this.callbacks.state(this.state)
    } else if (message.type === 'resize') {
      this.state = {
        ...this.state,
        viewport: { width: message.width, height: message.height }
      }
      this.callbacks.state(this.state)
    }
  }
  async agentCommand(input: BrowserAgentCommand): Promise<string> {
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
      return method === 'Page.getLayoutMetrics'
        ? { cssVisualViewport: { scale: 2 } }
        : method === 'Treeport.negotiateVideo'
          ? { sdp: 'local-answer' }
          : {}
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
  appId,
  worktreeId,
  callbacks
) =>
  new FakeBrowser('/cache', workspacePath, title, appId, worktreeId, callbacks)

function fixture(
  agentCliRunner: BrowserAgentCliRunner | null = null,
  options: {
    appUrl?: string
    appTitle?: string
    connectLocalAutomation?: BrowserLocalAutomationConnector
  } = {}
) {
  const events = new EventEmitter()
  const app: BrowserApp = {
    id: 'app_browser',
    kind: 'browser',
    worktreeId: 'worktree',
    title: options.appTitle ?? 'Browser',
    url: options.appUrl ?? 'about:blank',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const apps = {
    authorizeBrowserApp: vi.fn<
      (
        appId: string
      ) => Effect.Effect<
        { app: BrowserApp; worktreePath: string },
        unknown,
        never
      >
    >((_appId) => Effect.succeed({ app, worktreePath: '/worktree' })),
    updateBrowserAppState: vi.fn(
      (_appId: string, state: { url: string; title: string }) =>
        Effect.sync(() => {
          app.url = state.url
          app.title = state.title || new URL(state.url).host || 'Browser'
          app.updatedAt = '2026-01-01T00:00:01.000Z'
          return { ...app }
        })
    ),
    openBrowserAppFromApp: vi.fn(() =>
      Effect.succeed({ app: { ...app, id: 'app_popup' } })
    )
  }
  const service = testAccess<BrowserSessionService>({
    forkApplicationEffect: (effect: Effect.Effect<void, never, never>) => {
      Effect.runFork(effect)
    },
    apps,
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
    runtimeDir: fs.mkdtempSync(
      path.join(os.tmpdir(), 'treeport-browser-session-test-')
    )
  } satisfies BrowserSessionConfig
  const manager = new BrowserSessionManager(
    service,
    config,
    browserFactory,
    agentCliRunner,
    options.connectLocalAutomation
  )
  onTestFinished(async () => {
    await manager.dispose()
    await fs.promises.rm(config.runtimeDir, { recursive: true, force: true })
  })
  const transports: Array<{
    transport: BrowserTransport
    messages: BrowserServerMessage[]
    disconnects: number
  }> = []
  const transport = (id: string) => {
    const messages: BrowserServerMessage[] = []
    let disconnects = 0
    const browserTransport: BrowserTransport = {
      id,
      isConnected: () => true,
      sendMessage: (message) => {
        messages.push(message)
        return true
      },
      disconnect: () => {
        disconnects += 1
      }
    }
    const value = {
      transport: browserTransport,
      messages,
      get disconnects() {
        return disconnects
      }
    }
    transports.push(value)
    return value
  }
  return { manager, service, apps, events, transport, transports }
}

beforeEach(() => browsers.splice(0))

describe('Browser sessions', () => {
  it('bounds video negotiation without blocking input and revokes hidden viewers', async () => {
    const value = fixture()
    const viewer = value.transport('viewer')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket('app_browser', 'client-viewer')
        ),
        viewer.transport
      )
    )
    expect(viewer.messages).toContainEqual({ type: 'videoReady' })
    const browser = browsers[0]!
    let answer!: (sdp: string) => void
    browser.negotiateVideo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    value.manager.message('viewer', {
      type: 'videoOffer',
      requestId: 'first',
      sdp: 'offer'
    })
    value.manager.message('viewer', {
      type: 'videoOffer',
      requestId: 'duplicate',
      sdp: 'offer'
    })
    expect(browser.negotiateVideo).toHaveBeenCalledTimes(1)
    value.manager.message('viewer', {
      type: 'wheel',
      x: 10,
      y: 20,
      deltaX: 0,
      deltaY: 10,
      modifiers: 0
    })
    await vi.waitFor(() => expect(browser.commands).toHaveLength(1))
    value.manager.message('viewer', { type: 'setVisible', visible: false })
    expect(browser.closeVideoPeer).toHaveBeenCalledWith('viewer')
    // Return before the hidden negotiation finishes. Readiness must wait for
    // its cleanup, otherwise the only resumed offer is silently discarded.
    browser.screencasting.length = 0
    value.manager.message('viewer', { type: 'setVisible', visible: true })
    await vi.waitFor(() => expect(browser.screencasting).toContain(true))
    expect(
      viewer.messages.filter((message) => message.type === 'videoReady')
    ).toHaveLength(1)
    answer('stale-answer')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      viewer.messages.some((message) => message.type === 'videoAnswer')
    ).toBe(false)
    await vi.waitFor(() =>
      expect(
        viewer.messages.filter((message) => message.type === 'videoReady')
      ).toHaveLength(2)
    )
    value.manager.message('viewer', {
      type: 'videoOffer',
      requestId: 'resumed',
      sdp: 'offer'
    })
    await vi.waitFor(() =>
      expect(viewer.messages).toContainEqual({
        type: 'videoAnswer',
        requestId: 'resumed',
        sdp: 'answer'
      })
    )
    const observer = value.transport('observer')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'observer')),
        observer.transport
      )
    )
    value.manager.message('viewer', { type: 'resize', width: 900, height: 600 })
    value.manager.message('observer', {
      type: 'resize',
      width: 600,
      height: 900
    })
    await vi.waitFor(() =>
      expect(browser.state.viewport).toEqual({ width: 900, height: 600 })
    )

    // Visibility handoff must use the observer's already-reported dimensions.
    value.manager.message('viewer', { type: 'setVisible', visible: false })
    await vi.waitFor(() =>
      expect(observer.messages.at(-1)).toMatchObject({
        type: 'controlChanged',
        state: { controlled: true, viewport: { width: 600, height: 900 } }
      })
    )
    expect(browser.state.viewport).toEqual({ width: 600, height: 900 })

    value.manager.message('viewer', { type: 'setVisible', visible: true })
    // Disconnect handoff must restore the original size without a new resize
    // event: this viewer's app dimensions never changed.
    value.manager.close('observer')
    await vi.waitFor(() =>
      expect(viewer.messages.at(-1)).toMatchObject({
        type: 'controlChanged',
        state: { controlled: true, viewport: { width: 900, height: 600 } }
      })
    )
    expect(browser.state.viewport).toEqual({ width: 900, height: 600 })

    value.manager.close('viewer')
    expect(browser.closeVideoPeer).toHaveBeenCalledWith('viewer')

    // Restoring a workspace must not see its disconnected viewer as someone
    // else's controller, even if client storage was unavailable on reload.
    const restored = value.transport('restored-viewer')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket('app_browser', 'restored-client')
        ),
        restored.transport
      )
    )
    expect(restored.messages).toContainEqual({
      type: 'ready',
      state: expect.objectContaining({ controlled: true, controller: 'you' })
    })
    expect(browsers).toHaveLength(1)
    await value.manager.dispose()
  })

  it('authorizes one-use attachment tickets, shares control, and isolates video peers', async () => {
    const value = fixture()
    const identity = {
      account: {
        source: 'tailscale',
        login: 'alice@example.test',
        name: 'Alice',
        profilePicture: null
      },
      deviceId: 'tailscale:100.64.0.10'
    } as const
    const otherDevice = { ...identity, deviceId: 'tailscale:100.64.0.11' }
    const otherAccount = {
      ...identity,
      account: { ...identity.account, login: 'bob@example.test', name: 'Bob' }
    }
    // Tickets are bound to the authenticated ingress, not renderer claims.
    for (const requester of [otherDevice, otherAccount, null]) {
      const ticket = await runEffect(
        value.manager.issueTicket('app_browser', 'client-first', true, identity)
      )
      await expect(
        runEffect(
          value.manager.accept(
            ticket,
            value.transport('wrong-identity').transport,
            requester
          )
        )
      ).rejects.toThrow('INVALID_BROWSER_TICKET')
    }
    const first = value.transport('first')
    const firstTicket = await runEffect(
      value.manager.issueTicket('app_browser', 'client-first', true, identity)
    )
    await runEffect(
      value.manager.accept(firstTicket, first.transport, identity)
    )
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
          value.manager.issueTicket(
            'app_browser',
            'client-second',
            true,
            identity
          )
        ),
        second.transport,
        identity
      )
    )
    expect(second.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: {
        controlled: false,
        hasController: true,
        controllerDetails: {
          kind: 'viewer',
          account: identity.account,
          sameAccount: true,
          sameDevice: true
        }
      }
    })
    expect(first.disconnects).toBe(0)

    const browser = browsers[0]!
    value.manager.message('first', {
      type: 'videoOffer',
      requestId: 'first-offer',
      sdp: 'offer-1'
    })
    value.manager.message('second', {
      type: 'videoOffer',
      requestId: 'second-offer',
      sdp: 'offer-2'
    })
    await vi.waitFor(() =>
      expect(first.messages).toContainEqual({
        type: 'videoAnswer',
        requestId: 'first-offer',
        sdp: 'answer'
      })
    )
    expect(second.messages).toContainEqual({
      type: 'videoAnswer',
      requestId: 'second-offer',
      sdp: 'answer'
    })
    expect(browser.negotiateVideo.mock.calls).toEqual([
      ['first', 'offer-1'],
      ['second', 'offer-2']
    ])

    const lateObserver = value.transport('late-observer')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket(
            'app_browser',
            'client-late',
            true,
            otherDevice
          )
        ),
        lateObserver.transport,
        otherDevice
      )
    )
    expect(lateObserver.messages).toContainEqual({ type: 'videoReady' })
    expect(lateObserver.messages).toContainEqual({
      type: 'ready',
      state: expect.objectContaining({
        controlled: false,
        controllerDetails: {
          kind: 'viewer',
          account: identity.account,
          sameAccount: true,
          sameDevice: false
        }
      })
    })
    const differentAccount = value.transport('different-account')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket(
            'app_browser',
            'client-different-account',
            true,
            otherAccount
          )
        ),
        differentAccount.transport,
        otherAccount
      )
    )
    expect(differentAccount.messages).toContainEqual({
      type: 'ready',
      state: expect.objectContaining({
        controlled: false,
        controllerDetails: {
          kind: 'viewer',
          account: identity.account,
          sameAccount: false,
          sameDevice: true
        }
      })
    })
    expect(first.disconnects).toBe(0)

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

    const clipboard = { text: 'website copy button', html: null, png: null }
    expect(browser.callbacks.clipboard(clipboard)).toBe(false)
    value.manager.message('second', {
      type: 'key',
      phase: 'down',
      key: 'Enter',
      modifiers: 0
    })
    await vi.waitFor(() =>
      expect(browser.commands.at(-1)).toEqual({
        type: 'key',
        phase: 'down',
        key: 'Enter',
        modifiers: 0
      })
    )
    expect(browser.callbacks.clipboard(clipboard)).toBe(true)
    expect(second.messages.at(-1)).toEqual({
      type: 'clipboardWrite',
      clipboard
    })
    expect(
      first.messages.some((message) => message.type === 'clipboardWrite')
    ).toBe(false)
    expect(
      lateObserver.messages.some((message) => message.type === 'clipboardWrite')
    ).toBe(false)
    // One input does not grant ongoing background clipboard access.
    expect(browser.callbacks.clipboard(clipboard)).toBe(false)
    value.manager.message('second', {
      type: 'key',
      phase: 'down',
      key: 'Space',
      modifiers: 0
    })
    await vi.waitFor(() =>
      expect(browser.commands.at(-1)).toEqual({
        type: 'key',
        phase: 'down',
        key: 'Space',
        modifiers: 0
      })
    )

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
    // A grant from the previous controller cannot write after a handoff.
    expect(browser.callbacks.clipboard(clipboard)).toBe(false)

    value.manager.close('first')
    await vi.waitFor(() =>
      expect(second.messages.at(-1)).toMatchObject({
        type: 'controlChanged',
        state: { controlled: true, controller: 'you' }
      })
    )
    expect(lateObserver.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controlled: false, controller: 'other' }
    })

    // A fresh ticket can report a new device address without changing the
    // persistent viewer's control or leaving its previous socket attached.
    const resumed = value.transport('second-resumed')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket(
            'app_browser',
            'client-second',
            true,
            otherDevice
          )
        ),
        resumed.transport,
        otherDevice
      )
    )
    expect(second.disconnects).toBe(1)
    expect(resumed.messages).toContainEqual({
      type: 'ready',
      state: expect.objectContaining({ controlled: true })
    })
    // The old socket's delayed close cannot release the replacement's control.
    value.manager.close('second')
    expect(resumed.messages.at(-1)).toMatchObject({
      state: { controlled: true }
    })

    await value.manager.dispose()
    expect(browser.callbacks.clipboard(clipboard)).toBe(false)
    expect(browser.closes).toBe(1)
    expect(first.disconnects).toBe(0)
    expect(second.disconnects).toBe(1)
  })

  it('serializes concurrent attachments into one browser process', async () => {
    const value = fixture()
    const firstTicket = await runEffect(
      value.manager.issueTicket('app_browser', 'client-first')
    )
    const secondTicket = await runEffect(
      value.manager.issueTicket('app_browser', 'client-second')
    )
    const authorized = await runEffect(
      value.apps.authorizeBrowserApp('app_browser')
    )
    let finishAuthorization!: () => void
    const authorization = new Promise<void>((resolve) => {
      finishAuthorization = resolve
    })
    vi.mocked(value.apps.authorizeBrowserApp).mockImplementation(() =>
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
    const launchValue = fixture(runAgentCli, { appUrl: launchUrl })

    await expect(
      runEffect(
        launchValue.manager.agentCommand('app_browser', {
          command: 'goto',
          args: [agentUrl]
        })
      )
    ).resolves.toBe('navigated')
    expect(browsers[0]!.commands[0]).toEqual({
      type: 'navigate',
      url: launchUrl
    })
    expect(launchValue.apps.updateBrowserAppState).toHaveBeenLastCalledWith(
      'app_browser',
      {
        url: agentUrl,
        title: 'Agent page'
      }
    )
    await launchValue.manager.dispose()

    const storedUrl = 'http://localhost:4173/from-storage'
    const storedValue = fixture(null, { appUrl: storedUrl })
    const client = storedValue.transport('stored-client')
    await runEffect(
      storedValue.manager.accept(
        await runEffect(
          storedValue.manager.issueTicket('app_browser', 'stored-client')
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
          value.manager.issueTicket('app_browser', 'remote-client')
        ),
        remote.transport
      )
    )
    expect(browsers).toHaveLength(1)

    const ownerTicket = await runEffect(
      value.manager.issueOwnerTicket('app_browser', 'desktop-client')
    )
    let automationRequests = 0
    const ownerServer = http.createServer((request, response) => {
      if (request.url === '/private/identity') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            appId: 'app_browser',
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
          endpoint: `http://127.0.0.1:${address.port}/private/`
        },
        ownerTransport
      )
    )
    expect(browsers[0]!.closes).toBe(1)
    expect(ownerMessages[0]).toMatchObject({
      type: 'claimGranted',
      appId: 'app_browser'
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
      value.manager.agentCommand('app_browser', {
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
          controller: 'none',
          retainPaint: true,
          agentActive: true
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
        faviconUrl: null,
        loading: false,
        canGoBack: true,
        canGoForward: false,
        viewport: { width: 900, height: 600 }
      }
    })
    await vi.waitFor(() =>
      expect(value.apps.updateBrowserAppState).toHaveBeenCalledWith(
        'app_browser',
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
      expect(value.apps.openBrowserAppFromApp).toHaveBeenCalledWith(
        'app_browser',
        'https://example.com/popup'
      )
    )

    const observer = value.transport('observer')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket('app_browser', 'observer-client', false)
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
        retainPaint: true,
        agentActive: false
      })
    )
    expect(observer.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: {
        controlled: false,
        controller: 'other',
        agentActive: false
      }
    })
    expect(browsers).toHaveLength(1)
    await expect(value.manager.requestAppClose('app_browser')).resolves.toBe(
      false
    )

    await expect(beforeReadyAgent).resolves.toBe(
      '- button "Local target" [ref=e1]'
    )
    expect(
      [...ownerMessages]
        .reverse()
        .find((message) => message.type === 'runtimeControl')
    ).toMatchObject({
      type: 'runtimeControl',
      controller: 'none',
      retainPaint: true,
      agentActive: false
    })
    await expect(
      runEffect(
        value.manager.agentCommand('app_browser', {
          command: 'snapshot',
          args: []
        })
      )
    ).resolves.toBe('- button "Local target" [ref=e1]')
    expect(ownerMessages.at(-1)).toMatchObject({
      type: 'runtimeControl',
      controller: 'none',
      retainPaint: true,
      agentActive: false
    })
    // Native cancellation releases the queue without closing the local page.
    let rejectReload: (error: Error) => void = () => undefined
    localBrowser.page.reload.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectReload = reject
          queueMicrotask(() =>
            localBrowser.cdp.emit('Treeport.navigationCanceled')
          )
        })
    )
    await expect(
      runEffect(
        value.manager.agentCommand('app_browser', {
          command: 'reload',
          args: []
        })
      )
    ).rejects.toThrow('Navigation canceled by beforeunload')
    rejectReload(new Error('No dialog is showing'))
    const dismiss = vi.fn(async () => {
      throw new Error('No dialog is showing')
    })
    localBrowser.page.emit('dialog', { dismiss })
    await expect(
      runEffect(
        value.manager.agentCommand('app_browser', {
          command: 'snapshot',
          args: []
        })
      )
    ).resolves.toBe('- button "Local target" [ref=e1]')
    expect(dismiss).toHaveBeenCalledOnce()
    expect(localBrowser.page.url()).toBe('https://example.com/local')
    expect(localBrowser.cdp.listenerCount('Treeport.navigationCanceled')).toBe(
      0
    )
    expect(localBrowser.browser.close).not.toHaveBeenCalled()
    expect(automationRequests).toBe(0)
    await vi.waitFor(() =>
      expect(localBrowser.cdp.commands).toContainEqual(
        expect.objectContaining({ method: 'Treeport.startVideo' })
      )
    )
    value.manager.message('remote', {
      type: 'videoOffer',
      requestId: 'local-offer',
      sdp: 'offer'
    })
    await vi.waitFor(() =>
      expect(remote.messages).toContainEqual({
        type: 'videoAnswer',
        requestId: 'local-offer',
        sdp: 'local-answer'
      })
    )
    expect(
      observer.messages.some((message) => message.type === 'videoAnswer')
    ).toBe(false)

    value.manager.message('remote', {
      type: 'resize',
      width: 375,
      height: 812
    })
    value.manager.message('remote', { type: 'takeControl' })
    await vi.waitFor(() =>
      expect(remote.messages.at(-1)).toMatchObject({
        type: 'controlChanged',
        state: { controlled: true, controller: 'you' }
      })
    )
    expect(ownerMessages.at(-1)).toMatchObject({
      type: 'runtimeControl',
      controller: 'other',
      viewport: { width: 375, height: 812 }
    })
    value.manager.message('remote', {
      type: 'resize',
      width: 390,
      height: 700
    })
    await vi.waitFor(() =>
      expect(ownerMessages.at(-1)).toMatchObject({
        type: 'runtimeControl',
        controller: 'other',
        viewport: { width: 390, height: 700 }
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
      expect(localBrowser.mouse.down).toHaveBeenCalledWith({
        button: 'left',
        clickCount: 1
      })
    )

    expect(localBrowser.mouse.move).toHaveBeenCalledWith(20, 25)
    value.manager.message('remote', {
      type: 'wheel',
      x: 40,
      y: 50,
      deltaX: 0,
      deltaY: -40,
      modifiers: 2
    })
    await vi.waitFor(() =>
      expect(localBrowser.cdp.commands).toContainEqual({
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseWheel',
          x: 20,
          y: 25,
          deltaX: 0,
          deltaY: -40,
          modifiers: 2
        }
      })
    )
    value.manager.message('remote', {
      type: 'touch',
      phase: 'start',
      points: [
        { id: 1, x: 100, y: 200 },
        { id: 2, x: 300, y: 200 }
      ]
    })
    await vi.waitFor(() =>
      expect(localBrowser.cdp.commands).toContainEqual({
        method: 'Input.dispatchTouchEvent',
        params: {
          type: 'touchStart',
          touchPoints: [
            { id: 1, x: 50, y: 100 },
            { id: 2, x: 150, y: 100 }
          ]
        }
      })
    )
    value.manager.close('remote')
    await vi.waitFor(() =>
      expect(localBrowser.cdp.commands).toContainEqual({
        method: 'Input.dispatchTouchEvent',
        params: { type: 'touchCancel', touchPoints: [] }
      })
    )
    const reconnectedRemote = value.transport('remote-reconnected')
    await runEffect(
      value.manager.accept(
        await runEffect(
          value.manager.issueTicket('app_browser', 'remote-client', true)
        ),
        reconnectedRemote.transport
      )
    )
    expect(observer.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controlled: true, controller: 'you' }
    })
    expect(reconnectedRemote.messages.at(-1)).toMatchObject({
      type: 'controlChanged',
      state: { controlled: false, controller: 'other' }
    })
    // Reconnecting must not steal control from the viewer that took over.
    value.manager.message('remote-reconnected', { type: 'takeControl' })
    await vi.waitFor(() =>
      expect(reconnectedRemote.messages.at(-1)).toMatchObject({
        type: 'controlChanged',
        state: { controlled: true, controller: 'you' }
      })
    )
    value.manager.ownerMessage('local-owner', {
      type: 'takeControl',
      generation
    })
    await vi.waitFor(() =>
      expect(ownerMessages.at(-1)).toMatchObject({
        type: 'runtimeControl',
        controller: 'none',
        viewport: null,
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
    value.manager.message('remote-reconnected', {
      type: 'videoOffer',
      requestId: 'resumed-offer',
      sdp: 'offer'
    })
    await vi.waitFor(() =>
      expect(reconnectedRemote.messages).toContainEqual({
        type: 'videoAnswer',
        requestId: 'resumed-offer',
        sdp: 'local-answer'
      })
    )

    const resumedTicket = await runEffect(
      value.manager.issueOwnerTicket('app_browser', 'desktop-client')
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
          endpoint: `http://127.0.0.1:${address.port}/private/`
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
        faviconUrl: null,
        loading: false,
        canGoBack: true,
        canGoForward: false,
        viewport: { width: 900, height: 600 }
      }
    })
    await expect(
      runEffect(
        value.manager.agentCommand('app_browser', {
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
    const beforeReplacement = reconnectedRemote.messages.length
    localBrowser.cdp.emit('Treeport.videoError', {
      message: 'stale capture failure'
    })
    expect(reconnectedRemote.messages).toHaveLength(beforeReplacement)
    await vi.waitFor(() =>
      expect(reconnectedRemote.messages).toContainEqual({ type: 'videoReady' })
    )
    value.manager.message('remote-reconnected', {
      type: 'videoOffer',
      requestId: 'replacement',
      sdp: 'offer'
    })
    await vi.waitFor(() =>
      expect(reconnectedRemote.messages).toContainEqual({
        type: 'videoAnswer',
        requestId: 'replacement',
        sdp: 'answer'
      })
    )

    await value.manager.dispose()
    await new Promise<void>((resolve) => ownerServer.close(() => resolve()))
  })

  it.each(['disconnected', 'unresponsive'])(
    'requires force to close a app when its local owner is %s',
    async (failure) => {
      const value = fixture()
      const ticket = await runEffect(
        value.manager.issueOwnerTicket('app_browser', 'desktop-client')
      )
      const ownerServer = http.createServer((_request, response) => {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            appId: 'app_browser',
            challenge: ticket.challenge
          })
        )
      })
      onTestFinished(async () => {
        vi.useRealTimers()
        await value.manager.dispose()
        await new Promise<void>((resolve) => ownerServer.close(() => resolve()))
      })
      await new Promise<void>((resolve) =>
        ownerServer.listen(0, '127.0.0.1', resolve)
      )
      const address = z
        .object({ port: z.number().int().positive() })
        .parse(ownerServer.address())

      let connected = true
      const messages: BrowserOwnerServerMessage[] = []
      await runEffect(
        value.manager.acceptOwner(
          {
            ...ticket,
            endpoint: `http://127.0.0.1:${address.port}/private/`
          },
          {
            id: 'local-owner',
            isConnected: () => connected,
            send: (message) => {
              messages.push(message)
              return connected
            },
            disconnect: () => {
              connected = false
            }
          }
        )
      )
      expect(messages[0]).toMatchObject({ type: 'claimGranted' })
      if (failure === 'disconnected') {
        connected = false
        value.manager.closeOwner('local-owner')
      }

      vi.useFakeTimers()
      const normalClose = value.manager.requestAppClose('app_browser')
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(normalClose).resolves.toBe(false)
      const forcedClose = value.manager.requestAppClose('app_browser', true)
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(forcedClose).resolves.toBe(true)
      await value.manager.closeApp('app_browser', 'Browser closed.')
      expect(messages.at(-1)).toEqual({
        type: 'closed',
        reason: 'Browser closed.'
      })
      expect(connected).toBe(false)
    }
  )

  it('uses a page beforeunload request instead of a generic close confirmation', async () => {
    const value = fixture()
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'client')),
        client.transport
      )
    )
    const browser = browsers[0]!
    browser.closeRequiresConfirmation = true

    await expect(value.manager.requestAppClose('app_browser')).resolves.toBe(
      false
    )
    expect(browser.closeRequests).toEqual([false])
    expect(browser.closes).toBe(0)

    await expect(
      value.manager.requestAppClose('app_browser', true)
    ).resolves.toBe(true)
    expect(browser.closeRequests).toEqual([false, true])
    await expect(value.manager.requestAppClose('app_browser')).resolves.toBe(
      true
    )
    expect(browser.closeRequests).toEqual([false, true])
    await value.manager.closeApp('app_browser', 'Browser closed.')
    expect(browser.closes).toBe(1)
    await value.manager.dispose()
  })

  it('shares concurrent close requests and retries with force after a refusal', async () => {
    const value = fixture()
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'client')),
        client.transport
      )
    )
    const browser = browsers[0]!
    browser.closeRequiresConfirmation = true

    const normal = value.manager.requestAppClose('app_browser')
    const forced = value.manager.requestAppClose('app_browser', true)
    await expect(normal).resolves.toBe(false)
    await expect(forced).resolves.toBe(true)
    expect(browser.closeRequests).toEqual([false, true])

    await expect(value.manager.requestAppClose('app_browser')).resolves.toBe(
      true
    )
    await value.manager.closeApp('app_browser', 'Browser closed.')
    await value.manager.dispose()
  })

  it('accumulates scroll bursts without crossing pointer, resize, key or controller boundaries', async () => {
    const value = fixture()
    const first = value.transport('first')
    const second = value.transport('second')
    for (const client of [first, second]) {
      await runEffect(
        value.manager.accept(
          await runEffect(
            value.manager.issueTicket('app_browser', client.transport.id)
          ),
          client.transport
        )
      )
    }
    const browser = browsers[0]!
    const gate = Effect.runSync(Deferred.make<string>())
    vi.spyOn(browser, 'agentCommand').mockImplementationOnce(() =>
      Effect.runPromise(Deferred.await(gate))
    )
    const agent = runEffect(
      value.manager.agentCommand('app_browser', {
        command: 'snapshot',
        args: []
      })
    )
    await vi.waitFor(() => expect(browser.agentCommand).toHaveBeenCalledOnce())
    browser.commands.length = 0
    value.manager.message('first', { type: 'takeControl' })
    for (let index = 0; index < 1_000; index += 1) {
      value.manager.message('first', { type: 'takeControl' })
      value.manager.message('first', {
        type: 'wheel',
        x: 10,
        y: 20,
        modifiers: 0,
        deltaX: 20,
        deltaY: -30
      })
    }
    value.manager.message('first', {
      type: 'pointer',
      phase: 'move',
      x: 1,
      y: 2
    })
    const boundary: BrowserClientMessage[] = [
      { type: 'pointer', phase: 'move', x: 10, y: 20 },
      { type: 'wheel', x: 10, y: 20, modifiers: 0, deltaX: 0, deltaY: 40 },
      { type: 'pointer', phase: 'down', x: 10, y: 20, button: 'left' },
      { type: 'resize', width: 800, height: 600 },
      { type: 'pointer', phase: 'up', x: 10, y: 20, button: 'left' },
      { type: 'resize', width: 900, height: 700 },
      { type: 'key', phase: 'down', key: 'Shift', modifiers: 8 },
      { type: 'wheel', x: 10, y: 20, modifiers: 0, deltaX: 0, deltaY: 50 },
      { type: 'wheel', x: 10, y: 20, modifiers: 2, deltaX: 0, deltaY: -40 },
      { type: 'wheel', x: 30, y: 20, modifiers: 2, deltaX: 0, deltaY: -40 },
      { type: 'wheel', x: 30, y: 40, modifiers: 2, deltaX: 0, deltaY: -40 },
      { type: 'key', phase: 'up', key: 'Shift', modifiers: 0 },
      { type: 'touch', phase: 'start', points: [{ id: 1, x: 100, y: 100 }] },
      {
        type: 'touch',
        phase: 'start',
        points: [
          { id: 1, x: 100, y: 100 },
          { id: 2, x: 200, y: 100 }
        ]
      },
      {
        type: 'touch',
        phase: 'move',
        points: [
          { id: 1, x: 90, y: 100 },
          { id: 2, x: 210, y: 100 }
        ]
      },
      { type: 'touch', phase: 'end', points: [{ id: 1, x: 90, y: 100 }] },
      { type: 'touch', phase: 'move', points: [{ id: 2, x: 220, y: 100 }] }
    ]
    for (const message of boundary) {
      if (message.type === 'touch' && message.phase === 'move') {
        for (let index = 0; index < 1_000; index += 1) {
          value.manager.message('first', message)
        }
      } else {
        value.manager.message('first', message)
      }
    }
    value.manager.message('second', { type: 'takeControl' })
    value.manager.message('first', {
      type: 'wheel',
      x: 10,
      y: 20,
      modifiers: 0,
      deltaX: 0,
      deltaY: 999
    })
    value.manager.message('first', { type: 'takeControl' })
    value.manager.message('first', {
      type: 'wheel',
      x: 10,
      y: 20,
      modifiers: 0,
      deltaX: 0,
      deltaY: 60
    })
    expect(browser.commands).toEqual([])
    Effect.runSync(Deferred.succeed(gate, 'snapshot'))
    await agent
    await vi.waitFor(() =>
      expect(browser.commands.at(-1)).toEqual({
        type: 'wheel',
        x: 10,
        y: 20,
        modifiers: 0,
        deltaX: 0,
        deltaY: 60
      })
    )
    expect(browser.commands).toEqual([
      {
        type: 'wheel',
        x: 10,
        y: 20,
        modifiers: 0,
        deltaX: 20_000,
        deltaY: -30_000
      },
      ...boundary,
      { type: 'touch', phase: 'cancel', points: [] },
      { type: 'resize', width: 1_280, height: 800 },
      { type: 'resize', width: 900, height: 700 },
      { type: 'wheel', x: 10, y: 20, modifiers: 0, deltaX: 0, deltaY: 60 }
    ])
    expect(first.messages).toContainEqual({
      type: 'navigationError',
      message: 'Take control before you interact with this browser.'
    })
    expect(first.messages).not.toContainEqual({
      type: 'navigationError',
      message: 'The Browser command queue is full. Wait and try again.'
    })
    browser.commands.length = 0
    value.manager.message('first', { type: 'takeControl' })
    value.manager.message('first', {
      type: 'wheel',
      x: 10,
      y: 20,
      modifiers: 0,
      deltaX: 0,
      deltaY: 42
    })
    await vi.waitFor(() =>
      expect(browser.commands).toEqual([
        { type: 'wheel', x: 10, y: 20, modifiers: 0, deltaX: 0, deltaY: 42 }
      ])
    )
    // The native input ACK can take two display ticks. Permit two compatible
    // dispatches, but neither a third nor the following key can pass the bound.
    browser.commands.length = 0
    const completions: Array<() => void> = []
    const dispatch = vi
      .spyOn(browser, 'command')
      .mockImplementation(async (message) => {
        browser.commands.push(message)
        if (message.type === 'wheel') {
          await new Promise<void>((resolve) => completions.push(resolve))
        }
      })
    const wheel = {
      type: 'wheel',
      x: 10,
      y: 20,
      modifiers: 0,
      deltaX: 0,
      deltaY: 6
    } as const
    value.manager.message('first', wheel)
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    value.manager.message('first', wheel)
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    value.manager.message('first', wheel)
    value.manager.message('first', {
      type: 'key',
      phase: 'down',
      key: 'a',
      modifiers: 0
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(dispatch).toHaveBeenCalledTimes(2)
    completions[0]!()
    await vi.waitFor(() => expect(completions).toHaveLength(3))
    expect(browser.commands.every((message) => message.type === 'wheel')).toBe(
      true
    )
    completions[1]!()
    completions[2]!()
    await vi.waitFor(() =>
      expect(browser.commands.at(-1)).toEqual({
        type: 'key',
        phase: 'down',
        key: 'a',
        modifiers: 0
      })
    )
    dispatch.mockRestore()
    await value.manager.dispose()
  })

  it('rejects overload immediately and settles callers on shutdown without overlapping in-flight work', async () => {
    const value = fixture()
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'client')),
        client.transport
      )
    )
    const browser = browsers[0]!
    const gate = Effect.runSync(Deferred.make<string>())
    vi.spyOn(browser, 'agentCommand').mockImplementationOnce(() =>
      Effect.runPromise(Deferred.await(gate))
    )
    const active = runEffect(
      value.manager.agentCommand('app_browser', {
        command: 'snapshot',
        args: []
      })
    ).catch((error: Error) => error.message)
    await vi.waitFor(() => expect(browser.agentCommand).toHaveBeenCalledOnce())
    const pending = Array.from({ length: 60 }, () =>
      runEffect(
        value.manager.agentCommand('app_browser', {
          command: 'snapshot',
          args: []
        })
      ).catch((error: Error) => error.message)
    )
    await expect(pending.at(-1)).resolves.toContain('queue is full')
    value.manager.message('client', {
      type: 'key',
      phase: 'up',
      key: 'Shift',
      modifiers: 0
    })
    value.manager.message('client', {
      type: 'pointer',
      phase: 'up',
      x: 10,
      y: 10,
      button: 'left'
    })
    value.manager.message('client', { type: 'touch', phase: 'end', points: [] })
    value.manager.message('client', {
      type: 'touch',
      phase: 'cancel',
      points: []
    })
    expect(client.messages).not.toContainEqual({
      type: 'navigationError',
      message: 'The Browser command queue is full. Wait and try again.'
    })
    value.manager.message('client', {
      type: 'key',
      phase: 'down',
      key: 'Shift',
      modifiers: 8
    })
    expect(client.messages).toContainEqual({
      type: 'navigationError',
      message: 'The Browser command queue is full. Wait and try again.'
    })
    const closeRequest = value.manager
      .requestAppClose('app_browser')
      .catch((error: Error) => error.message)
    let closed = false
    const closing = value.manager.dispose().then(() => {
      closed = true
    })
    await expect(active).resolves.toContain('shutting down')
    await expect(pending[0]).resolves.toContain('shutting down')
    await expect(closeRequest).resolves.toContain('shutting down')
    expect(closed).toBe(false)
    expect(browser.closes).toBe(0)
    expect(browser.agentCommand).toHaveBeenCalledOnce()
    Effect.runSync(Deferred.succeed(gate, 'late completion'))
    await closing
    await Promise.all(pending)
    expect(browser.closes).toBe(1)
    expect(client.disconnects).toBe(1)
    expect(browser.agentCommand).toHaveBeenCalledOnce()
    await value.manager.dispose()
    expect(browser.closes).toBe(1)
  })

  it('owns initial launch until settlement when shutdown races an attachment', async () => {
    const value = fixture()
    const client = value.transport('client')
    const gate = Effect.runSync(Deferred.make<void>())
    const launch = vi
      .spyOn(FakeBrowser.prototype, 'launch')
      .mockImplementationOnce(() => Effect.runPromise(Deferred.await(gate)))
    onTestFinished(() => {
      launch.mockRestore()
    })
    const attaching = runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'client')),
        client.transport
      )
    )
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
    const closing = value.manager.dispose()
    await attaching
    expect(browsers[0]!.closes).toBe(0)
    Effect.runSync(Deferred.succeed(gate, undefined))
    await closing
    expect(browsers[0]!.closes).toBe(1)
    expect(client.messages.some((message) => message.type === 'ready')).toBe(
      false
    )
  })

  it('settles a direct queue handoff when closing before the consumer resumes', async () => {
    const value = fixture()
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'client')),
        client.transport
      )
    )
    const request = value.manager
      .requestAppClose('app_browser')
      .catch((error: Error) => error.message)
    const close = value.manager.closeApp('app_browser', 'closed immediately')
    await expect(request).resolves.toContain('closed immediately')
    await close
    expect(browsers[0]!.closeRequests).toEqual([])
    expect(browsers[0]!.closes).toBe(1)
    await value.manager.dispose()
  })

  it('releases a partially launched runtime before retrying', async () => {
    const value = fixture()
    vi.spyOn(FakeBrowser.prototype, 'launch').mockRejectedValueOnce(
      new Error('launch failed')
    )
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    const first = value.transport('first')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'first')),
        first.transport
      )
    )
    expect(browsers[0]!.closes).toBe(1)
    const second = value.transport('second')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'second')),
        second.transport
      )
    )
    expect(browsers).toHaveLength(2)
    expect(second.messages).toContainEqual(
      expect.objectContaining({ type: 'ready' })
    )
    await value.manager.dispose()
    expect(browsers[1]!.closes).toBe(1)
  })

  it('keeps human control while it reports agent activity', async () => {
    const runAgentCli = vi
      .fn<BrowserAgentCliRunner>()
      .mockResolvedValue('snapshot')
      .mockResolvedValueOnce('attached')
      .mockResolvedValueOnce('snapshot')
      .mockRejectedValueOnce(new Error('Browser disconnected'))
    const value = fixture(runAgentCli)
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'client')),
        client.transport
      )
    )
    await runEffect(
      value.manager.agentCommand('app_browser', {
        command: 'snapshot',
        args: []
      })
    )
    expect(client.messages).toContainEqual(
      expect.objectContaining({
        type: 'state',
        state: expect.objectContaining({
          controller: 'you',
          controlled: true,
          agentActive: true
        })
      })
    )
    expect(client.messages.at(-1)).toMatchObject({
      type: 'state',
      state: { controller: 'you', controlled: true, agentActive: false }
    })
    await expect(
      runEffect(
        value.manager.agentCommand('app_browser', {
          command: 'snapshot',
          args: []
        })
      )
    ).rejects.toThrow('Browser disconnected')
    expect(client.messages.at(-1)).toMatchObject({
      type: 'state',
      state: { controller: 'you', controlled: true, agentActive: false }
    })
    await value.manager.dispose()
  })

  it('routes browser popups through durable BrowserApp creation', async () => {
    const value = fixture()
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'client')),
        client.transport
      )
    )

    browsers[0]!.callbacks.popup('https://example.com/popup')
    await vi.waitFor(() =>
      expect(value.apps.openBrowserAppFromApp).toHaveBeenCalledWith(
        'app_browser',
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
        await runEffect(value.manager.issueTicket('app_browser', 'client')),
        client.transport
      )
    )
    vi.mocked(value.apps.authorizeBrowserApp).mockReturnValue(
      Effect.fail(new Error('removed'))
    )
    value.events.emit('event', {
      type: 'worktree.removed',
      data: { projectId: 'project', worktreeId: 'worktree' }
    })

    await vi.waitFor(() =>
      expect(client.messages.at(-1)).toEqual({
        type: 'closed',
        reason: 'Worktree removed'
      })
    )
    expect(browsers[0]!.closes).toBe(1)
    await value.manager.dispose()
  })

  it('closes the browser when the durable app is removed', async () => {
    const value = fixture()
    const client = value.transport('client')
    await runEffect(
      value.manager.accept(
        await runEffect(value.manager.issueTicket('app_browser', 'client')),
        client.transport
      )
    )
    value.events.emit('event', {
      type: 'app.removed',
      data: { appId: 'app_browser', worktreeId: 'worktree' }
    })
    await vi.waitFor(() =>
      expect(client.messages.at(-1)).toEqual({
        type: 'closed',
        reason: 'App closed'
      })
    )
    expect(browsers[0]!.closes).toBe(1)
    expect(client.disconnects).toBe(1)
    await value.manager.dispose()
  })
})
