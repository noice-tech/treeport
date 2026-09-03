import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { z } from 'zod'
import type {
  Browser as PlaywrightConnection,
  CDPSession,
  Page
} from 'playwright'
import type {
  BrowserAgentCommand,
  BrowserClientMessage,
  BrowserFrame,
  BrowserOwnerAuth,
  BrowserOwnerClientMessage,
  BrowserOwnerServerMessage,
  BrowserServerMessage,
  BrowserSessionState
} from '@treeport/shared'
import {
  BROWSER_MAX_FRAME_BYTES,
  browserOwnerEndpointSchema,
  browserUrlSchema,
  parseBrowserClientMessage,
  parseBrowserOwnerClientMessage
} from '@treeport/shared'
import type { AppConfig, TreeportService } from './core/index'
import {
  LatestBrowserFrameProducer,
  PlaywrightBrowser,
  PlaywrightBrowserHost,
  type BrowserInstallStatus,
  type PlaywrightBrowserCallbacks
} from './playwright-browser'

export interface BrowserTransport {
  id: string
  isConnected(): boolean
  sendMessage(message: BrowserServerMessage): boolean
  sendFrame(frame: BrowserFrame): boolean
  disconnect(): void
}

export interface BrowserOwnerTransport {
  id: string
  isConnected(): boolean
  send(message: BrowserOwnerServerMessage): boolean
  disconnect(): void
}

export interface BrowserSessionService {
  runEffect: TreeportService['runEffect']
  panels: Pick<
    TreeportService['panels'],
    | 'authorizeBrowserPanel'
    | 'openBrowserPanelFromPanel'
    | 'updateBrowserPanelState'
  >
  events: Pick<TreeportService['events'], 'subscribe'>
}

export type BrowserSessionConfig = Pick<
  AppConfig,
  'cacheDir' | 'dataDir' | 'runtimeDir'
>

export interface BrowserSessionBrowser {
  readonly state: Omit<
    BrowserSessionState,
    'controlled' | 'hasController' | 'controller'
  >
  launch(): Promise<void>
  command(message: BrowserClientMessage): Promise<void>
  agentCommand(input: BrowserAgentCommand): Promise<string>
  setScreencasting(enabled: boolean): Promise<void>
  requestClose(force: boolean): Promise<boolean>
  close(): Promise<void>
}

export type BrowserSessionBrowserFactory = (
  host: PlaywrightBrowserHost,
  workspacePath: string,
  title: string,
  panelId: string,
  worktreeId: string,
  callbacks: PlaywrightBrowserCallbacks
) => BrowserSessionBrowser

interface BrowserAgentTarget {
  panelId: string
  agentDirectory: string
}

export type BrowserAgentCliRunner = (
  target: BrowserAgentTarget,
  args: string[]
) => Promise<string>

export type BrowserLocalAutomationConnector = (
  endpoint: string
) => Promise<PlaywrightConnection>

interface BrowserTicket {
  panelId: string
  clientId: string
  visible: boolean
  expiresAt: number
}

interface BrowserOwnerTicket {
  panelId: string
  clientId: string
  challenge: string
  expiresAt: number
}

interface BrowserOwnerRequest {
  resolve(value: boolean): void
  timer: ReturnType<typeof setTimeout>
}

interface BrowserLocalAutomation {
  browser: PlaywrightConnection
  page: Page
  cdp: CDPSession
  frameProducer: LatestBrowserFrameProducer
  generation: number
  console: string[]
  requests: string[]
  screencasting: boolean
  screencastTail: Promise<void>
}

interface BrowserLocalOwner {
  transport: BrowserOwnerTransport
  clientId: string
  endpoint: string
  challenge: string
  generation: number
  revision: number
  ready: boolean
  controller: 'agent' | 'other' | 'none'
  retainPaint: boolean
  readyPromise: Promise<void>
  resolveReady: (() => void) | null
  requests: Map<string, BrowserOwnerRequest>
}

interface BrowserAttachment {
  id: string
  clientId: string
  transport: BrowserTransport
  visible: boolean
  closing: boolean
  awaitingFrame: number | null
  pendingFrame: BrowserFrame | null
  viewport: { width: number; height: number }
}

interface BrowserScheduledCompletion {
  resolve(): void
  reject(error: Error): void
}

interface BrowserScheduledOperation {
  coalesceKey: string | null
  message: BrowserClientMessage | null
  execute(message: BrowserClientMessage | null): Promise<void>
  completions: BrowserScheduledCompletion[]
  required: boolean
}

type BrowserScheduledInput = Omit<BrowserScheduledOperation, 'completions'>

interface BrowserScheduler {
  queue: BrowserScheduledOperation[]
  coalesced: Map<string, BrowserScheduledOperation>
  running: boolean
  accepting: boolean
}

interface BrowserPanelStatePersistence {
  persistedUrl: string
  persistedTitle: string
  pending: { url: string; title: string } | null
  write: Promise<void> | null
  ready: boolean
}

interface BrowserSession {
  panelId: string
  agentDirectory: string
  title: string
  browser: BrowserSessionBrowser | null
  launch: Promise<BrowserSessionBrowser> | null
  localOwner: BrowserLocalOwner | null
  localAutomation: BrowserLocalAutomation | null
  localAutomationLaunch: Promise<BrowserLocalAutomation> | null
  generation: number
  attachments: Map<string, BrowserAttachment>
  controllerId: string | null
  state: Omit<
    BrowserSessionState,
    'controlled' | 'hasController' | 'controller'
  >
  sequence: number
  latestFrame: BrowserFrame | null
  scheduler: BrowserScheduler
  persistence: BrowserPanelStatePersistence
  agentAttached: boolean
  agentSessionName: string | null
  agentProcess: ChildProcess | null
  crashMessage: string | null
  closing: boolean
  closeOperation: Promise<void> | null
}

const MAX_BROWSER_ATTACHMENTS = 8
const MAX_BROWSER_TICKETS = 256
const LOCAL_BROWSER_OWNER_CONTROLLER = 'local-owner'
const attachmentController = (clientId: string) => `attachment:${clientId}`
const MAX_BROWSER_SCHEDULED_OPERATIONS = 64
const MAX_BROWSER_REGULAR_OPERATIONS = 46
const playwrightPackageSchema = z.object({
  bin: z.object({ playwright: z.string() }).optional()
})

const defaultBrowserFactory: BrowserSessionBrowserFactory = (
  host,
  workspacePath,
  _title,
  _panelId,
  _worktreeId,
  callbacks
) => new PlaywrightBrowser(host, workspacePath, callbacks)

const DEFAULT_STATE: Omit<
  BrowserSessionState,
  'controlled' | 'hasController' | 'controller'
> = {
  url: 'about:blank',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  viewport: { width: 1_280, height: 800 }
}

export class BrowserSessionManager {
  private readonly cachePath: string
  private readonly browserHost: PlaywrightBrowserHost
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly sessionCreations = new Map<string, Promise<BrowserSession>>()
  private readonly tickets = new Map<string, BrowserTicket>()
  private readonly ownerTickets = new Map<string, BrowserOwnerTicket>()
  private readonly unsubscribe: () => void
  private installing: Promise<string> | null = null

  constructor(
    private readonly service: BrowserSessionService,
    private readonly config: BrowserSessionConfig,
    private readonly browserFactory: BrowserSessionBrowserFactory = defaultBrowserFactory,
    private readonly agentCliRunner: BrowserAgentCliRunner | null = null,
    private readonly connectLocalAutomation: BrowserLocalAutomationConnector = async (
      endpoint
    ) => {
      const { chromium } = await import('playwright')
      return chromium.connectOverCDP(endpoint, { timeout: 10_000 })
    }
  ) {
    this.cachePath = path.join(config.cacheDir, 'playwright')
    this.browserHost = new PlaywrightBrowserHost(
      this.cachePath,
      path.join(config.dataDir, 'browser-profile')
    )
    this.unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'panel.removed') {
        void this.closePanel(String(event.data.panelId), 'Panel closed').catch(
          (error) => {
            console.error(
              '[Treeport] Failed to close a removed Browser panel:',
              error instanceof Error ? error.message : String(error)
            )
          }
        )
      } else if (event.type === 'worktree.removed' && event.data.worktreeId) {
        for (const session of this.sessions.values()) {
          void this.service
            .runEffect(
              this.service.panels.authorizeBrowserPanel(session.panelId)
            )
            .catch(() => this.closePanel(session.panelId, 'Worktree removed'))
            .catch((error) => {
              console.error(
                `[Treeport] Failed to close Browser panel ${session.panelId} after its tree was removed:`,
                error instanceof Error ? error.message : String(error)
              )
            })
        }
      }
    })
  }

  async issueTicket(
    panelId: string,
    clientId: string,
    visible = true
  ): Promise<string> {
    await this.service.runEffect(
      this.service.panels.authorizeBrowserPanel(panelId)
    )
    for (const [value, ticket] of this.tickets) {
      if (ticket.expiresAt < Date.now()) {
        this.tickets.delete(value)
      }
    }
    if (this.tickets.size >= MAX_BROWSER_TICKETS) {
      throw new Error('Too many Browser attachment requests are pending.')
    }

    const ticket = crypto.randomBytes(32).toString('base64url')
    this.tickets.set(ticket, {
      panelId,
      clientId,
      visible,
      expiresAt: Date.now() + 30_000
    })
    return ticket
  }

  async issueOwnerTicket(
    panelId: string,
    clientId: string
  ): Promise<{ ticket: string; challenge: string }> {
    await this.service.runEffect(
      this.service.panels.authorizeBrowserPanel(panelId)
    )
    for (const [value, ticket] of this.ownerTickets) {
      if (ticket.expiresAt < Date.now()) {
        this.ownerTickets.delete(value)
      }
    }
    if (this.ownerTickets.size >= MAX_BROWSER_TICKETS) {
      throw new Error('Too many Browser owner requests are pending.')
    }

    const ticket = crypto.randomBytes(32).toString('base64url')
    const currentOwner = this.sessions.get(panelId)?.localOwner
    const challenge =
      currentOwner?.clientId === clientId
        ? currentOwner.challenge
        : crypto.randomBytes(32).toString('base64url')
    this.ownerTickets.set(ticket, {
      panelId,
      clientId,
      challenge,
      expiresAt: Date.now() + 30_000
    })
    return { ticket, challenge }
  }

  private stateFor(
    session: BrowserSession,
    attachment: BrowserAttachment
  ): BrowserSessionState {
    return {
      ...session.state,
      controlled:
        session.controllerId === attachmentController(attachment.clientId),
      hasController:
        session.localOwner !== null || session.controllerId !== null,
      controller:
        session.controllerId === attachmentController(attachment.clientId)
          ? 'you'
          : session.controllerId === 'agent'
            ? 'agent'
            : session.localOwner || session.controllerId
              ? 'other'
              : 'none'
    }
  }

  private broadcastState(
    session: BrowserSession,
    type: 'state' | 'controlChanged' = 'state'
  ): void {
    for (const attachment of session.attachments.values()) {
      attachment.transport.sendMessage({
        type,
        state: this.stateFor(session, attachment)
      })
    }
  }

  private enqueueOperation(
    session: BrowserSession,
    operation: BrowserScheduledOperation,
    allowWhenClosing = false
  ): boolean {
    const scheduler = session.scheduler
    if (!scheduler.accepting && !allowWhenClosing) {
      return false
    }

    if (operation.coalesceKey) {
      const existing = scheduler.coalesced.get(operation.coalesceKey)
      if (existing) {
        if (
          existing.message?.type === 'wheel' &&
          operation.message?.type === 'wheel'
        ) {
          existing.message = {
            type: 'wheel',
            deltaX: Math.max(
              -10_000,
              Math.min(
                10_000,
                existing.message.deltaX + operation.message.deltaX
              )
            ),
            deltaY: Math.max(
              -10_000,
              Math.min(
                10_000,
                existing.message.deltaY + operation.message.deltaY
              )
            )
          }
        } else {
          existing.message = operation.message
        }

        existing.execute = operation.execute
        existing.completions.push(...operation.completions)
        existing.required ||= operation.required
        return true
      }
    }

    if (
      scheduler.queue.length >= MAX_BROWSER_SCHEDULED_OPERATIONS ||
      (!operation.required &&
        scheduler.queue.length >= MAX_BROWSER_REGULAR_OPERATIONS)
    ) {
      return false
    }

    scheduler.queue.push(operation)

    if (operation.coalesceKey) {
      scheduler.coalesced.set(operation.coalesceKey, operation)
    }

    this.runScheduler(session)
    return true
  }

  private scheduleOperation(
    session: BrowserSession,
    execute: () => Promise<void>,
    options: {
      coalesceKey?: string
      required?: boolean
      allowWhenClosing?: boolean
    } = {}
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const accepted = this.enqueueOperation(
        session,
        {
          coalesceKey: options.coalesceKey ?? null,
          message: null,
          execute: () => execute(),
          completions: [{ resolve, reject }],
          required: options.required ?? false
        },
        options.allowWhenClosing
      )
      if (!accepted) {
        reject(
          new Error(
            session.scheduler.accepting
              ? 'The Browser command queue is full.'
              : 'The Browser session is closing.'
          )
        )
      }
    })
  }

  private queueClientOperation(
    session: BrowserSession,
    attachment: BrowserAttachment,
    operation: BrowserScheduledInput
  ): void {
    if (!this.enqueueOperation(session, { ...operation, completions: [] })) {
      attachment.transport.sendMessage({
        type: 'navigationError',
        message: session.scheduler.accepting
          ? 'The Browser command queue is full. Wait and try again.'
          : 'The Browser session is closing.'
      })
    }
  }

  private runScheduler(session: BrowserSession): void {
    const scheduler = session.scheduler
    if (scheduler.running) {
      return
    }

    scheduler.running = true
    void (async () => {
      while (scheduler.queue.length > 0) {
        const operation = scheduler.queue.shift()!
        if (operation.coalesceKey) {
          scheduler.coalesced.delete(operation.coalesceKey)
        }

        try {
          await operation.execute(operation.message)
          for (const completion of operation.completions) {
            completion.resolve()
          }
        } catch (cause) {
          const error =
            cause instanceof Error ? cause : new Error(String(cause))
          for (const completion of operation.completions) {
            completion.reject(error)
          }
        }
      }
      scheduler.running = false
    })()
  }

  private stopScheduler(session: BrowserSession, reason: string): void {
    session.scheduler.accepting = false
    const error = new Error(reason)
    for (const operation of session.scheduler.queue.splice(0)) {
      for (const completion of operation.completions) {
        completion.reject(error)
      }
    }
    session.scheduler.coalesced.clear()
  }

  private broadcastNavigationError(
    session: BrowserSession,
    message: string
  ): void {
    for (const attachment of session.attachments.values()) {
      attachment.transport.sendMessage({ type: 'navigationError', message })
    }
  }

  private async openPopup(session: BrowserSession, url: string): Promise<void> {
    await this.service
      .runEffect(
        this.service.panels.openBrowserPanelFromPanel(session.panelId, url)
      )
      .catch((cause) =>
        this.broadcastNavigationError(
          session,
          `Could not open the popup: ${cause instanceof Error ? cause.message : String(cause)}`
        )
      )
  }

  private queuePanelState(
    session: BrowserSession,
    value: Pick<BrowserSessionState, 'url' | 'title'>
  ): void {
    if (session.closing || !session.persistence.ready) {
      return
    }

    const parsed =
      value.url === 'about:blank'
        ? { success: true as const, data: 'about:blank' }
        : browserUrlSchema.safeParse(value.url)
    if (!parsed.success) {
      return
    }

    const url =
      parsed.data === 'about:blank' ? parsed.data : new URL(parsed.data).href
    const requestedTitle = value.title.trim().slice(0, 256)
    const title =
      requestedTitle ||
      (url === 'about:blank' ? 'Browser' : new URL(url).host || 'Browser')
    const persistence = session.persistence
    if (
      (persistence.pending?.url === url &&
        persistence.pending.title === title) ||
      (persistence.persistedUrl === url && persistence.persistedTitle === title)
    ) {
      return
    }

    persistence.pending = { url, title }
    if (persistence.write) {
      return
    }

    const write = (async () => {
      while (persistence.pending !== null) {
        const pending = persistence.pending
        persistence.pending = null
        try {
          const panel = await this.service.runEffect(
            this.service.panels.updateBrowserPanelState(
              session.panelId,
              pending
            )
          )
          persistence.persistedUrl = panel.url
          persistence.persistedTitle = panel.title
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          for (const attachment of session.attachments.values()) {
            attachment.transport.sendMessage({
              type: 'navigationError',
              message: `Could not save the Browser address and title: ${message}`
            })
          }
          return
        }
      }
    })()
    persistence.write = write
    void write.finally(() => {
      if (persistence.write !== write) {
        return
      }

      persistence.write = null
      const pending = persistence.pending
      persistence.pending = null
      if (pending !== null && !session.closing) {
        this.queuePanelState(session, pending)
      }
    })
  }

  private async waitForPanelState(session: BrowserSession): Promise<void> {
    while (session.persistence.write) {
      await session.persistence.write
    }
  }

  private async createSession(panelId: string): Promise<BrowserSession> {
    const authorized = await this.service.runEffect(
      this.service.panels.authorizeBrowserPanel(panelId)
    )
    const restoredUrl =
      authorized.panel.url === 'about:blank'
        ? null
        : browserUrlSchema.parse(authorized.panel.url)
    const agentDirectory = path.join(
      this.config.runtimeDir,
      'browsers',
      panelId
    )
    await fs.rm(agentDirectory, { recursive: true, force: true })
    await fs.mkdir(agentDirectory, { recursive: true, mode: 0o700 })
    await fs.chmod(agentDirectory, 0o700)
    const session: BrowserSession = {
      panelId,
      agentDirectory,
      title: `Treeport ${authorized.panel.title}`,
      browser: null,
      launch: null,
      localOwner: null,
      localAutomation: null,
      localAutomationLaunch: null,
      generation: 0,
      attachments: new Map(),
      controllerId: null,
      state: {
        ...DEFAULT_STATE,
        url: restoredUrl ?? DEFAULT_STATE.url,
        title:
          authorized.panel.title === 'Browser' ? '' : authorized.panel.title,
        viewport: { ...DEFAULT_STATE.viewport }
      },
      sequence: 0,
      latestFrame: null,
      scheduler: {
        queue: [],
        coalesced: new Map(),
        running: false,
        accepting: true
      },
      persistence: {
        persistedUrl: authorized.panel.url,
        persistedTitle: authorized.panel.title,
        pending: null,
        write: null,
        ready: true
      },
      agentAttached: false,
      agentSessionName: null,
      agentProcess: null,
      crashMessage: null,
      closing: false,
      closeOperation: null
    }
    this.sessions.set(panelId, session)
    return session
  }

  private async ensurePlaywrightRuntime(
    session: BrowserSession
  ): Promise<BrowserSessionBrowser> {
    if (session.localOwner) {
      throw new Error('This Browser is open in a local Treeport desktop app.')
    }

    if (session.launch) {
      return session.launch
    }

    const runtimeGeneration = ++session.generation
    const restoredUrl = session.state.url
    const restoredTitle = session.state.title
    const launch = (async () => {
      await fs.rm(session.agentDirectory, { recursive: true, force: true })
      await fs.mkdir(session.agentDirectory, { recursive: true, mode: 0o700 })
      await fs.chmod(session.agentDirectory, 0o700)
      let runtimeReady = false
      const browser = this.browserFactory(
        this.browserHost,
        session.agentDirectory,
        session.title,
        session.panelId,
        (
          await this.service.runEffect(
            this.service.panels.authorizeBrowserPanel(session.panelId)
          )
        ).panel.worktreeId,
        {
          state: (state) => {
            if (
              !runtimeReady ||
              session.browser !== browser ||
              session.generation !== runtimeGeneration ||
              session.localOwner
            ) {
              return
            }

            session.state = state
            this.queuePanelState(session, state)
            this.broadcastState(session)
          },
          frame: (frame) => {
            if (
              runtimeReady &&
              session.browser === browser &&
              session.generation === runtimeGeneration &&
              !session.localOwner
            ) {
              this.publishFrame(session, frame)
            }
          },
          popup: (url) => {
            if (
              !runtimeReady ||
              session.browser !== browser ||
              session.generation !== runtimeGeneration ||
              session.localOwner
            ) {
              return
            }

            void this.openPopup(session, url)
          },
          navigationError: (message) =>
            this.broadcastNavigationError(session, message),
          crashed: (message) => {
            if (
              !runtimeReady ||
              session.browser !== browser ||
              session.generation !== runtimeGeneration ||
              session.localOwner
            ) {
              return
            }

            session.crashMessage = message
            for (const attachment of session.attachments.values()) {
              attachment.transport.sendMessage({
                type: 'browserCrashed',
                message
              })
            }
          }
        }
      )
      session.browser = browser
      await browser.launch()
      if (
        session.browser !== browser ||
        session.generation !== runtimeGeneration ||
        session.localOwner
      ) {
        await browser.close()
        throw new Error('The Browser runtime changed during launch.')
      }

      session.state = browser.state
      if (restoredUrl !== 'about:blank') {
        const restored = await browser
          .command({ type: 'navigate', url: restoredUrl })
          .then(
            () => true,
            () => false
          )
        session.state = restored
          ? browser.state
          : {
              ...browser.state,
              url: restoredUrl,
              title: restoredTitle
            }
      }

      runtimeReady = true
      session.state = browser.state
      this.queuePanelState(session, session.state)
      this.broadcastState(session)
      return browser
    })()
    session.launch = launch
    void launch.catch(() => {
      if (session.launch === launch) {
        session.launch = null
        session.browser = null
      }
    })
    return launch
  }

  private browserFor(session: BrowserSession): Promise<BrowserSessionBrowser> {
    return this.ensurePlaywrightRuntime(session)
  }

  private async getSession(panelId: string): Promise<BrowserSession> {
    const existing = this.sessions.get(panelId)
    if (existing) {
      await this.service.runEffect(
        this.service.panels.authorizeBrowserPanel(panelId)
      )
      return existing
    }

    const pending = this.sessionCreations.get(panelId)
    if (pending) {
      return pending
    }

    const creation = this.createSession(panelId).finally(() => {
      if (this.sessionCreations.get(panelId) === creation) {
        this.sessionCreations.delete(panelId)
      }
    })
    this.sessionCreations.set(panelId, creation)
    return creation
  }

  async accept(
    ticketValue: string,
    transport: BrowserTransport
  ): Promise<string> {
    const ticket = this.tickets.get(ticketValue)
    this.tickets.delete(ticketValue)
    if (!ticket || ticket.expiresAt < Date.now()) {
      throw new Error('INVALID_BROWSER_TICKET')
    }

    const session = await this.getSession(ticket.panelId)
    const supersededAttachments = [...session.attachments.values()].filter(
      (candidate) => candidate.clientId === ticket.clientId
    )
    if (
      session.attachments.size - supersededAttachments.length >=
      MAX_BROWSER_ATTACHMENTS
    ) {
      transport.sendMessage({
        type: 'browserUnavailable',
        message:
          'This Browser already has the maximum of eight attached clients.',
        installCommand: null
      })
      return transport.id
    }

    const attachment: BrowserAttachment = {
      id: transport.id,
      clientId: ticket.clientId,
      transport,
      visible: ticket.visible,
      closing: false,
      awaitingFrame: null,
      pendingFrame: null,
      viewport: { ...session.state.viewport }
    }
    session.attachments.set(attachment.id, attachment)

    try {
      if (!session.localOwner) {
        await this.browserFor(session)
      }

      if (!transport.isConnected()) {
        this.close(attachment.id)
        return attachment.id
      }

      await this.scheduleOperation(
        session,
        async () => {
          if (attachment.closing) {
            return
          }

          for (const superseded of supersededAttachments) {
            if (session.attachments.get(superseded.id) !== superseded) {
              continue
            }

            superseded.closing = true
            session.attachments.delete(superseded.id)
            superseded.transport.disconnect()
          }

          if (attachment.visible && session.controllerId === null) {
            session.controllerId = attachmentController(attachment.clientId)
          }

          await this.updateScreencast(session)
        },
        { required: true }
      )
      transport.sendMessage({
        type: 'ready',
        state: this.stateFor(session, attachment)
      })
      this.broadcastState(session, 'controlChanged')
      if (session.crashMessage) {
        transport.sendMessage({
          type: 'browserCrashed',
          message: session.crashMessage
        })
      }

      this.sendLatestFrame(session, attachment)
    } catch (error) {
      attachment.closing = true
      session.attachments.delete(attachment.id)
      if (
        session.controllerId === attachmentController(attachment.clientId) &&
        ![...session.attachments.values()].some(
          (candidate) => candidate.clientId === attachment.clientId
        )
      ) {
        session.controllerId = session.localOwner
          ? LOCAL_BROWSER_OWNER_CONTROLLER
          : null
      }

      transport.sendMessage({
        type: 'browserUnavailable',
        message: error instanceof Error ? error.message : String(error),
        installCommand: session.localOwner ? null : 'treeport browser install'
      })
      if (!session.localOwner) {
        await this.closePlaywrightRuntime(session).catch(() => undefined)
      }
    }
    return attachment.id
  }

  async acceptOwner(
    auth: BrowserOwnerAuth,
    transport: BrowserOwnerTransport
  ): Promise<string> {
    const ticket = this.ownerTickets.get(auth.ticket)
    this.ownerTickets.delete(auth.ticket)
    if (
      !ticket ||
      ticket.expiresAt < Date.now() ||
      ticket.challenge !== auth.challenge ||
      !browserOwnerEndpointSchema.safeParse(auth.endpoint).success
    ) {
      throw new Error('INVALID_BROWSER_OWNER_TICKET')
    }

    const identityResponse = await fetch(new URL('identity', auth.endpoint), {
      signal: AbortSignal.timeout(3_000),
      redirect: 'error'
    })
    const identity = z
      .strictObject({
        panelId: z.string().min(1).max(128),
        challenge: z.string().min(32).max(256)
      })
      .parse(await identityResponse.json())
    if (
      !identityResponse.ok ||
      identity.panelId !== ticket.panelId ||
      identity.challenge !== ticket.challenge
    ) {
      throw new Error('INVALID_BROWSER_OWNER_IDENTITY')
    }

    const session = await this.getSession(ticket.panelId)
    await this.scheduleOperation(
      session,
      async () => {
        const previousOwner = session.localOwner
        if (previousOwner?.transport.isConnected()) {
          transport.send({
            type: 'claimRejected',
            message: 'This Browser is open in another local desktop app.'
          })
          transport.disconnect()
          return
        }

        let resolveReady: (() => void) | null = null
        const readyPromise = new Promise<void>((resolve) => {
          resolveReady = resolve
        })
        const resumed = previousOwner?.clientId === ticket.clientId
        let owner: BrowserLocalOwner
        if (previousOwner) {
          previousOwner.resolveReady?.()
          for (const request of previousOwner.requests.values()) {
            clearTimeout(request.timer)
            request.resolve(false)
          }
          previousOwner.requests.clear()

          if (previousOwner.endpoint !== auth.endpoint) {
            await this.closeLocalAutomation(session)
            session.latestFrame = null
            session.sequence = 0
          }

          previousOwner.transport = transport
          previousOwner.clientId = ticket.clientId
          previousOwner.endpoint = auth.endpoint
          previousOwner.challenge = auth.challenge
          previousOwner.generation = resumed
            ? previousOwner.generation
            : ++session.generation
          previousOwner.revision = -1
          previousOwner.ready = false
          previousOwner.controller = 'none'
          previousOwner.retainPaint = false
          previousOwner.readyPromise = readyPromise
          previousOwner.resolveReady = resolveReady
          owner = previousOwner
        } else {
          await this.closePlaywrightRuntime(session)
          owner = {
            transport,
            clientId: ticket.clientId,
            endpoint: auth.endpoint,
            challenge: auth.challenge,
            generation: ++session.generation,
            revision: -1,
            ready: false,
            controller: 'none',
            retainPaint: false,
            readyPromise,
            resolveReady,
            requests: new Map()
          }
          session.localOwner = owner
          session.controllerId = LOCAL_BROWSER_OWNER_CONTROLLER
          session.latestFrame = null
          session.sequence = 0
        }

        if (!transport.isConnected()) {
          return
        }

        session.controllerId ??= LOCAL_BROWSER_OWNER_CONTROLLER
        transport.send({
          type: 'claimGranted',
          panelId: session.panelId,
          generation: owner.generation,
          resumed,
          state: session.state
        })
        if (!previousOwner) {
          this.broadcastState(session, 'controlChanged')
        }
      },
      { required: true }
    )
    return transport.id
  }

  ownerMessage(connectionId: string, value: BrowserOwnerClientMessage): void {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.localOwner?.transport.id === connectionId
    )
    const message = parseBrowserOwnerClientMessage(value)
    const owner = session?.localOwner
    if (!session || !owner || !message) {
      owner?.transport.disconnect()
      return
    }

    if (message.generation !== owner.generation) {
      return
    }

    if (message.type === 'ready' || message.type === 'state') {
      if (message.revision <= owner.revision) {
        return
      }

      owner.revision = message.revision
      session.state = message.state
      this.queuePanelState(session, message.state)
      this.broadcastState(session)

      if (message.type === 'ready' && !owner.ready) {
        owner.ready = true
        owner.resolveReady?.()
        owner.resolveReady = null
        void this.scheduleOperation(
          session,
          () => this.updateScreencast(session),
          { required: true }
        ).catch((cause) =>
          this.broadcastNavigationError(
            session,
            cause instanceof Error ? cause.message : String(cause)
          )
        )
      }

      return
    }

    if (message.type === 'takeControl') {
      void this.scheduleOperation(
        session,
        async () => {
          if (session.localOwner !== owner) {
            return
          }

          await this.updateScreencast(session, LOCAL_BROWSER_OWNER_CONTROLLER)
          if (session.localOwner !== owner) {
            throw new Error('The local Browser owner changed.')
          }

          session.controllerId = LOCAL_BROWSER_OWNER_CONTROLLER
          this.broadcastState(session, 'controlChanged')
        },
        { required: true }
      ).catch(() => undefined)
      return
    }

    if (message.type === 'released') {
      void this.scheduleOperation(
        session,
        () => this.releaseLocalOwner(session, owner),
        { required: true }
      ).catch((cause) =>
        this.broadcastNavigationError(
          session,
          cause instanceof Error ? cause.message : String(cause)
        )
      )
      return
    }

    if (message.type === 'popup') {
      void this.openPopup(session, message.url)
      return
    }

    if (message.type === 'crashed') {
      session.crashMessage = message.message
      for (const attachment of session.attachments.values()) {
        attachment.transport.sendMessage({
          type: 'browserCrashed',
          message: message.message
        })
      }
      return
    }

    const request = owner.requests.get(message.requestId)
    if (!request) {
      return
    }

    owner.requests.delete(message.requestId)
    clearTimeout(request.timer)
    request.resolve(
      message.type === 'runtimeControlResult'
        ? message.accepted
        : message.canClose
    )
  }

  closeOwner(connectionId: string): void {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.localOwner?.transport.id === connectionId
    )
    const owner = session?.localOwner
    if (!session || !owner) {
      return
    }

    owner.ready = false
    owner.resolveReady?.()
    owner.resolveReady = null
    for (const request of owner.requests.values()) {
      clearTimeout(request.timer)
      request.resolve(false)
    }
    owner.requests.clear()
  }

  private async releaseLocalOwner(
    session: BrowserSession,
    owner: BrowserLocalOwner
  ): Promise<void> {
    if (session.localOwner !== owner) {
      return
    }

    session.localOwner = null
    owner.ready = false
    owner.resolveReady?.()
    owner.resolveReady = null
    for (const request of owner.requests.values()) {
      clearTimeout(request.timer)
      request.resolve(false)
    }
    owner.requests.clear()
    await this.closeLocalAutomation(session)
    session.generation += 1
    session.latestFrame = null
    session.sequence = 0
    if (
      session.controllerId === LOCAL_BROWSER_OWNER_CONTROLLER ||
      session.controllerId === 'agent'
    ) {
      const attachment = [...session.attachments.values()].find(
        (candidate) =>
          !candidate.closing &&
          candidate.visible &&
          candidate.transport.isConnected()
      )
      session.controllerId = attachment
        ? attachmentController(attachment.clientId)
        : null
    }

    session.agentProcess?.kill('SIGTERM')
    session.agentProcess = null
    await this.detachAgent(session)
    this.broadcastState(session, 'controlChanged')
    if (
      ![...session.attachments.values()].some(
        (attachment) =>
          !attachment.closing &&
          attachment.visible &&
          attachment.transport.isConnected()
      )
    ) {
      return
    }

    const runtimeError = await this.browserFor(session)
      .then(() => this.updateScreencast(session))
      .then(
        () => null,
        (cause: unknown) => cause
      )
    if (runtimeError !== null) {
      for (const attachment of session.attachments.values()) {
        attachment.transport.sendMessage({
          type: 'browserUnavailable',
          message:
            runtimeError instanceof Error
              ? runtimeError.message
              : String(runtimeError),
          installCommand: 'treeport browser install'
        })
      }
      await this.closePlaywrightRuntime(session).catch(() => undefined)
    }
  }

  private requestLocalOwner(
    owner: BrowserLocalOwner,
    message:
      | {
          type: 'runtimeControl'
          controller: 'agent' | 'other' | 'none'
          retainPaint: boolean
        }
      | { type: 'closeRequest'; force: boolean }
  ): Promise<boolean> {
    if (!owner.transport.isConnected()) {
      return Promise.resolve(false)
    }

    const requestId = crypto.randomUUID()
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        owner.requests.delete(requestId)
        resolve(false)
      }, 5_000)
      timer.unref()
      owner.requests.set(requestId, { resolve, timer })
      if (
        !owner.transport.send({
          ...message,
          generation: owner.generation,
          requestId
        })
      ) {
        clearTimeout(timer)
        owner.requests.delete(requestId)
        resolve(false)
      }
    })
  }

  private async setLocalOwnerRuntimeControl(
    session: BrowserSession,
    owner: BrowserLocalOwner,
    controller: 'agent' | 'other' | 'none',
    retainPaint: boolean
  ): Promise<void> {
    if (owner.controller === controller && owner.retainPaint === retainPaint) {
      return
    }

    const accepted = await this.requestLocalOwner(owner, {
      type: 'runtimeControl',
      controller,
      retainPaint
    })
    if (
      !accepted ||
      session.localOwner !== owner ||
      session.generation !== owner.generation
    ) {
      throw new Error('The local Browser owner did not accept control.')
    }

    owner.controller = controller
    owner.retainPaint = retainPaint
  }

  private sendLatestFrame(
    session: BrowserSession,
    attachment: BrowserAttachment
  ): void {
    const frame = session.latestFrame
    if (
      !frame ||
      !attachment.visible ||
      attachment.awaitingFrame !== null ||
      !attachment.transport.isConnected()
    ) {
      return
    }

    if (attachment.transport.sendFrame(frame)) {
      attachment.awaitingFrame = frame.sequence
    }
  }

  private publishFrame(
    session: BrowserSession,
    value: Omit<BrowserFrame, 'sequence'>
  ): void {
    if (value.data.byteLength > BROWSER_MAX_FRAME_BYTES) {
      return
    }

    const frame: BrowserFrame = {
      ...value,
      sequence: ++session.sequence
    }
    session.latestFrame = frame
    for (const attachment of session.attachments.values()) {
      if (!attachment.visible || !attachment.transport.isConnected()) {
        continue
      }

      if (attachment.awaitingFrame !== null) {
        attachment.pendingFrame = frame
        continue
      }

      if (attachment.transport.sendFrame(frame)) {
        attachment.awaitingFrame = frame.sequence
      }
    }
  }

  message(connectionId: string, value: BrowserClientMessage): void {
    const entry = [...this.sessions.values()]
      .map((session) => ({
        session,
        attachment: session.attachments.get(connectionId)
      }))
      .find(
        (
          candidate
        ): candidate is {
          session: BrowserSession
          attachment: BrowserAttachment
        } => candidate.attachment !== undefined
      )
    if (!entry) {
      return
    }

    const message = parseBrowserClientMessage(value)
    if (!message) {
      entry.attachment.transport.disconnect()
      return
    }

    const { session, attachment } = entry
    if (attachment.closing) {
      return
    }

    if (message.type === 'frameAck') {
      if (attachment.awaitingFrame !== message.sequence) {
        return
      }

      attachment.awaitingFrame = null
      const pending = attachment.pendingFrame
      attachment.pendingFrame = null
      if (pending && attachment.transport.sendFrame(pending)) {
        attachment.awaitingFrame = pending.sequence
      }

      return
    }

    if (message.type === 'setVisible') {
      attachment.visible = message.visible
      if (message.visible) {
        this.sendLatestFrame(session, attachment)
      } else {
        attachment.awaitingFrame = null
        attachment.pendingFrame = null
      }

      this.queueClientOperation(session, attachment, {
        coalesceKey: `screencast:${session.panelId}`,
        message: null,
        execute: async () => {
          const previousController = session.controllerId
          let nextController = previousController
          if (attachment.visible && previousController === null) {
            nextController = attachmentController(attachment.clientId)
          } else if (
            !attachment.visible &&
            previousController === attachmentController(attachment.clientId)
          ) {
            const nextAttachment = [...session.attachments.values()].find(
              (candidate) =>
                candidate.id !== attachment.id &&
                !candidate.closing &&
                candidate.visible
            )
            nextController = nextAttachment
              ? attachmentController(nextAttachment.clientId)
              : session.localOwner
                ? LOCAL_BROWSER_OWNER_CONTROLLER
                : null
          }

          await this.updateScreencast(session, nextController)
          session.controllerId = nextController
          if (nextController !== previousController) {
            this.broadcastState(session, 'controlChanged')
          }
        },
        required: true
      })
      return
    }

    if (message.type === 'resize') {
      attachment.viewport = { width: message.width, height: message.height }
      if (session.localOwner) {
        return
      }

      this.queueClientOperation(session, attachment, {
        coalesceKey: `resize:${attachment.id}`,
        message,
        execute: async (queuedMessage) => {
          if (
            queuedMessage?.type !== 'resize' ||
            attachment.closing ||
            session.attachments.get(attachment.id) !== attachment ||
            session.controllerId !== attachmentController(attachment.clientId)
          ) {
            return
          }

          try {
            const browser = await this.browserFor(session)
            await browser.command(queuedMessage)
          } catch (cause) {
            attachment.transport.sendMessage({
              type: 'navigationError',
              message: cause instanceof Error ? cause.message : String(cause)
            })
          }
        },
        required: false
      })
      return
    }

    if (message.type === 'takeControl') {
      this.queueClientOperation(session, attachment, {
        coalesceKey: null,
        message: null,
        execute: async () => {
          if (
            attachment.closing ||
            session.attachments.get(attachment.id) !== attachment
          ) {
            return
          }

          const previousController = session.controllerId
          const nextController = attachmentController(attachment.clientId)
          try {
            if (session.localOwner) {
              await this.updateScreencast(session, nextController)
            } else {
              const browser = await this.browserFor(session)
              await browser.command({ type: 'resize', ...attachment.viewport })
            }

            session.controllerId = nextController
            if (previousController !== nextController) {
              this.broadcastState(session, 'controlChanged')
            }
          } catch (cause) {
            attachment.transport.sendMessage({
              type: 'navigationError',
              message: cause instanceof Error ? cause.message : String(cause)
            })
          }
        },
        required: false
      })
      return
    }

    const coalesceKey =
      message.type === 'find' && !message.findNext
        ? `find:${attachment.id}`
        : message.type === 'pointer' && message.phase === 'move'
          ? `pointer-move:${attachment.id}`
          : message.type === 'wheel'
            ? `wheel:${attachment.id}`
            : null
    this.queueClientOperation(session, attachment, {
      coalesceKey,
      message,
      execute: async (queuedMessage) => {
        if (
          !queuedMessage ||
          attachment.closing ||
          session.attachments.get(attachment.id) !== attachment
        ) {
          return
        }

        if (
          session.controllerId !== attachmentController(attachment.clientId)
        ) {
          attachment.transport.sendMessage({
            type: 'navigationError',
            message: 'Take control before you interact with this browser.'
          })
          return
        }

        try {
          const localOwner = session.localOwner
          if (localOwner) {
            await this.executeLocalClientCommand(
              session,
              localOwner,
              queuedMessage
            )
          } else {
            const browser = await this.browserFor(session)
            await browser.command(queuedMessage)
            this.queuePanelState(session, browser.state)
            await this.waitForPanelState(session)
          }
        } catch (cause) {
          attachment.transport.sendMessage({
            type: 'navigationError',
            message: cause instanceof Error ? cause.message : String(cause)
          })
        }
      },
      required: false
    })
  }

  private async updateScreencast(
    session: BrowserSession,
    controllerId = session.controllerId
  ): Promise<void> {
    const visible = [...session.attachments.values()].some(
      (attachment) =>
        !attachment.closing &&
        attachment.visible &&
        attachment.transport.isConnected()
    )
    const localOwner = session.localOwner
    if (localOwner) {
      const controller =
        controllerId === 'agent'
          ? 'agent'
          : controllerId && controllerId !== LOCAL_BROWSER_OWNER_CONTROLLER
            ? 'other'
            : 'none'
      const retainPaint = visible || controller === 'agent'
      if (visible) {
        await this.setLocalOwnerRuntimeControl(
          session,
          localOwner,
          controller,
          retainPaint
        )
        await this.setLocalScreencasting(session, localOwner, true)
      } else {
        await this.setLocalScreencasting(session, localOwner, false)
        await this.setLocalOwnerRuntimeControl(
          session,
          localOwner,
          controller,
          retainPaint
        )
      }

      return
    }

    if (!session.launch) {
      return
    }

    const browser = await session.launch.catch(() => null)
    await browser?.setScreencasting(visible).catch(() => undefined)
  }

  private async detachAgent(session: BrowserSession): Promise<void> {
    const name = session.agentSessionName
    if (!session.agentAttached || !name) {
      return
    }

    session.agentAttached = false
    session.agentSessionName = null
    await this.executeAgentCli(session, [`-s=${name}`, 'detach']).catch(
      () => undefined
    )
  }

  private async closePlaywrightRuntime(session: BrowserSession): Promise<void> {
    await this.waitForPanelState(session)
    await this.detachAgent(session)
    const launch = session.launch
    const browser = await launch?.catch(() => session.browser)
    await browser?.close()
    if (session.launch === launch) {
      session.launch = null
      session.browser = null
    }

    session.latestFrame = null
    session.sequence = 0
    await fs.rm(session.agentDirectory, { recursive: true, force: true })
    await fs.mkdir(session.agentDirectory, { recursive: true, mode: 0o700 })
    await fs.chmod(session.agentDirectory, 0o700)
  }

  private async destroySession(
    session: BrowserSession,
    reason: string
  ): Promise<void> {
    await this.waitForPanelState(session)
    if (session.localOwner) {
      const owner = session.localOwner
      session.localOwner = null
      owner.resolveReady?.()
      owner.resolveReady = null
      await this.closeLocalAutomation(session)
      for (const request of owner.requests.values()) {
        clearTimeout(request.timer)
        request.resolve(false)
      }
      owner.requests.clear()
      owner.transport.send({ type: 'closed', reason })
      owner.transport.disconnect()
    }

    if (session.launch || session.browser) {
      await this.closePlaywrightRuntime(session)
    } else {
      await this.detachAgent(session)
    }

    await fs.rm(session.agentDirectory, { recursive: true, force: true })
    if (this.sessions.get(session.panelId) === session) {
      this.sessions.delete(session.panelId)
    }

    for (const attachment of session.attachments.values()) {
      attachment.closing = true
      attachment.transport.sendMessage({ type: 'closed', reason })
      attachment.transport.disconnect()
    }
  }

  close(connectionId: string): void {
    for (const session of this.sessions.values()) {
      const attachment = session.attachments.get(connectionId)
      if (!attachment || attachment.closing) {
        continue
      }

      attachment.closing = true
      void this.scheduleOperation(
        session,
        async () => {
          session.attachments.delete(connectionId)
          await this.updateScreencast(session)
        },
        { required: true }
      ).catch(() => undefined)
      return
    }
  }

  async requestPanelClose(panelId: string, force = false): Promise<boolean> {
    const session =
      this.sessions.get(panelId) ??
      (await this.sessionCreations.get(panelId)?.catch(() => null))
    if (!session) {
      return true
    }

    let canClose = false
    await this.scheduleOperation(
      session,
      async () => {
        if (session.localOwner) {
          canClose = await this.requestLocalOwner(session.localOwner, {
            type: 'closeRequest',
            force
          })
        } else if (session.launch || session.browser) {
          const browser = await (session.launch ??
            Promise.resolve(session.browser!))
          canClose = await browser.requestClose(force)
        } else {
          canClose = true
        }

        if (canClose) {
          session.closing = true
          this.stopScheduler(session, 'Browser closed.')
        }
      },
      { required: true }
    )
    return canClose
  }

  async closePanel(panelId: string, reason: string): Promise<void> {
    const session =
      this.sessions.get(panelId) ??
      (await this.sessionCreations.get(panelId)?.catch(() => null))
    if (!session) {
      return
    }

    if (session.closeOperation) {
      return session.closeOperation
    }

    session.closing = true
    this.stopScheduler(session, reason)
    session.agentProcess?.kill('SIGTERM')
    const closeOperation = this.scheduleOperation(
      session,
      () => this.destroySession(session, reason),
      { required: true, allowWhenClosing: true }
    )
    session.closeOperation = closeOperation
    return closeOperation
  }

  private async playwrightCliPath(): Promise<string> {
    const require = createRequire(import.meta.url)
    const packageJsonPath = require.resolve('@playwright/cli/package.json')
    return path.join(path.dirname(packageJsonPath), 'playwright-cli.js')
  }

  private executeAgentCli(
    session: BrowserSession,
    args: string[]
  ): Promise<string> {
    if (this.agentCliRunner) {
      return this.agentCliRunner(
        {
          panelId: session.panelId,
          agentDirectory: session.agentDirectory
        },
        args
      )
    }

    return this.runAgentCli(session, args)
  }

  private async runAgentCli(
    session: BrowserSession,
    args: string[]
  ): Promise<string> {
    const cli = await this.playwrightCliPath()
    return new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: session.agentDirectory,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        killSignal: 'SIGTERM'
      })
      session.agentProcess = child
      let output = ''
      const append = (data: Buffer) => {
        if (output.length < 10 * 1024 * 1024) {
          output += String(data)
        }
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      child.once('error', (error) => {
        if (session.agentProcess === child) {
          session.agentProcess = null
        }

        reject(error)
      })
      child.once('exit', (code) => {
        if (session.agentProcess === child) {
          session.agentProcess = null
        }

        if (code === 0) {
          resolve(output.trim())
        } else {
          reject(
            new Error(
              output.trim() || `Playwright Agent CLI exited with ${code}`
            )
          )
        }
      })
    })
  }

  private ensureLocalAutomation(
    session: BrowserSession,
    owner: BrowserLocalOwner
  ): Promise<BrowserLocalAutomation> {
    const current = session.localAutomation
    if (
      current?.generation === owner.generation &&
      current.browser.isConnected()
    ) {
      return Promise.resolve(current)
    }

    if (session.localAutomationLaunch) {
      return session.localAutomationLaunch
    }

    if (current) {
      session.localAutomation = null
      current.frameProducer.stop()
    }

    const launch = (async () => {
      if (current) {
        await current.cdp.send('Page.stopScreencast').catch(() => undefined)
        await current.cdp.detach().catch(() => undefined)
        await current.browser.close().catch(() => undefined)
      }

      if (!owner.ready) {
        let readinessTimer: ReturnType<typeof setTimeout> | null = null
        await Promise.race([
          owner.readyPromise,
          new Promise<void>((_resolve, reject) => {
            readinessTimer = setTimeout(
              () =>
                reject(
                  new Error(
                    'The visible local Browser did not become ready within 15 seconds.'
                  )
                ),
              15_000
            )
            readinessTimer.unref()
          })
        ]).finally(() => {
          if (readinessTimer) {
            clearTimeout(readinessTimer)
          }
        })
      }

      if (
        !owner.ready ||
        session.localOwner !== owner ||
        session.generation !== owner.generation
      ) {
        throw new Error('The local Browser owner changed before it was ready.')
      }

      const browser = await this.connectLocalAutomation(owner.endpoint)
      const context = browser.contexts()[0]
      const page = context?.pages()[0]
      if (!context || !page) {
        await browser.close().catch(() => undefined)
        throw new Error('The local Browser page is not available.')
      }

      if (
        session.localOwner !== owner ||
        session.generation !== owner.generation
      ) {
        await browser.close().catch(() => undefined)
        throw new Error('The local Browser owner changed.')
      }

      const cdp = await context.newCDPSession(page)
      const frameProducer = new LatestBrowserFrameProducer(
        (frame) => {
          if (
            session.localOwner === owner &&
            session.localAutomation?.generation === owner.generation
          ) {
            this.publishFrame(session, frame)
          }
        },
        (sessionId) => {
          void cdp
            .send('Page.screencastFrameAck', { sessionId })
            .catch(() => undefined)
        }
      )
      const automation: BrowserLocalAutomation = {
        browser,
        page,
        cdp,
        frameProducer,
        generation: owner.generation,
        console: [],
        requests: [],
        screencasting: false,
        screencastTail: Promise.resolve()
      }
      cdp.on('Page.screencastFrame', (frame) => frameProducer.receive(frame))
      browser.once('disconnected', () => {
        if (session.localAutomation !== automation) {
          return
        }

        automation.frameProducer.stop()
        automation.screencasting = false
        session.localAutomation = null
        void this.scheduleOperation(
          session,
          () => this.updateScreencast(session),
          { required: true }
        ).catch((cause) =>
          this.broadcastNavigationError(
            session,
            cause instanceof Error ? cause.message : String(cause)
          )
        )
      })
      await cdp.send('Page.enable')
      page.on('console', (message) => {
        automation.console.push(`${message.type()}: ${message.text()}`)
        if (automation.console.length > 1_000) {
          automation.console.shift()
        }
      })
      page.on('pageerror', (error) => {
        automation.console.push(`error: ${error.message}`)
        if (automation.console.length > 1_000) {
          automation.console.shift()
        }
      })
      page.on('request', (request) => {
        automation.requests.push(`${request.method()} ${request.url()}`)
        if (automation.requests.length > 2_000) {
          automation.requests.shift()
        }
      })
      session.localAutomation = automation
      return automation
    })()
    session.localAutomationLaunch = launch
    const clearLaunch = () => {
      if (session.localAutomationLaunch === launch) {
        session.localAutomationLaunch = null
      }
    }
    void launch.then(clearLaunch, clearLaunch)
    return launch
  }

  private async closeLocalAutomation(session: BrowserSession): Promise<void> {
    const launch = session.localAutomationLaunch
    const automation =
      session.localAutomation ?? (await launch?.catch(() => null))
    session.localAutomation = null
    session.localAutomationLaunch = null
    if (automation) {
      automation.frameProducer.stop()
      await automation.cdp.send('Page.stopScreencast').catch(() => undefined)
      await automation.cdp.detach().catch(() => undefined)
      await automation.browser.close().catch(() => undefined)
    }
  }

  private async setLocalScreencasting(
    session: BrowserSession,
    owner: BrowserLocalOwner,
    enabled: boolean
  ): Promise<void> {
    const automation = enabled
      ? await this.ensureLocalAutomation(session, owner)
      : session.localAutomation
    if (!automation || automation.generation !== owner.generation) {
      return
    }

    const operation = automation.screencastTail.then(async () => {
      if (
        session.localOwner !== owner ||
        session.localAutomation !== automation ||
        automation.screencasting === enabled
      ) {
        return
      }

      automation.screencasting = enabled
      if (!enabled) {
        automation.frameProducer.stop()
        await automation.cdp.send('Page.stopScreencast').catch(() => undefined)
        return
      }

      automation.frameProducer.start()
      const width = Math.max(320, session.state.viewport.width || 1_280)
      const height = Math.max(200, session.state.viewport.height || 800)
      await automation.cdp
        .send('Page.startScreencast', {
          format: 'jpeg',
          quality: 75,
          maxWidth: width,
          maxHeight: height,
          everyNthFrame: 1
        })
        .catch((cause) => {
          automation.screencasting = false
          automation.frameProducer.stop()
          throw cause
        })
    })
    automation.screencastTail = operation.catch(() => undefined)
    await operation
  }

  private async executeLocalClientCommand(
    session: BrowserSession,
    owner: BrowserLocalOwner,
    message: BrowserClientMessage
  ): Promise<void> {
    const automation = await this.ensureLocalAutomation(session, owner)
    const page = automation.page
    if (message.type === 'navigate') {
      await page.goto(message.url, { waitUntil: 'commit' })
    } else if (message.type === 'back') {
      await page.goBack({ waitUntil: 'commit' })
    } else if (message.type === 'forward') {
      await page.goForward({ waitUntil: 'commit' })
    } else if (message.type === 'reload') {
      await page.reload({ waitUntil: 'commit' })
    } else if (message.type === 'stop') {
      await automation.cdp.send('Page.stopLoading')
    } else if (message.type === 'pointer') {
      await page.mouse.move(message.x, message.y)
      if (message.phase === 'down') {
        await page.mouse.down({ button: message.button ?? 'left' })
      } else if (message.phase === 'up') {
        await page.mouse.up({ button: message.button ?? 'left' })
      }
    } else if (message.type === 'wheel') {
      await page.mouse.wheel(message.deltaX, message.deltaY)
    } else if (message.type === 'key') {
      if (message.phase === 'down') {
        await page.keyboard.down(message.key)
      } else {
        await page.keyboard.up(message.key)
      }
    } else if (message.type === 'insertText') {
      await page.keyboard.insertText(message.text)
    } else if (message.type === 'find') {
      await page.evaluate(({ text, forward, findNext }) => {
        if (!findNext) {
          window.getSelection()?.removeAllRanges()
        }

        // @ts-expect-error -- Chromium supplies the nonstandard window.find API.
        window.find(text, false, !forward, true, false, true, false)
      }, message)
    } else if (message.type === 'stopFind') {
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
    }
  }

  private async executeLocalAgentCommand(
    session: BrowserSession,
    owner: BrowserLocalOwner,
    input: BrowserAgentCommand
  ): Promise<string> {
    const automation = await this.ensureLocalAutomation(session, owner)
    const page = automation.page
    const target = (value: string) => page.locator(`aria-ref=${value}`)
    if (input.command === 'snapshot') {
      // eslint-disable-next-line anti-slop/no-reflect-apply -- Playwright exposes CLI element references through this internal snapshot option.
      return Reflect.apply(page.ariaSnapshot, page, [{ mode: 'ai' }])
    }

    if (input.command === 'click') {
      await target(input.args[0]).click()
      return `Clicked ${input.args[0]}`
    }

    if (input.command === 'fill') {
      await target(input.args[0]).fill(input.args[1])
      return `Filled ${input.args[0]}`
    }

    if (input.command === 'press') {
      await page.keyboard.press(input.args[0])
      return `Pressed ${input.args[0]}`
    }

    if (input.command === 'console') {
      const minimum = input.args[0] ?? 'info'
      const levels = ['debug', 'info', 'warning', 'error']
      const minimumIndex = Math.max(0, levels.indexOf(minimum))
      return (
        automation.console
          .filter((line) => {
            const level = line.slice(0, line.indexOf(':'))
            const index = levels.indexOf(level)
            return index < 0 || index >= minimumIndex
          })
          .join('\n') || 'No console messages.'
      )
    }

    if (input.command === 'requests') {
      return automation.requests.join('\n') || 'No network requests.'
    }

    if (input.command === 'screenshot') {
      const screenshotPath = path.join(
        session.agentDirectory,
        `screenshot-${Date.now()}.png`
      )
      await page.screenshot({ path: screenshotPath })
      return `Screenshot saved to ${screenshotPath}`
    }

    if (input.command === 'goto') {
      await page.goto(input.args[0])
      return `Navigated to ${page.url()}`
    }

    if (input.command === 'go-back') {
      await page.goBack()
      return `Navigated to ${page.url()}`
    }

    if (input.command === 'go-forward') {
      await page.goForward()
      return `Navigated to ${page.url()}`
    }

    await page.reload()
    return `Reloaded ${page.url()}`
  }

  async agentCommand(
    panelId: string,
    input: BrowserAgentCommand
  ): Promise<string> {
    const session = await this.getSession(panelId)
    let result = ''
    await this.scheduleOperation(session, async () => {
      const localOwner = session.localOwner
      const browser = localOwner
        ? null
        : await this.browserFor(session).catch(async (error) => {
            await this.closePlaywrightRuntime(session).catch(() => undefined)
            throw error
          })
      const previousController = session.controllerId
      let agentControlled = false
      try {
        if (localOwner) {
          await this.updateScreencast(session, 'agent')
          if (
            session.localOwner !== localOwner ||
            localOwner.generation !== session.generation
          ) {
            throw new Error('The local Browser owner changed.')
          }
        }

        session.controllerId = 'agent'
        agentControlled = true
        this.broadcastState(session, 'controlChanged')
        if (localOwner) {
          result = await this.executeLocalAgentCommand(
            session,
            localOwner,
            input
          )
        } else if (this.agentCliRunner) {
          const name =
            session.agentSessionName ??
            `treeport-${panelId}-${session.generation}-${crypto
              .randomBytes(6)
              .toString('hex')}`
          session.agentSessionName = name
          if (!session.agentAttached) {
            await this.executeAgentCli(session, [
              'attach',
              `treeport-${panelId}`,
              '--session',
              name
            ])
            session.agentAttached = true
          }

          result = await this.executeAgentCli(session, [
            `-s=${name}`,
            input.command,
            '--',
            ...input.args
          ])
          this.queuePanelState(session, browser!.state)
        } else {
          result = await browser!.agentCommand(input)
          this.queuePanelState(session, browser!.state)
        }

        await this.waitForPanelState(session)
      } catch (cause) {
        if (!localOwner) {
          session.agentAttached = false
        }

        throw cause
      } finally {
        if (agentControlled) {
          if (localOwner && session.localOwner === localOwner) {
            const nextController =
              previousController && previousController !== 'agent'
                ? previousController
                : LOCAL_BROWSER_OWNER_CONTROLLER
            const released = await this.updateScreencast(
              session,
              nextController
            ).then(
              () => true,
              () => false
            )
            if (released) {
              session.controllerId = nextController
            }
          } else {
            const nextAttachment = [...session.attachments.values()].find(
              (attachment) => !attachment.closing && attachment.visible
            )
            session.controllerId =
              previousController && previousController !== 'agent'
                ? previousController
                : nextAttachment
                  ? attachmentController(nextAttachment.clientId)
                  : null
          }

          this.broadcastState(session, 'controlChanged')
        }
      }
    })
    return result
  }

  async status(): Promise<BrowserInstallStatus> {
    return PlaywrightBrowser.status(this.cachePath)
  }

  async install(): Promise<string> {
    if (this.installing) {
      return this.installing
    }

    this.installing = (async () => {
      const require = createRequire(import.meta.url)
      const packageJsonPath = require.resolve('playwright/package.json')
      const packageJson = playwrightPackageSchema.parse(
        JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))
      )
      const cli = path.join(
        path.dirname(packageJsonPath),
        packageJson.bin?.playwright ?? 'cli.js'
      )
      return new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [cli, 'install', 'chromium', '--no-shell'],
          {
            env: {
              ...process.env,
              PLAYWRIGHT_BROWSERS_PATH: this.cachePath
            },
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )
        let output = ''
        child.stdout.on('data', (data) => (output += String(data)))
        child.stderr.on('data', (data) => (output += String(data)))
        child.once('error', reject)
        child.once('exit', (code) => {
          if (code === 0) {
            resolve(output.trim() || 'Chromium installed.')
          } else {
            reject(new Error(output.trim() || `Playwright exited with ${code}`))
          }
        })
      })
    })()
    try {
      return await this.installing
    } finally {
      this.installing = null
    }
  }

  async remove(): Promise<void> {
    if (this.installing) {
      throw new Error('Wait for the Browser installation to finish.')
    }

    if (
      this.browserHost.started ||
      [...this.sessions.values()].some(
        (session) => session.browser !== null || session.launch !== null
      )
    ) {
      throw new Error('Close daemon-owned Browser before you remove Chromium.')
    }

    await fs.rm(this.cachePath, { recursive: true, force: true })
  }

  async dispose(): Promise<void> {
    this.unsubscribe()
    this.tickets.clear()
    this.ownerTickets.clear()
    await Promise.all(
      [...this.sessionCreations.values()].map((creation) =>
        creation.catch(() => null)
      )
    )
    await Promise.all(
      [...this.sessions.keys()].map((panelId) =>
        this.closePanel(panelId, 'Treeport is shutting down.')
      )
    )
    await this.browserHost.close()
  }
}
