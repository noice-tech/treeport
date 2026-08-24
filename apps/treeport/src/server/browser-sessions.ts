import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { z } from 'zod'
import type {
  BrowserAgentCommand,
  BrowserClientMessage,
  BrowserFrame,
  BrowserServerMessage,
  BrowserSessionState
} from '@treeport/shared'
import {
  BROWSER_MAX_FRAME_BYTES,
  browserUrlSchema,
  parseBrowserClientMessage
} from '@treeport/shared'
import type { AppConfig, TreeportService } from './core/index'
import {
  PlaywrightBrowser,
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

export interface BrowserSessionService {
  authorizeBrowserPanel: TreeportService['authorizeBrowserPanel']
  updateBrowserPanelState: TreeportService['updateBrowserPanelState']
  openBrowserPanelFromPanel: TreeportService['openBrowserPanelFromPanel']
  events: Pick<TreeportService['events'], 'subscribe'>
}

export type BrowserSessionConfig = Pick<AppConfig, 'cacheDir' | 'runtimeDir'>

export interface BrowserSessionBrowser {
  readonly state: Omit<
    BrowserSessionState,
    'controlled' | 'hasController' | 'controller'
  >
  launch(): Promise<void>
  command(message: BrowserClientMessage): Promise<void>
  setScreencasting(enabled: boolean): Promise<void>
  requestClose(force: boolean): Promise<boolean>
  close(): Promise<void>
}

export type BrowserSessionBrowserFactory = (
  cachePath: string,
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

interface BrowserTicket {
  panelId: string
  clientId: string
  expiresAt: number
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
  agentProcess: ChildProcess | null
  crashMessage: string | null
  closing: boolean
  closeOperation: Promise<void> | null
}

const MAX_BROWSER_ATTACHMENTS = 8
const MAX_BROWSER_TICKETS = 256
const MAX_BROWSER_SCHEDULED_OPERATIONS = 64
const MAX_BROWSER_REGULAR_OPERATIONS = 46
const playwrightPackageSchema = z.object({
  bin: z.object({ playwright: z.string() }).optional()
})

const defaultBrowserFactory: BrowserSessionBrowserFactory = (
  cachePath,
  workspacePath,
  title,
  panelId,
  worktreeId,
  callbacks
) =>
  new PlaywrightBrowser(
    cachePath,
    workspacePath,
    title,
    panelId,
    worktreeId,
    callbacks
  )

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
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly sessionCreations = new Map<string, Promise<BrowserSession>>()
  private readonly tickets = new Map<string, BrowserTicket>()
  private readonly unsubscribe: () => void
  private installing: Promise<string> | null = null

  constructor(
    private readonly service: BrowserSessionService,
    private readonly config: BrowserSessionConfig,
    private readonly browserFactory: BrowserSessionBrowserFactory = defaultBrowserFactory,
    private readonly agentCliRunner: BrowserAgentCliRunner | null = null
  ) {
    this.cachePath = path.join(config.cacheDir, 'playwright')
    this.unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'panel.removed') {
        void this.closePanel(String(event.data.panelId), 'Panel closed')
      } else if (event.type === 'worktree.removed' && event.data.worktreeId) {
        for (const session of this.sessions.values()) {
          void this.service
            .authorizeBrowserPanel(session.panelId)
            .catch(() => this.closePanel(session.panelId, 'Worktree removed'))
        }
      }
    })
  }

  async issueTicket(panelId: string, clientId: string): Promise<string> {
    await this.service.authorizeBrowserPanel(panelId)
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
      expiresAt: Date.now() + 30_000
    })
    return ticket
  }

  private stateFor(
    session: BrowserSession,
    attachment: BrowserAttachment
  ): BrowserSessionState {
    return {
      ...session.state,
      controlled: session.controllerId === attachment.id,
      hasController: session.controllerId !== null,
      controller:
        session.controllerId === attachment.id
          ? 'you'
          : session.controllerId === 'agent'
            ? 'agent'
            : session.controllerId
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
          const panel = await this.service.updateBrowserPanelState(
            session.panelId,
            pending
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
    if (this.sessions.size >= 6) {
      throw new Error(
        'Treeport supports at most six active Browser sessions. Close one and try again.'
      )
    }

    const authorized = await this.service.authorizeBrowserPanel(panelId)
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
        ready: false
      },
      agentAttached: false,
      agentProcess: null,
      crashMessage: null,
      closing: false,
      closeOperation: null
    }
    const browserLaunch = (async () => {
      const browser = this.browserFactory(
        this.cachePath,
        session.agentDirectory,
        session.title,
        panelId,
        authorized.panel.worktreeId,
        {
          state: (state) => {
            session.state = state
            this.queuePanelState(session, state)
            this.broadcastState(session)
          },
          frame: (frame) => this.publishFrame(session, frame),
          popup: (url) => {
            void this.service
              .openBrowserPanelFromPanel(session.panelId, url)
              .catch((cause) => {
                const message =
                  cause instanceof Error ? cause.message : String(cause)
                for (const attachment of session.attachments.values()) {
                  attachment.transport.sendMessage({
                    type: 'navigationError',
                    message: `Could not open the popup: ${message}`
                  })
                }
              })
          },
          navigationError: (message) => {
            for (const attachment of session.attachments.values()) {
              attachment.transport.sendMessage({
                type: 'navigationError',
                message
              })
            }
          },
          crashed: (message) => {
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
      session.state = browser.state
      if (!restoredUrl) {
        session.persistence.ready = true
        this.queuePanelState(session, session.state)
      }

      return browser
    })()
    session.launch = browserLaunch
    this.sessions.set(panelId, session)
    if (restoredUrl) {
      const restore = this.scheduleOperation(
        session,
        async () => {
          const browser = await browserLaunch
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
                title:
                  authorized.panel.title === 'Browser'
                    ? browser.state.title
                    : authorized.panel.title
              }
          session.persistence.ready = true
          if (restored) {
            this.queuePanelState(session, session.state)
            await this.waitForPanelState(session)
          }
        },
        { required: true }
      )
      session.launch = restore.then(() => browserLaunch)
    }

    return session
  }

  private browserFor(session: BrowserSession): Promise<BrowserSessionBrowser> {
    if (!session.launch) {
      return Promise.reject(new Error('Browser launch is not ready.'))
    }

    return session.launch
  }

  private async getSession(panelId: string): Promise<BrowserSession> {
    const existing = this.sessions.get(panelId)
    if (existing) {
      await this.service.authorizeBrowserPanel(panelId)
      return existing
    }

    const pending = this.sessionCreations.get(panelId)
    if (pending) {
      return pending
    }

    if (this.sessions.size + this.sessionCreations.size >= 6) {
      throw new Error(
        'Treeport supports at most six active Browser sessions. Close one and try again.'
      )
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
    if (session.attachments.size >= MAX_BROWSER_ATTACHMENTS) {
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
      visible: true,
      closing: false,
      awaitingFrame: null,
      pendingFrame: null,
      viewport: { ...session.state.viewport }
    }
    session.attachments.set(attachment.id, attachment)

    try {
      await this.browserFor(session)
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

          session.controllerId ??= attachment.id
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
      if (this.sessions.get(session.panelId) === session) {
        this.sessions.delete(session.panelId)
      }

      session.closing = true
      this.stopScheduler(session, 'Browser launch failed.')
      const message = error instanceof Error ? error.message : String(error)
      transport.sendMessage({
        type: 'browserUnavailable',
        message,
        installCommand: 'treeport browser install'
      })
      await session.browser?.close()
      await fs.rm(session.agentDirectory, { recursive: true, force: true })
    }
    return attachment.id
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
        execute: () => this.updateScreencast(session),
        required: true
      })
      return
    }

    if (message.type === 'resize') {
      attachment.viewport = { width: message.width, height: message.height }
      this.queueClientOperation(session, attachment, {
        coalesceKey: `resize:${attachment.id}`,
        message,
        execute: async (queuedMessage) => {
          if (
            queuedMessage?.type !== 'resize' ||
            attachment.closing ||
            session.attachments.get(attachment.id) !== attachment ||
            session.controllerId !== attachment.id
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

          const changed = session.controllerId !== attachment.id
          session.controllerId = attachment.id
          if (changed) {
            this.broadcastState(session, 'controlChanged')
          }

          try {
            const browser = await this.browserFor(session)
            await browser.command({ type: 'resize', ...attachment.viewport })
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
      message.type === 'pointer' && message.phase === 'move'
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

        if (session.controllerId !== attachment.id) {
          attachment.transport.sendMessage({
            type: 'navigationError',
            message: 'Take control before you interact with this browser.'
          })
          return
        }

        try {
          if (queuedMessage.type === 'reset') {
            await this.resetSession(session)
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

  private async updateScreencast(session: BrowserSession): Promise<void> {
    const browser = await this.browserFor(session).catch(() => null)
    if (!browser) {
      return
    }

    await browser
      .setScreencasting(
        [...session.attachments.values()].some(
          (attachment) =>
            !attachment.closing &&
            attachment.visible &&
            attachment.transport.isConnected()
        )
      )
      .catch(() => undefined)
  }

  private async detachAgent(session: BrowserSession): Promise<void> {
    if (!session.agentAttached) {
      return
    }

    session.agentAttached = false
    await this.executeAgentCli(session, [
      `-s=treeport-${session.panelId}`,
      'detach'
    ]).catch(() => undefined)
  }

  private async destroySession(
    session: BrowserSession,
    reason: string
  ): Promise<void> {
    await this.waitForPanelState(session)
    await this.detachAgent(session)
    await this.browserFor(session)
      .catch(() => session.browser)
      .then((browser) => browser?.close())
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

  private async resetSession(session: BrowserSession): Promise<void> {
    session.closing = true
    this.stopScheduler(session, 'Browser reset.')
    await this.waitForPanelState(session)
    await this.service.updateBrowserPanelState(session.panelId, {
      url: 'about:blank',
      title: 'Browser'
    })
    session.persistence.pending = null
    session.persistence.persistedUrl = 'about:blank'
    session.persistence.persistedTitle = 'Browser'
    await this.destroySession(
      session,
      'Browser reset; reconnecting to a new empty session.'
    )
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
          if (session.controllerId === connectionId) {
            session.controllerId =
              [...session.attachments.values()].find(
                (candidate) => !candidate.closing
              )?.id ?? null
            this.broadcastState(session, 'controlChanged')
          }

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
        const browser = await this.browserFor(session)
        canClose = await browser.requestClose(force)
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

  async agentCommand(
    panelId: string,
    input: BrowserAgentCommand
  ): Promise<string> {
    const session = await this.getSession(panelId)
    let result = ''
    await this.scheduleOperation(session, async () => {
      const browser = await this.browserFor(session).catch(async (error) => {
        session.closing = true
        this.stopScheduler(session, 'Browser launch failed.')
        await this.destroySession(session, 'Browser launch failed.')
        throw error
      })
      const name = `treeport-${panelId}`
      if (!session.agentAttached) {
        await this.executeAgentCli(session, ['attach', name, '--session', name])
        session.agentAttached = true
      }

      const previousController = session.controllerId
      session.controllerId = 'agent'
      this.broadcastState(session, 'controlChanged')
      try {
        result = await this.executeAgentCli(session, [
          `-s=${name}`,
          input.command,
          '--',
          ...input.args
        ])
        this.queuePanelState(session, browser.state)
        await this.waitForPanelState(session)
      } finally {
        session.controllerId =
          previousController &&
          previousController !== 'agent' &&
          !session.attachments.get(previousController)?.closing
            ? previousController
            : ([...session.attachments.values()].find(
                (attachment) => !attachment.closing
              )?.id ?? null)
        this.broadcastState(session, 'controlChanged')
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

    if (this.sessions.size > 0) {
      throw new Error('Close Browser before you remove Chromium.')
    }

    await fs.rm(this.cachePath, { recursive: true, force: true })
  }

  async dispose(): Promise<void> {
    this.unsubscribe()
    this.tickets.clear()
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
  }
}
