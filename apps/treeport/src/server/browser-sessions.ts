import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Exit from 'effect/Exit'
import * as Queue from 'effect/Queue'
import * as Scope from 'effect/Scope'
import * as Data from 'effect/Data'
import type {
  Browser as PlaywrightConnection,
  CDPSession,
  Page
} from 'playwright'
import type {
  BrowserAgentCommand,
  BrowserClientMessage,
  BrowserPanel,
  BrowserFrame,
  BrowserOwnerAuth,
  BrowserOwnerClientMessage,
  BrowserOwnerServerMessage,
  BrowserServerMessage,
  BrowserSessionState,
  BrowserVideoCdpSession
} from '@treeport/shared'
import {
  BROWSER_MAX_FRAME_BYTES,
  browserOwnerEndpointSchema,
  browserOwnerIdentitySchema,
  browserObservedUrlSchema,
  normalizeBrowserTitle,
  decodeUnknownOrNull,
  isSchemaValue,
  parseBrowserClientMessage,
  parseBrowserOwnerClientMessage
} from '@treeport/shared'
import type { AppConfig, TreeportService } from './core/index'
import type { ApplicationServices } from './core/services/infrastructure/application-runtime'
import { networkTelemetry } from './network-telemetry'
import {
  PlaywrightBrowser,
  PlaywrightBrowserHost,
  type BrowserInstallStatus,
  type PlaywrightBrowserCallbacks
} from './playwright-browser'

import { receiveBrowserVideo } from './browser-video'
import { browserCursor } from './browser-cursor'
import { BrowserContainer } from './browser-container'
import { usesBrowserContainer } from './browser-runtime'

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
  forkApplicationEffect: TreeportService['forkApplicationEffect']
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
  cursor(point: { x: number; y: number }): ReturnType<typeof browserCursor>
  agentCommand(input: BrowserAgentCommand): Promise<string>
  setScreencasting(enabled: boolean): Promise<void>
  requestVideoKeyframe(): Promise<void>
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

type BrowserOwnerRequest = Deferred.Deferred<boolean>

interface BrowserLocalAutomation {
  browser: PlaywrightConnection
  page: Page
  cdp: CDPSession
  video: BrowserVideoCdpSession
  generation: number
  console: string[]
  requests: string[]
  screencasting: boolean
  captureViewport: { width: number; height: number } | null
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
  readiness: Deferred.Deferred<void>
  requests: Map<string, BrowserOwnerRequest>
}

interface BrowserAttachment {
  id: string
  clientId: string
  transport: BrowserTransport
  visible: boolean
  closing: boolean
  inFlightFrames: Map<number, number>
  pendingJpeg: BrowserFrame | null
  cursorPoint: { x: number; y: number } | null
  waitingForKeyframe: boolean
  viewport: { width: number; height: number }
}

class BrowserSchedulingError extends Data.TaggedError(
  'BrowserSchedulingError'
)<{
  message: string
  reason: 'overload' | 'closing' | 'operation'
}> {}

interface BrowserScheduledOperation {
  coalesceKey: string | null
  message: BrowserClientMessage | null
  execute(message: BrowserClientMessage | null): Promise<void>
  completion: Deferred.Deferred<void, BrowserSchedulingError>
  result: Promise<void> | null
  required: boolean
}

type BrowserScheduledInput = Omit<
  BrowserScheduledOperation,
  'completion' | 'result'
>

interface BrowserScheduler {
  queue: Queue.Queue<BrowserScheduledOperation>
  scope: Scope.CloseableScope
  pending: Set<BrowserScheduledOperation>
  tail: BrowserScheduledOperation | null
  active: BrowserScheduledOperation | null
  controlKey: string | null
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
  worktreeId: string
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
  videoError: string | null
  keyframeRequestedAt: number
  keyframeTimer: ReturnType<typeof setTimeout> | null
  scheduler: BrowserScheduler
  persistence: BrowserPanelStatePersistence
  agentAttached: boolean
  agentSessionName: string | null
  agentProcess: ChildProcess | null
  crashMessage: string | null
  closing: boolean
  closeOperation: Promise<void> | null
  closeReason: string
}

const MAX_BROWSER_ATTACHMENTS = 8
const MAX_BROWSER_TICKETS = 256
const LOCAL_BROWSER_OWNER_CONTROLLER = 'local-owner'
const attachmentController = (clientId: string) => `attachment:${clientId}`
const MAX_BROWSER_SCHEDULED_OPERATIONS = 64
const MAX_BROWSER_REGULAR_OPERATIONS = 46
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
  private readonly operationQueuedAt = new WeakMap<
    BrowserScheduledOperation,
    number
  >()
  private readonly unsubscribe: () => void
  private installing: Promise<string> | null = null
  private disposing: Promise<void> | null = null
  private disposed = false

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
    this.cachePath = path.join(config.cacheDir, 'browser')
    this.browserHost = new PlaywrightBrowserHost(
      // Keep the system browser profile separate from retired bundled Chromium.
      path.join(
        config.dataDir,
        usesBrowserContainer()
          ? 'browser-profile-container'
          : 'browser-profile-chrome'
      ),
      this.cachePath
    )
    this.unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'panel.removed') {
        this.service.forkApplicationEffect(
          Effect.tryPromise({
            try: () =>
              this.closePanel(String(event.data.panelId), 'Panel closed'),
            catch: (cause) => cause
          }).pipe(
            Effect.catchAll((error) =>
              Effect.logError('Failed to close a removed Browser panel').pipe(
                Effect.annotateLogs({ cause: String(error) })
              )
            )
          )
        )
      } else if (event.type === 'worktree.removed' && event.data.worktreeId) {
        for (const session of this.sessions.values()) {
          this.service.forkApplicationEffect(
            this.service.panels.authorizeBrowserPanel(session.panelId).pipe(
              Effect.catchAll(() =>
                Effect.tryPromise({
                  try: () =>
                    this.closePanel(session.panelId, 'Worktree removed'),
                  catch: (cause) => cause
                })
              ),
              Effect.catchAll((error) =>
                Effect.logError(
                  `Failed to close Browser panel ${session.panelId} after its tree was removed`
                ).pipe(Effect.annotateLogs({ cause: String(error) }))
              ),
              Effect.asVoid
            )
          )
        }
      }
    })
  }

  issueTicket(
    panelId: string,
    clientId: string,
    visible = true
  ): Effect.Effect<string, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      yield* this.service.panels.authorizeBrowserPanel(panelId)
      for (const [value, ticket] of this.tickets) {
        if (ticket.expiresAt < Date.now()) {
          this.tickets.delete(value)
        }
      }
      if (this.tickets.size >= MAX_BROWSER_TICKETS) {
        return yield* Effect.fail(
          new Error('Too many Browser attachment requests are pending.')
        )
      }

      const ticket = crypto.randomBytes(32).toString('base64url')
      this.tickets.set(ticket, {
        panelId,
        clientId,
        visible,
        expiresAt: Date.now() + 30_000
      })
      return ticket
    })
  }

  issueOwnerTicket(
    panelId: string,
    clientId: string
  ): Effect.Effect<
    { ticket: string; challenge: string },
    unknown,
    ApplicationServices
  > {
    return Effect.gen(this, function* () {
      yield* this.service.panels.authorizeBrowserPanel(panelId)
      for (const [value, ticket] of this.ownerTickets) {
        if (ticket.expiresAt < Date.now()) {
          this.ownerTickets.delete(value)
        }
      }
      if (this.ownerTickets.size >= MAX_BROWSER_TICKETS) {
        return yield* Effect.fail(
          new Error('Too many Browser owner requests are pending.')
        )
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
    })
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
    input: BrowserScheduledInput
  ): BrowserScheduledOperation | null {
    const scheduler = session.scheduler
    if (!scheduler.accepting) {
      return null
    }

    // Only adjacent operations commute. In particular, moving the pointer can
    // change the wheel target, and a resize must not cross a button transition.
    const existing = scheduler.tail
    if (input.coalesceKey && existing?.coalesceKey === input.coalesceKey) {
      if (
        existing.message?.type === 'wheel' &&
        input.message?.type === 'wheel'
      ) {
        existing.message = {
          type: 'wheel',
          deltaX: existing.message.deltaX + input.message.deltaX,
          deltaY: existing.message.deltaY + input.message.deltaY
        }
      } else {
        existing.message = input.message
      }

      existing.execute = input.execute
      networkTelemetry.droppedNow('browsers', 'coalesced')
      return existing
    }

    if (
      scheduler.pending.size >=
      (input.required
        ? MAX_BROWSER_SCHEDULED_OPERATIONS
        : MAX_BROWSER_REGULAR_OPERATIONS)
    ) {
      networkTelemetry.droppedNow('browsers', 'dropped')
      return null
    }

    const operation: BrowserScheduledOperation = {
      ...input,
      completion: Effect.runSync(Deferred.make<void, BrowserSchedulingError>()),
      result: null
    }
    // Never fork producers waiting for capacity. The dropping queue's false
    // return is an explicit admission failure, not permission to lose input.
    if (!Queue.unsafeOffer(scheduler.queue, operation)) {
      networkTelemetry.droppedNow('browsers', 'dropped')
      return null
    }

    scheduler.pending.add(operation)
    scheduler.tail = operation
    if (input.coalesceKey?.startsWith('take-control:')) {
      scheduler.controlKey = input.coalesceKey
    } else if (
      !input.message ||
      !['wheel', 'pointer', 'resize', 'find'].includes(input.message.type)
    ) {
      scheduler.controlKey = null
    }

    this.operationQueuedAt.set(operation, Date.now())
    networkTelemetry.queueDepthNow('browsers', scheduler.pending.size)
    return operation
  }

  private scheduleOperation(
    session: BrowserSession,
    execute: () => Promise<void>,
    options: { required?: boolean } = {}
  ): Promise<void> {
    const operation = this.enqueueOperation(session, {
      coalesceKey: null,
      message: null,
      execute,
      required: options.required ?? false
    })
    if (!operation) {
      return Promise.reject(
        new BrowserSchedulingError({
          reason: session.scheduler.accepting ? 'overload' : 'closing',
          message: session.scheduler.accepting
            ? 'The Browser command queue is full.'
            : 'The Browser session is closing.'
        })
      )
    }

    // Only admitted callers allocate an await fiber. Fire-and-forget input and
    // coalesced notifications never accumulate waiters or Promise listeners.
    operation.result = Effect.runPromise(Deferred.await(operation.completion))
    return operation.result
  }

  private queueClientOperation(
    session: BrowserSession,
    attachment: BrowserAttachment,
    operation: BrowserScheduledInput
  ): void {
    if (!this.enqueueOperation(session, operation)) {
      attachment.transport.sendMessage({
        type: 'navigationError',
        message: session.scheduler.accepting
          ? 'The Browser command queue is full. Wait and try again.'
          : 'The Browser session is closing.'
      })
    }
  }

  private runScheduler(session: BrowserSession): Effect.Effect<never> {
    const scheduler = session.scheduler
    return Effect.forever(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(this, function* () {
          const operation = yield* restore(Queue.take(scheduler.queue))
          // Admission remains tracked until execution, including direct Queue
          // handoff to a consumer that has not resumed yet when shutdown starts.
          if (!scheduler.pending.delete(operation)) {
            return
          }

          scheduler.active = operation
          if (scheduler.tail === operation) {
            scheduler.tail = null
          }

          if (scheduler.controlKey === operation.coalesceKey) {
            scheduler.controlKey = null
          }

          networkTelemetry.queueDepthNow('browsers', scheduler.pending.size)
          const queuedAt = this.operationQueuedAt.get(operation)
          this.operationQueuedAt.delete(operation)
          if (queuedAt !== undefined) {
            networkTelemetry.durationNow(
              'browsers',
              'queue_wait',
              Date.now() - queuedAt
            )
          }

          const started = Date.now()
          // Playwright promises are not abortable. Keep the consumer occupied
          // through actual settlement, including during scope closure. A timeout
          // here would permit stale work to overlap recovery or resource release.
          const result = yield* Effect.exit(
            Effect.tryPromise({
              try: () => operation.execute(operation.message),
              catch: (cause) =>
                new BrowserSchedulingError({
                  reason: 'operation',
                  message:
                    cause instanceof Error ? cause.message : String(cause)
                })
            })
          )
          yield* Deferred.done(operation.completion, result)
          if (Exit.isFailure(result) && !operation.result) {
            this.broadcastNavigationError(session, String(result.cause))
          }

          scheduler.active = null
          networkTelemetry.durationNow(
            'browsers',
            'operation',
            Date.now() - started
          )
        })
      )
    )
  }

  private stopScheduler(session: BrowserSession, reason: string): void {
    const scheduler = session.scheduler
    scheduler.accepting = false
    const error = new BrowserSchedulingError({
      reason: 'closing',
      message: reason
    })
    Effect.runSync(Queue.takeAll(scheduler.queue))
    for (const operation of scheduler.pending) {
      this.operationQueuedAt.delete(operation)
      networkTelemetry.droppedNow('browsers', 'dropped')
      Deferred.unsafeDone(operation.completion, Effect.fail(error))
    }
    scheduler.pending.clear()
    scheduler.tail = null
    scheduler.controlKey = null
    networkTelemetry.queueDepthNow('browsers', 0)
  }

  private broadcastNavigationError(
    session: BrowserSession,
    message: string
  ): void {
    for (const attachment of session.attachments.values()) {
      attachment.transport.sendMessage({ type: 'navigationError', message })
    }
  }

  private broadcastVideoUnavailable(
    session: BrowserSession,
    message: string
  ): void {
    session.videoError = message
    for (const attachment of session.attachments.values()) {
      attachment.transport.sendMessage({ type: 'videoUnavailable', message })
    }
  }

  private resetVideoDelivery(session: BrowserSession): void {
    if (session.keyframeTimer) {
      clearTimeout(session.keyframeTimer)
      session.keyframeTimer = null
    }

    session.videoError = null
    session.keyframeRequestedAt = 0
    for (const attachment of session.attachments.values()) {
      attachment.pendingJpeg = null
      attachment.inFlightFrames.clear()
      attachment.waitingForKeyframe = true
    }
    // Sequence numbers remain monotonic across runtime generations. Otherwise
    // late acknowledgements could release credit for a replacement runtime.
  }

  private openPopup(session: BrowserSession, url: string): void {
    this.service.forkApplicationEffect(
      this.service.panels.openBrowserPanelFromPanel(session.panelId, url).pipe(
        Effect.catchAll((cause) =>
          Effect.sync(() =>
            this.broadcastNavigationError(
              session,
              `Could not open the popup: ${
                cause instanceof Error ? cause.message : String(cause)
              }`
            )
          )
        ),
        Effect.asVoid
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
        ? 'about:blank'
        : decodeUnknownOrNull(browserObservedUrlSchema, value.url)
    if (!parsed) {
      return
    }

    const url = parsed === 'about:blank' ? parsed : new URL(parsed).href
    const requestedTitle = normalizeBrowserTitle(value.title.trim())
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

    const write = new Promise<void>((resolve) => {
      this.service.forkApplicationEffect(
        Effect.gen(this, function* () {
          while (persistence.pending !== null) {
            const pending = persistence.pending
            persistence.pending = null
            const panel = yield* this.service.panels.updateBrowserPanelState(
              session.panelId,
              pending
            )
            persistence.persistedUrl = panel.url
            persistence.persistedTitle = panel.title
          }
        }).pipe(
          Effect.catchAll((cause) =>
            Effect.sync(() => {
              const message =
                cause instanceof Error ? cause.message : String(cause)
              for (const attachment of session.attachments.values()) {
                attachment.transport.sendMessage({
                  type: 'navigationError',
                  message: `Could not save the Browser address and title: ${message}`
                })
              }
            })
          ),
          Effect.ensuring(Effect.sync(resolve))
        )
      )
    })
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

  private async createSession(
    panelId: string,
    authorized: { panel: BrowserPanel; worktreePath: string }
  ): Promise<BrowserSession> {
    const restoredUrl =
      authorized.panel.url === 'about:blank'
        ? null
        : (decodeUnknownOrNull(
            browserObservedUrlSchema,
            authorized.panel.url
          ) ?? 'about:blank')
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
      worktreeId: authorized.panel.worktreeId,
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
      videoError: null,
      keyframeRequestedAt: 0,
      keyframeTimer: null,
      scheduler: {
        queue: Effect.runSync(Queue.dropping(MAX_BROWSER_SCHEDULED_OPERATIONS)),
        scope: Effect.runSync(Scope.make()),
        pending: new Set(),
        tail: null,
        active: null,
        controlKey: null,
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
      closeOperation: null,
      closeReason: 'Browser closed.'
    }
    await Effect.runPromise(
      Effect.gen(this, function* () {
        yield* Effect.addFinalizer(() =>
          Queue.shutdown(session.scheduler.queue)
        )
        yield* Effect.addFinalizer(() =>
          this.destroySession(session, session.closeReason)
        )
        yield* Effect.forkScoped(this.runScheduler(session))
      }).pipe(Scope.extend(session.scheduler.scope))
    )
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
        session.worktreeId,
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
          navigationError: (message, source) => {
            if (
              session.browser !== browser ||
              session.generation !== runtimeGeneration ||
              session.localOwner
            ) {
              return
            }

            if (source === 'video') {
              this.broadcastVideoUnavailable(session, message)
            } else {
              this.broadcastNavigationError(session, message)
            }
          },
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
    })().catch(async (cause) => {
      if (session.generation === runtimeGeneration) {
        await session.browser?.close().catch(() => undefined)
        session.launch = null
        session.browser = null
      }

      throw cause
    })
    session.launch = launch
    return launch
  }

  private browserFor(session: BrowserSession): Promise<BrowserSessionBrowser> {
    return this.ensurePlaywrightRuntime(session)
  }

  private getSession(
    panelId: string
  ): Effect.Effect<BrowserSession, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      if (this.disposed) {
        return yield* Effect.fail(
          new BrowserSchedulingError({
            reason: 'closing',
            message: 'Treeport is shutting down.'
          })
        )
      }

      const authorized =
        yield* this.service.panels.authorizeBrowserPanel(panelId)
      if (this.disposed) {
        return yield* Effect.fail(
          new BrowserSchedulingError({
            reason: 'closing',
            message: 'Treeport is shutting down.'
          })
        )
      }

      const existing = this.sessions.get(panelId)
      if (existing) {
        return existing
      }

      const pending = this.sessionCreations.get(panelId)
      if (pending) {
        return yield* Effect.tryPromise({
          try: () => pending,
          catch: (cause) => cause
        })
      }

      const creation = this.createSession(panelId, authorized).finally(() => {
        if (this.sessionCreations.get(panelId) === creation) {
          this.sessionCreations.delete(panelId)
        }
      })
      this.sessionCreations.set(panelId, creation)
      return yield* Effect.tryPromise({
        try: () => creation,
        catch: (cause) => cause
      })
    })
  }

  accept(
    ticketValue: string,
    transport: BrowserTransport
  ): Effect.Effect<string, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      const ticket = this.tickets.get(ticketValue)
      this.tickets.delete(ticketValue)
      if (!ticket || ticket.expiresAt < Date.now()) {
        return yield* Effect.fail(new Error('INVALID_BROWSER_TICKET'))
      }

      yield* Effect.annotateCurrentSpan({
        'treeport.connection.id': transport.id,
        'treeport.panel.id': ticket.panelId,
        'treeport.client.id': ticket.clientId
      })
      const session = yield* this.getSession(ticket.panelId)
      return yield* Effect.tryPromise({
        try: () => this.acceptSession(ticket, session, transport),
        catch: (cause) => cause
      }).pipe(
        Effect.onInterrupt(() => Effect.sync(() => this.close(transport.id)))
      )
    })
  }

  private async acceptSession(
    ticket: BrowserTicket,
    session: BrowserSession,
    transport: BrowserTransport
  ): Promise<string> {
    const supersededAttachments = [...session.attachments.values()].filter(
      (candidate) => candidate.clientId === ticket.clientId
    )
    if (supersededAttachments.length > 0) {
      networkTelemetry.reconnectNow('browsers')
    }

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
      inFlightFrames: new Map(),
      pendingJpeg: null,
      cursorPoint: null,
      waitingForKeyframe: true,
      viewport: { ...session.state.viewport }
    }
    session.attachments.set(attachment.id, attachment)

    try {
      await this.scheduleOperation(
        session,
        async () => {
          if (attachment.closing || !transport.isConnected()) {
            return
          }

          if (!session.localOwner) {
            await this.browserFor(session)
          }

          if (attachment.closing || !transport.isConnected()) {
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
      if (attachment.closing || !transport.isConnected()) {
        this.close(attachment.id)
        return attachment.id
      }

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

      if (session.videoError) {
        transport.sendMessage({
          type: 'videoUnavailable',
          message: session.videoError
        })
      }

      this.prepareVideoViewer(session, attachment)
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
        installCommand:
          !session.localOwner && usesBrowserContainer()
            ? 'treeport browser install'
            : null
      })
      // Failed launch cleanup belongs to the consumer; overload or shutdown
      // must not close a shared runtime from this attachment's Promise handler.
    }
    return attachment.id
  }

  acceptOwner(
    auth: BrowserOwnerAuth,
    transport: BrowserOwnerTransport
  ): Effect.Effect<string, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      const ticket = this.ownerTickets.get(auth.ticket)
      this.ownerTickets.delete(auth.ticket)
      if (
        !ticket ||
        ticket.expiresAt < Date.now() ||
        ticket.challenge !== auth.challenge ||
        !isSchemaValue(browserOwnerEndpointSchema, auth.endpoint)
      ) {
        return yield* Effect.fail(new Error('INVALID_BROWSER_OWNER_TICKET'))
      }

      yield* Effect.annotateCurrentSpan({
        'treeport.connection.id': transport.id,
        'treeport.panel.id': ticket.panelId,
        'treeport.client.id': ticket.clientId
      })
      const identityResult = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(new URL('identity', auth.endpoint), {
            signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
            redirect: 'error'
          })
          return { response, body: await response.json() }
        },
        catch: (cause) => cause
      })
      const identity = decodeUnknownOrNull(
        browserOwnerIdentitySchema,
        identityResult.body
      )
      if (
        !identityResult.response.ok ||
        !identity ||
        identity.panelId !== ticket.panelId ||
        identity.challenge !== ticket.challenge
      ) {
        return yield* Effect.fail(new Error('INVALID_BROWSER_OWNER_IDENTITY'))
      }

      const session = yield* this.getSession(ticket.panelId)
      return yield* Effect.tryPromise({
        try: () => this.acceptOwnerSession(ticket, auth, session, transport),
        catch: (cause) => cause
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => this.closeOwner(transport.id))
        )
      )
    })
  }

  private async acceptOwnerSession(
    ticket: BrowserOwnerTicket,
    auth: BrowserOwnerAuth,
    session: BrowserSession,
    transport: BrowserOwnerTransport
  ): Promise<string> {
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

        const readiness = Effect.runSync(Deferred.make<void>())
        const resumed = previousOwner?.clientId === ticket.clientId
        if (resumed) {
          networkTelemetry.reconnectNow('browser-owners')
        }

        let owner: BrowserLocalOwner
        if (previousOwner) {
          Deferred.unsafeDone(previousOwner.readiness, Effect.void)
          for (const request of previousOwner.requests.values()) {
            Deferred.unsafeDone(request, Effect.succeed(false))
          }
          previousOwner.requests.clear()

          if (previousOwner.endpoint !== auth.endpoint) {
            await this.closeLocalAutomation(session)
            this.resetVideoDelivery(session)
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
          previousOwner.readiness = readiness
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
            readiness,
            requests: new Map()
          }
          session.localOwner = owner
          session.controllerId = LOCAL_BROWSER_OWNER_CONTROLLER
          this.resetVideoDelivery(session)
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
      const resized =
        session.state.viewport.width !== message.state.viewport.width ||
        session.state.viewport.height !== message.state.viewport.height
      session.state = message.state
      this.queuePanelState(session, message.state)
      this.broadcastState(session)

      const becameReady = message.type === 'ready' && !owner.ready
      if (becameReady) {
        owner.ready = true
        Deferred.unsafeDone(owner.readiness, Effect.void)
      }

      if (becameReady || (resized && owner.ready)) {
        const accepted = this.enqueueOperation(session, {
          coalesceKey: `screencast:${session.panelId}`,
          message: null,
          required: true,
          execute: () =>
            this.updateScreencast(session).catch((cause) =>
              this.broadcastVideoUnavailable(
                session,
                cause instanceof Error ? cause.message : String(cause)
              )
            )
        })
        if (!accepted) {
          this.broadcastVideoUnavailable(
            session,
            session.scheduler.accepting
              ? 'The Browser command queue is full. Wait and try again.'
              : 'The Browser session is closing.'
          )
        }
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
    Deferred.unsafeDone(
      request,
      Effect.succeed(
        message.type === 'runtimeControlResult'
          ? message.accepted
          : message.canClose
      )
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
    Deferred.unsafeDone(owner.readiness, Effect.void)
    for (const request of owner.requests.values()) {
      Deferred.unsafeDone(request, Effect.succeed(false))
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
    Deferred.unsafeDone(owner.readiness, Effect.void)
    for (const request of owner.requests.values()) {
      Deferred.unsafeDone(request, Effect.succeed(false))
    }
    owner.requests.clear()
    await this.closeLocalAutomation(session)
    session.generation += 1
    this.resetVideoDelivery(session)
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
          installCommand: usesBrowserContainer()
            ? 'treeport browser install'
            : null
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
    return Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Deferred.make<boolean>()
        owner.requests.set(requestId, result)
        if (
          !owner.transport.send({
            ...message,
            generation: owner.generation,
            requestId
          })
        ) {
          return false
        }

        return yield* Deferred.await(result).pipe(
          Effect.timeoutTo({
            duration: '5 seconds',
            onSuccess: (accepted) => accepted,
            onTimeout: () => false
          })
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            owner.requests.delete(requestId)
          })
        )
      )
    )
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

  private prepareVideoViewer(
    session: BrowserSession,
    attachment: BrowserAttachment
  ): void {
    if (!attachment.visible || !attachment.transport.isConnected()) {
      return
    }

    attachment.waitingForKeyframe = true
    // A cached delta frame is not independently decodable. Request a new keyframe
    // even for a static page; the capture document retains one raw frame for this.
    this.requestVideoKeyframe(session)
  }

  private requestVideoKeyframe(session: BrowserSession): void {
    if (
      ![...session.attachments.values()].some(
        (attachment) => attachment.visible && attachment.transport.isConnected()
      )
    ) {
      return
    }

    const delay = 250 - (Date.now() - session.keyframeRequestedAt)
    if (delay > 0) {
      session.keyframeTimer ??= setTimeout(() => {
        session.keyframeTimer = null
        if (this.sessions.get(session.panelId) === session) {
          this.requestVideoKeyframe(session)
        }
      }, delay)
      session.keyframeTimer.unref()
      return
    }

    session.keyframeRequestedAt = Date.now()
    const operation = session.localOwner
      ? session.localAutomation?.video.send('Treeport.requestVideoKeyframe')
      : session.browser?.requestVideoKeyframe()
    void operation?.catch((cause) =>
      this.broadcastNavigationError(
        session,
        cause instanceof Error ? cause.message : String(cause)
      )
    )
  }

  private publishFrame(
    session: BrowserSession,
    value: Omit<BrowserFrame, 'sequence'>
  ): void {
    if (value.data.byteLength > BROWSER_MAX_FRAME_BYTES) {
      return
    }

    session.videoError = null
    const frame: BrowserFrame = {
      ...value,
      sequence: ++session.sequence
    }
    for (const attachment of session.attachments.values()) {
      if (!attachment.visible || !attachment.transport.isConnected()) {
        continue
      }

      // JPEGs are independent: retain only the newest image while the viewer
      // decodes its current one. VP8 still needs its ordered reference frames.
      if (
        frame.mimeType === 'image/jpeg' &&
        attachment.inFlightFrames.size > 0
      ) {
        attachment.pendingJpeg = frame
        networkTelemetry.droppedNow('browsers', 'coalesced')
        continue
      }

      attachment.pendingJpeg = null
      if (
        attachment.inFlightFrames.size >= 8 ||
        (attachment.waitingForKeyframe && !frame.keyframe)
      ) {
        attachment.waitingForKeyframe = true
        networkTelemetry.droppedNow('browsers', 'coalesced')
        continue
      }

      if (attachment.transport.sendFrame(frame)) {
        attachment.waitingForKeyframe = false
        attachment.inFlightFrames.set(frame.sequence, Date.now())
      } else {
        attachment.waitingForKeyframe = true
        this.requestVideoKeyframe(session)
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

    if (message.type === 'requestVideoKeyframe') {
      if (attachment.visible) {
        attachment.waitingForKeyframe = true
        this.requestVideoKeyframe(session)
      }

      return
    }

    if (message.type === 'frameAck') {
      const sentAt = attachment.inFlightFrames.get(message.sequence)
      if (sentAt === undefined) {
        return
      }

      attachment.inFlightFrames.delete(message.sequence)
      networkTelemetry.durationNow('browsers', 'ack_lag', Date.now() - sentAt)
      const pending = attachment.pendingJpeg
      if (pending && attachment.inFlightFrames.size === 0) {
        attachment.pendingJpeg = null
        if (attachment.visible && attachment.transport.isConnected()) {
          if (attachment.transport.sendFrame(pending)) {
            attachment.waitingForKeyframe = false
            attachment.inFlightFrames.set(pending.sequence, Date.now())
          } else {
            attachment.waitingForKeyframe = true
          }
        }
      }

      if (attachment.visible && attachment.waitingForKeyframe) {
        this.requestVideoKeyframe(session)
      }

      return
    }

    if (message.type === 'setVisible') {
      attachment.visible = message.visible
      attachment.inFlightFrames.clear()
      attachment.pendingJpeg = null
      attachment.waitingForKeyframe = true
      if (message.visible) {
        this.prepareVideoViewer(session, attachment)
      }

      this.queueClientOperation(session, attachment, {
        coalesceKey: null,
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
      const scheduler = session.scheduler
      const key = `take-control:${attachment.id}`
      const viewport = attachment.viewport
      if (
        scheduler.accepting &&
        (scheduler.controlKey === key ||
          (!scheduler.active &&
            scheduler.pending.size === 0 &&
            session.controllerId === attachmentController(attachment.clientId)))
      ) {
        networkTelemetry.droppedNow('browsers', 'coalesced')
        return
      }

      this.queueClientOperation(session, attachment, {
        coalesceKey: `take-control:${attachment.id}`,
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
          // Input bursts request control repeatedly; ownership already held
          // must not resize the page or restart its video stream.
          if (previousController === nextController) {
            return
          }

          try {
            if (session.localOwner) {
              await this.updateScreencast(session, nextController)
            } else {
              const browser = await this.browserFor(session)
              await browser.command({ type: 'resize', ...viewport })
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

          if (queuedMessage.type === 'pointer') {
            attachment.cursorPoint = { x: queuedMessage.x, y: queuedMessage.y }
          }

          if (
            attachment.cursorPoint &&
            (queuedMessage.type === 'pointer' || queuedMessage.type === 'wheel')
          ) {
            const cursor = await (
              localOwner
                ? browserCursor(
                    (await this.ensureLocalAutomation(session, localOwner))
                      .page,
                    attachment.cursorPoint
                  )
                : (await this.browserFor(session)).cursor(
                    attachment.cursorPoint
                  )
            ).catch(() => 'default' as const)
            attachment.transport.sendMessage({ type: 'cursor', cursor })
          }
        } catch (cause) {
          attachment.transport.sendMessage({
            type: 'navigationError',
            message: cause instanceof Error ? cause.message : String(cause)
          })
        }
      },
      // Reserve admission capacity for releases after accepting their presses.
      required:
        (message.type === 'key' || message.type === 'pointer') &&
        message.phase === 'up'
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
    if (visible) {
      session.videoError = null
    }

    await browser
      ?.setScreencasting(visible)
      .catch((cause) =>
        this.broadcastVideoUnavailable(
          session,
          cause instanceof Error ? cause.message : String(cause)
        )
      )
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

    this.resetVideoDelivery(session)
    await fs.rm(session.agentDirectory, { recursive: true, force: true })
    await fs.mkdir(session.agentDirectory, { recursive: true, mode: 0o700 })
    await fs.chmod(session.agentDirectory, 0o700)
  }

  private destroySession(
    session: BrowserSession,
    reason: string
  ): Effect.Effect<void> {
    return Effect.scoped(
      Effect.gen(this, function* () {
        // Each owned resource is released even if an earlier release fails.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            this.resetVideoDelivery(session)
            if (this.sessions.get(session.panelId) === session) {
              this.sessions.delete(session.panelId)
            }

            const owner = session.localOwner
            session.localOwner = null
            if (owner) {
              Deferred.unsafeDone(owner.readiness, Effect.void)
              for (const request of owner.requests.values()) {
                Deferred.unsafeDone(request, Effect.succeed(false))
              }
              owner.requests.clear()
              owner.transport.send({ type: 'closed', reason })
              owner.transport.disconnect()
            }

            for (const attachment of session.attachments.values()) {
              attachment.closing = true
              attachment.transport.sendMessage({ type: 'closed', reason })
              attachment.transport.disconnect()
            }
            session.attachments.clear()
          })
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            fs.rm(session.agentDirectory, { recursive: true, force: true })
          )
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            session.launch || session.browser
              ? this.closePlaywrightRuntime(session)
              : this.detachAgent(session)
          )
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => this.closeLocalAutomation(session))
        )
        yield* Effect.promise(() => this.waitForPanelState(session))
      })
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
          // Still ask a reachable owner to close its guest, but an explicit
          // force-close must not depend on a disconnected or stalled owner.
          canClose =
            (await this.requestLocalOwner(session.localOwner, {
              type: 'closeRequest',
              force
            })) || force
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
    if (session.localOwner) {
      this.closeOwner(session.localOwner.transport.id)
    }

    session.closeReason = reason
    if (session.scheduler.active) {
      Deferred.unsafeDone(
        session.scheduler.active.completion,
        Effect.fail(
          new BrowserSchedulingError({ reason: 'closing', message: reason })
        )
      )
    }

    const closeOperation = Effect.runPromise(
      Scope.close(session.scheduler.scope, Exit.void)
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
    }

    const launch = (async () => {
      if (current) {
        await current.video.send('Treeport.stopVideo').catch(() => undefined)
        await current.cdp.detach().catch(() => undefined)
        await current.browser.close().catch(() => undefined)
      }

      if (!owner.ready) {
        await Effect.runPromise(
          Deferred.await(owner.readiness).pipe(
            Effect.timeoutFail({
              duration: '15 seconds',
              onTimeout: () =>
                new Error(
                  'The visible local Browser did not become ready within 15 seconds.'
                )
            })
          )
        )
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
      // SAFETY: The verified exact-guest Electron CDP bridge implements this
      // private domain. Arbitrary remote CDP endpoints are not accepted here.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions -- This private Electron domain extends Playwright's fixed Chromium command table.
      const video = cdp as unknown as BrowserVideoCdpSession
      video.on('Treeport.videoFrame', ({ payload }) => {
        if (
          session.localOwner !== owner ||
          session.localAutomation?.generation !== owner.generation ||
          !session.localAutomation.screencasting
        ) {
          return
        }

        receiveBrowserVideo(
          payload,
          (frame) => this.publishFrame(session, frame),
          (message) => {
            automation.screencasting = false
            void video.send('Treeport.stopVideo').catch(() => undefined)
            this.broadcastVideoUnavailable(session, message)
          }
        )
      })
      const automation: BrowserLocalAutomation = {
        browser,
        page,
        cdp,
        video,
        generation: owner.generation,
        console: [],
        requests: [],
        screencasting: false,
        captureViewport: null
      }
      browser.once('disconnected', () => {
        if (session.localAutomation !== automation) {
          return
        }

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
      await automation.video.send('Treeport.stopVideo').catch(() => undefined)
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

    // The session consumer owns screencast ordering, including stop/start pairs.
    const width = Math.max(1, session.state.viewport.width || 1_280)
    const height = Math.max(1, session.state.viewport.height || 800)
    if (
      session.localOwner !== owner ||
      session.localAutomation !== automation ||
      (automation.screencasting === enabled &&
        (!enabled ||
          (automation.captureViewport?.width === width &&
            automation.captureViewport.height === height)))
    ) {
      return
    }

    if (enabled && automation.screencasting) {
      await automation.video.send('Treeport.stopVideo')
    }

    automation.screencasting = enabled
    automation.captureViewport = enabled ? { width, height } : null
    if (!enabled) {
      await automation.video.send('Treeport.stopVideo').catch(() => undefined)
      return
    }

    session.videoError = null
    await automation.video
      .send('Treeport.startVideo', { width, height })
      .catch((cause) => {
        automation.screencasting = false
        this.broadcastVideoUnavailable(
          session,
          cause instanceof Error ? cause.message : String(cause)
        )
      })
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

  agentCommand(
    panelId: string,
    input: BrowserAgentCommand
  ): Effect.Effect<string, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      const session = yield* this.getSession(panelId)
      return yield* Effect.tryPromise({
        try: () => this.runAgentCommand(panelId, input, session),
        catch: (cause) => cause
      })
    })
  }

  private async runAgentCommand(
    panelId: string,
    input: BrowserAgentCommand,
    session: BrowserSession
  ): Promise<string> {
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
      let completed = false
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
        if (previousController !== 'agent') {
          this.broadcastState(session, 'controlChanged')
        }

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
        completed = true
      } catch (cause) {
        if (!localOwner) {
          session.agentAttached = false
        }

        throw cause
      } finally {
        // Ownership spans commands, not HTTP requests. A successful command
        // keeps the same owner until explicit takeover, close or runtime loss.
        // On failure, restore human control instead of leaving a stale lock.
        if (agentControlled && !completed) {
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
    if (!usesBrowserContainer()) {
      throw new Error(
        'Install Google Chrome on this computer. Treeport uses it directly without Docker.'
      )
    }

    if (!this.installing) {
      this.installing = new BrowserContainer(
        this.browserHost.profilePath,
        this.cachePath
      )
        .install()
        .then(
          () =>
            'Browser image is ready. Open Browser to start it. Restart Treeport to apply updates to an already-running browser.'
        )
        .finally(() => {
          this.installing = null
        })
    }

    return this.installing
  }

  dispose(): Promise<void> {
    if (this.disposing) {
      return this.disposing
    }

    this.disposed = true
    this.disposing = this.disposeSessions()
    return this.disposing
  }

  private async disposeSessions(): Promise<void> {
    this.unsubscribe()
    this.tickets.clear()
    this.ownerTickets.clear()
    await Promise.all(
      [...this.sessionCreations.values()].map((creation) =>
        creation.catch(() => null)
      )
    )
    await Effect.runPromise(
      Effect.all(
        [...this.sessions.keys()].map((panelId) =>
          Effect.promise(() =>
            this.closePanel(panelId, 'Treeport is shutting down.')
          ).pipe(Effect.exit)
        ),
        { concurrency: 'unbounded' }
      ).pipe(
        Effect.flatMap((results) =>
          Effect.forEach(results, (result) => result)
        ),
        Effect.asVoid,
        Effect.ensuring(Effect.promise(() => this.browserHost.close()))
      )
    )
  }
}
