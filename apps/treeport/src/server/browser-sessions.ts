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
  FileChooser,
  Page
} from 'playwright'
import type {
  BrowserAgentCommand,
  BrowserClientMessage,
  BrowserApp,
  BrowserOwnerAuth,
  BrowserOwnerClientMessage,
  BrowserOwnerServerMessage,
  BrowserServerMessage,
  BrowserRuntimeState,
  BrowserSessionState,
  BrowserNativeCdpSession,
  BrowserClipboard,
  BrowserVideoSettings
} from '@treeport/shared'
import {
  browserClipboardSchema,
  DEFAULT_BROWSER_VIDEO_SETTINGS,
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
  type BrowserInstallStatus,
  type PlaywrightBrowserCallbacks
} from './playwright-browser'
import { browserNavigation } from './browser-navigation'
import { PlaywrightBrowserHost } from './browser-page-host'
import { BrowserVideoViewer } from './browser-video-viewer'
import { browserKey, browserTouch, browserWheel } from './browser-input'
import { browserSetupGuidance } from './browser-runtime'

import { browserCursor } from './browser-cursor'
import type { AuthenticatedViewer } from './request-security'

export interface BrowserTransport {
  id: string
  isConnected(): boolean
  sendMessage(message: BrowserServerMessage): boolean
  sendFrame?(data: Uint8Array): boolean
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
  apps: Pick<
    TreeportService['apps'],
    'authorizeBrowserApp' | 'openBrowserAppFromApp' | 'updateBrowserAppState'
  >
  events: Pick<TreeportService['events'], 'subscribe'>
}

export type BrowserSessionConfig = Pick<
  AppConfig,
  'cacheDir' | 'dataDir' | 'runtimeDir'
>

export interface BrowserSessionBrowser {
  readonly webcodecs?: boolean
  webcodecsViewer?(
    peerId: string
  ): ReturnType<PlaywrightBrowser['webcodecsViewer']>
  readonly state: BrowserRuntimeState
  launch(): Promise<void>
  command(
    message: BrowserClientMessage
  ): ReturnType<PlaywrightBrowser['command']>
  copy(): Promise<BrowserClipboard | null>
  cursor(point: { x: number; y: number }): ReturnType<typeof browserCursor>
  agentCommand(input: BrowserAgentCommand): Promise<string>
  setScreencasting(
    enabled: boolean,
    settings: BrowserVideoSettings
  ): Promise<void>
  negotiateVideo(peerId: string, sdp: string): Promise<string>
  closeVideoPeer(peerId: string): Promise<void>
  devtoolsEndpoint?(): Promise<string>
  requestClose(force: boolean): Promise<boolean>
  close(): Promise<void>
}

export type BrowserSessionBrowserFactory = (
  host: PlaywrightBrowserHost,
  workspacePath: string,
  title: string,
  appId: string,
  worktreeId: string,
  callbacks: PlaywrightBrowserCallbacks
) => BrowserSessionBrowser

interface BrowserAgentTarget {
  appId: string
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
  appId: string
  viewerId: string
  identity: AuthenticatedViewer | null
  visible: boolean
  expiresAt: number
}

interface BrowserOwnerTicket {
  appId: string
  viewerId: string
  challenge: string
  expiresAt: number
}

type BrowserOwnerRequest = Deferred.Deferred<boolean>

interface BrowserLocalAutomation {
  browser: PlaywrightConnection
  page: Page
  cdp: CDPSession
  video: BrowserNativeCdpSession
  generation: number
  console: string[]
  requests: string[]
  screencasting: boolean
  captureViewport: { width: number; height: number } | null
  captureSettings: BrowserVideoSettings | null
  fileChooser(chooser: FileChooser): void
}

interface BrowserLocalOwner {
  transport: BrowserOwnerTransport
  viewerId: string
  endpoint: string
  challenge: string
  generation: number
  revision: number
  ready: boolean
  controller: 'other' | 'none'
  viewport: { width: number; height: number } | null
  retainPaint: boolean
  agentActive: boolean
  readiness: Deferred.Deferred<void>
  requests: Map<string, BrowserOwnerRequest>
}

interface BrowserAttachment {
  // A connection is ephemeral; a viewer survives reconnects and reloads.
  id: string
  viewerId: string
  identity: AuthenticatedViewer | null
  transport: BrowserTransport
  visible: boolean
  closing: boolean
  video: BrowserVideoViewer
  cursorPoint: { x: number; y: number } | null
  cursorUpdate: Promise<void> | null
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
  active: Set<BrowserScheduledOperation>
  tail: BrowserScheduledOperation | null
  controlKey: string | null
  accepting: boolean
}

interface BrowserAppStatePersistence {
  persistedUrl: string
  persistedTitle: string
  pending: { url: string; title: string } | null
  write: Promise<void> | null
  ready: boolean
}

interface BrowserSession {
  appId: string
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
  clipboardInput: { attachment: BrowserAttachment; expiresAt: number } | null
  fileChooserInput: { attachment: BrowserAttachment; expiresAt: number } | null
  fileChooser: {
    id: string
    submitted: boolean
    chooser: FileChooser
    attachment: BrowserAttachment
    generation: number
    timer: ReturnType<typeof setTimeout>
  } | null
  touchAttachmentId: string | null
  touchIds: Set<number>
  agentActive: boolean
  retainLocalAgentPaint: boolean
  state: BrowserRuntimeState
  videoError: string | null
  videoSettings: BrowserVideoSettings
  scheduler: BrowserScheduler
  persistence: BrowserAppStatePersistence
  agentAttached: boolean
  agentSessionName: string | null
  agentProcess: ChildProcess | null
  crashMessage: string | null
  closing: boolean
  closeApproved: boolean
  closeRequest: Promise<boolean> | null
  closeOperation: Promise<void> | null
  closeReason: string
}

const MAX_BROWSER_ATTACHMENTS = 8
const MAX_BROWSER_TICKETS = 256
const LOCAL_BROWSER_OWNER_CONTROLLER = 'local-owner'
// Control follows the viewer; socket IDs govern cleanup. Account/device metadata
// describes the controller but must not change who a reconnecting viewer is.
const attachmentController = (viewer: Pick<BrowserAttachment, 'viewerId'>) =>
  `attachment:${viewer.viewerId}`
const MAX_BROWSER_SCHEDULED_OPERATIONS = 64
const MAX_BROWSER_REGULAR_OPERATIONS = 46
const defaultBrowserFactory: BrowserSessionBrowserFactory = (
  host,
  workspacePath,
  _title,
  appId,
  _worktreeId,
  callbacks
) =>
  new PlaywrightBrowser(
    host,
    workspacePath,
    callbacks,
    process.env.TREEPORT_WEBCODECS_APP_ID === appId
  )

const DEFAULT_STATE: BrowserRuntimeState = {
  url: 'about:blank',
  title: '',
  faviconUrl: null,
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
      path.join(config.dataDir, 'browser-profile-chrome')
    )
    this.unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'app.removed') {
        this.service.forkApplicationEffect(
          Effect.tryPromise({
            try: () => this.closeApp(String(event.data.appId), 'App closed'),
            catch: (cause) => cause
          }).pipe(
            Effect.catchAll((error) =>
              Effect.logError('Failed to close a removed Browser app').pipe(
                Effect.annotateLogs({ cause: String(error) })
              )
            )
          )
        )
      } else if (event.type === 'worktree.removed' && event.data.worktreeId) {
        for (const session of this.sessions.values()) {
          this.service.forkApplicationEffect(
            this.service.apps.authorizeBrowserApp(session.appId).pipe(
              Effect.catchAll(() =>
                Effect.tryPromise({
                  try: () => this.closeApp(session.appId, 'Worktree removed'),
                  catch: (cause) => cause
                })
              ),
              Effect.catchAll((error) =>
                Effect.logError(
                  `Failed to close Browser app ${session.appId} after its tree was removed`
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
    appId: string,
    viewerId: string,
    visible = true,
    identity: AuthenticatedViewer | null = null
  ): Effect.Effect<string, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      yield* this.service.apps.authorizeBrowserApp(appId)
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
        appId,
        viewerId,
        identity,
        visible,
        expiresAt: Date.now() + 30_000
      })
      return ticket
    })
  }

  devtoolsEndpoint(
    appId: string
  ): Effect.Effect<string, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      yield* this.service.apps.authorizeBrowserApp(appId)
      const browser = this.sessions.get(appId)?.browser
      const endpoint = browser?.devtoolsEndpoint?.()
      if (!endpoint) {
        return yield* Effect.fail(
          new Error('The hosted browser page is not available.')
        )
      }

      return yield* Effect.tryPromise(() => endpoint)
    })
  }

  issueOwnerTicket(
    appId: string,
    viewerId: string
  ): Effect.Effect<
    { ticket: string; challenge: string },
    unknown,
    ApplicationServices
  > {
    return Effect.gen(this, function* () {
      yield* this.service.apps.authorizeBrowserApp(appId)
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
      const currentOwner = this.sessions.get(appId)?.localOwner
      const challenge =
        currentOwner?.viewerId === viewerId
          ? currentOwner.challenge
          : crypto.randomBytes(32).toString('base64url')
      this.ownerTickets.set(ticket, {
        appId,
        viewerId,
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
    const controller = [...session.attachments.values()].find(
      (candidate) =>
        !candidate.closing &&
        candidate.transport.isConnected() &&
        attachmentController(candidate) === session.controllerId
    )
    const local =
      session.controllerId === LOCAL_BROWSER_OWNER_CONTROLLER &&
      session.localOwner !== null
    const identity: AuthenticatedViewer | null =
      controller?.identity ??
      (local
        ? {
            account: {
              source: 'local',
              login: null,
              name: null,
              profilePicture: null
            },
            deviceId: 'local'
          }
        : null)
    const sameAccount =
      identity?.account.source === 'tailscale' &&
      attachment.identity?.account.source === 'tailscale' &&
      identity.account.login !== null &&
      identity.account.login === attachment.identity.account.login
    const sameDevice =
      identity !== null &&
      identity.deviceId !== null &&
      identity.deviceId === attachment.identity?.deviceId

    return {
      ...session.state,
      videoSettings: session.browser?.webcodecs
        ? { captureScale: 1, frameRate: 60, maxBitrate: 8_000_000 }
        : session.videoSettings,
      controlled: session.controllerId === attachmentController(attachment),
      hasController:
        session.localOwner !== null || session.controllerId !== null,
      controller:
        session.controllerId === attachmentController(attachment)
          ? 'you'
          : session.localOwner || session.controllerId
            ? 'other'
            : 'none',
      controllerDetails:
        controller || local
          ? {
              kind: local ? 'local' : 'viewer',
              account: identity?.account ?? null,
              sameAccount,
              sameDevice
            }
          : null,
      agentActive: session.agentActive
    }
  }

  private closeFileChooser(
    session: BrowserSession,
    error: string | null = null
  ): void {
    const pending = session.fileChooser
    session.fileChooser = null
    if (!pending) {
      return
    }

    clearTimeout(pending.timer)
    pending.attachment.transport.sendMessage({
      type: 'fileChooserClosed',
      requestId: pending.id,
      error
    })
    void pending.chooser
      .element()
      .dispose()
      .catch(() => undefined)
  }

  private openFileChooser(
    session: BrowserSession,
    chooser: FileChooser | null
  ): void {
    this.closeFileChooser(session)
    if (!chooser) {
      session.fileChooserInput = null
      return
    }

    // Only a recent action from the exact controlling socket can open a picker.
    const input = session.fileChooserInput
    const attachment = input?.attachment
    if (
      !input ||
      !attachment ||
      Date.now() > input.expiresAt ||
      session.closing ||
      session.agentActive ||
      attachment.closing ||
      !attachment.visible ||
      session.attachments.get(attachment.id) !== attachment ||
      session.controllerId !== attachmentController(attachment)
    ) {
      void chooser
        .element()
        .dispose()
        .catch(() => undefined)
      return
    }

    const pending = {
      id: crypto.randomUUID(),
      submitted: false,
      chooser,
      attachment,
      generation: session.generation,
      timer: setTimeout(
        () =>
          this.closeFileChooser(
            session,
            'File selection expired. Open the file picker again.'
          ),
        5 * 60_000
      )
    }
    session.fileChooser = pending
    void chooser
      .element()
      .evaluate((element) => ({
        accept: element instanceof HTMLInputElement ? element.accept : '',
        directory:
          element instanceof HTMLInputElement && element.webkitdirectory
      }))
      .then(({ accept, directory }) => {
        if (session.fileChooser !== pending) {
          return
        }

        if (directory) {
          this.closeFileChooser(
            session,
            'Folder uploads are not supported. Choose individual files instead.'
          )
          return
        }

        attachment.transport.sendMessage({
          type: 'fileChooser',
          requestId: pending.id,
          multiple: chooser.isMultiple(),
          accept: accept.slice(0, 4_096)
        })
      })
      .catch(() => {
        if (session.fileChooser === pending) {
          this.closeFileChooser(
            session,
            'The file input is no longer available.'
          )
        }
      })
  }

  private broadcastState(
    session: BrowserSession,
    type: 'state' | 'controlChanged' = 'state'
  ): void {
    const pending = session.fileChooser
    if (
      pending &&
      (session.closing ||
        session.agentActive ||
        session.generation !== pending.generation ||
        pending.attachment.closing ||
        !pending.attachment.visible ||
        session.attachments.get(pending.attachment.id) !== pending.attachment ||
        session.controllerId !== attachmentController(pending.attachment))
    ) {
      this.closeFileChooser(session)
    }

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
    const wheelDirectionChanged =
      existing?.message?.type === 'wheel' &&
      input.message?.type === 'wheel' &&
      (Math.sign(existing.message.deltaX) !== Math.sign(input.message.deltaX) ||
        Math.sign(existing.message.deltaY) !== Math.sign(input.message.deltaY))
    if (
      input.coalesceKey &&
      existing?.coalesceKey === input.coalesceKey &&
      !wheelDirectionChanged
    ) {
      if (
        existing.message?.type === 'wheel' &&
        input.message?.type === 'wheel'
      ) {
        existing.message = {
          ...input.message,
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
    const wheelFlights = new Set<Promise<void>>()
    let wheelKey: string | null = null
    return Effect.forever(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(this, function* () {
          const operation = yield* restore(Queue.take(scheduler.queue))
          const wheel =
            operation.message?.type === 'wheel' ? operation.message : null
          // Reversals cannot merge, but may be submitted in order without
          // draining ACKs. Tiny sideways trackpad changes otherwise stall the
          // entire gesture. browserWheel keeps preparation and dispatch ordered.
          if (!wheel || operation.coalesceKey !== wheelKey) {
            // Clicks, coordinates/modifiers, controllers, navigation and all
            // lifecycle work are barriers. Only adjacent compatible wheels
            // may overlap, and shutdown still owns their actual settlement.
            yield* Effect.promise(() => Promise.all(wheelFlights))
            wheelKey = wheel ? operation.coalesceKey : null
          } else if (wheelFlights.size >= (wheel.modifiers === 0 ? 8 : 2)) {
            // CDP wheel ACKs include a compositor round trip. Allow roughly
            // 100 ms at 60 Hz for plain scrolling. Keep modified/zoom gestures
            // at their existing limit and retain non-wheel barriers.
            yield* Effect.promise(() => Promise.race(wheelFlights))
          }

          if (!scheduler.pending.delete(operation)) {
            return
          }

          scheduler.active.add(operation)
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
          const running = Effect.runPromise(
            Effect.gen(this, function* () {
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
              scheduler.active.delete(operation)
              if (Exit.isFailure(result) && !operation.result) {
                this.broadcastNavigationError(session, String(result.cause))
              }

              networkTelemetry.durationNow(
                'browsers',
                'operation',
                Date.now() - started
              )
            })
          )
          if (wheel) {
            wheelFlights.add(running)
            void running.then(() => wheelFlights.delete(running))
          } else {
            yield* Effect.promise(() => running)
          }
        })
      )
    ).pipe(Effect.ensuring(Effect.promise(() => Promise.all(wheelFlights))))
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
      attachment.video.fail(message)
    }
  }

  private resetVideoDelivery(session: BrowserSession): void {
    session.videoError = null
    for (const attachment of session.attachments.values()) {
      attachment.video.suspend()
    }
  }

  private openPopup(session: BrowserSession, url: string): void {
    this.service.forkApplicationEffect(
      this.service.apps.openBrowserAppFromApp(session.appId, url).pipe(
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

  private queueAppState(
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
            const app = yield* this.service.apps.updateBrowserAppState(
              session.appId,
              pending
            )
            persistence.persistedUrl = app.url
            persistence.persistedTitle = app.title
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
        this.queueAppState(session, pending)
      }
    })
  }

  private async waitForAppState(session: BrowserSession): Promise<void> {
    while (session.persistence.write) {
      await session.persistence.write
    }
  }

  private async createSession(
    appId: string,
    authorized: { app: BrowserApp; worktreePath: string }
  ): Promise<BrowserSession> {
    const restoredUrl =
      authorized.app.url === 'about:blank'
        ? null
        : (decodeUnknownOrNull(browserObservedUrlSchema, authorized.app.url) ??
          'about:blank')
    const agentDirectory = path.join(this.config.runtimeDir, 'browsers', appId)
    await fs.rm(agentDirectory, { recursive: true, force: true })
    await fs.mkdir(agentDirectory, { recursive: true, mode: 0o700 })
    await fs.chmod(agentDirectory, 0o700)
    const session: BrowserSession = {
      appId,
      worktreeId: authorized.app.worktreeId,
      agentDirectory,
      title: `Treeport ${authorized.app.title}`,
      browser: null,
      launch: null,
      localOwner: null,
      localAutomation: null,
      localAutomationLaunch: null,
      generation: 0,
      attachments: new Map(),
      controllerId: null,
      clipboardInput: null,
      fileChooserInput: null,
      fileChooser: null,
      touchAttachmentId: null,
      touchIds: new Set(),
      agentActive: false,
      retainLocalAgentPaint: false,
      state: {
        ...DEFAULT_STATE,
        url: restoredUrl ?? DEFAULT_STATE.url,
        title: authorized.app.title === 'Browser' ? '' : authorized.app.title,
        viewport: { ...DEFAULT_STATE.viewport }
      },
      videoError: null,
      videoSettings: DEFAULT_BROWSER_VIDEO_SETTINGS,
      scheduler: {
        queue: Effect.runSync(Queue.dropping(MAX_BROWSER_SCHEDULED_OPERATIONS)),
        scope: Effect.runSync(Scope.make()),
        pending: new Set(),
        active: new Set(),
        tail: null,
        controlKey: null,
        accepting: true
      },
      persistence: {
        persistedUrl: authorized.app.url,
        persistedTitle: authorized.app.title,
        pending: null,
        write: null,
        ready: true
      },
      agentAttached: false,
      agentSessionName: null,
      agentProcess: null,
      crashMessage: null,
      closing: false,
      closeApproved: false,
      closeRequest: null,
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
    this.sessions.set(appId, session)
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
        session.appId,
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

            if (session.state.url !== state.url) {
              session.clipboardInput = null
            }

            session.state = state
            this.queueAppState(session, state)
            this.broadcastState(session)
          },
          fileChooser: (chooser) => {
            if (
              session.browser === browser &&
              session.generation === runtimeGeneration &&
              !session.localOwner
            ) {
              this.openFileChooser(session, chooser)
            } else {
              void chooser
                ?.element()
                .dispose()
                .catch(() => undefined)
            }
          },
          clipboard: (clipboard) => {
            const input = session.clipboardInput
            if (
              !runtimeReady ||
              session.browser !== browser ||
              session.generation !== runtimeGeneration ||
              session.localOwner ||
              session.closing ||
              session.agentActive ||
              !input ||
              Date.now() > input.expiresAt ||
              input.attachment.closing ||
              !input.attachment.visible ||
              session.attachments.get(input.attachment.id) !==
                input.attachment ||
              session.controllerId !== attachmentController(input.attachment)
            ) {
              return false
            }

            session.clipboardInput = null
            return input.attachment.transport.sendMessage({
              type: 'clipboardWrite',
              clipboard
            })
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

            this.closeFileChooser(session)
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
      this.queueAppState(session, session.state)
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
    appId: string
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

      const authorized = yield* this.service.apps.authorizeBrowserApp(appId)
      if (this.disposed) {
        return yield* Effect.fail(
          new BrowserSchedulingError({
            reason: 'closing',
            message: 'Treeport is shutting down.'
          })
        )
      }

      const existing = this.sessions.get(appId)
      if (existing) {
        return existing
      }

      const pending = this.sessionCreations.get(appId)
      if (pending) {
        return yield* Effect.tryPromise({
          try: () => pending,
          catch: (cause) => cause
        })
      }

      const creation = this.createSession(appId, authorized).finally(() => {
        if (this.sessionCreations.get(appId) === creation) {
          this.sessionCreations.delete(appId)
        }
      })
      this.sessionCreations.set(appId, creation)
      return yield* Effect.tryPromise({
        try: () => creation,
        catch: (cause) => cause
      })
    })
  }

  accept(
    ticketValue: string,
    transport: BrowserTransport,
    identity: AuthenticatedViewer | null = null
  ): Effect.Effect<string, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      const ticket = this.tickets.get(ticketValue)
      this.tickets.delete(ticketValue)
      if (
        !ticket ||
        ticket.expiresAt < Date.now() ||
        (ticket.identity !== null &&
          (identity === null ||
            ticket.identity.account.source !== identity.account.source ||
            ticket.identity.account.login !== identity.account.login ||
            ticket.identity.deviceId !== identity.deviceId))
      ) {
        return yield* Effect.fail(new Error('INVALID_BROWSER_TICKET'))
      }

      yield* Effect.annotateCurrentSpan({
        'treeport.connection.id': transport.id,
        'treeport.app.id': ticket.appId,
        'treeport.client.id': ticket.viewerId
      })
      const session = yield* this.getSession(ticket.appId)
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
      (candidate) =>
        attachmentController(candidate) === attachmentController(ticket)
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
      viewerId: ticket.viewerId,
      identity: ticket.identity,
      transport,
      visible: ticket.visible,
      closing: false,
      video: new BrowserVideoViewer(
        (message) => transport.sendMessage(message),
        (data) =>
          !attachment.closing &&
          attachment.visible &&
          session.controllerId === attachmentController(attachment) &&
          (transport.sendFrame?.(data) ?? false)
      ),
      cursorPoint: null,
      cursorUpdate: null,
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
            superseded.video.dispose()
            session.attachments.delete(superseded.id)
            superseded.transport.disconnect()
          }

          if (attachment.visible && session.controllerId === null) {
            session.controllerId = attachmentController(attachment)
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
      attachment.video.dispose()
      session.attachments.delete(attachment.id)
      if (
        session.controllerId === attachmentController(attachment) &&
        ![...session.attachments.values()].some(
          (candidate) =>
            attachmentController(candidate) === attachmentController(attachment)
        )
      ) {
        session.controllerId = session.localOwner
          ? LOCAL_BROWSER_OWNER_CONTROLLER
          : null
      }

      transport.sendMessage({
        type: 'browserUnavailable',
        message: error instanceof Error ? error.message : String(error),
        installCommand: null
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
        'treeport.app.id': ticket.appId,
        'treeport.client.id': ticket.viewerId
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
        identity.appId !== ticket.appId ||
        identity.challenge !== ticket.challenge
      ) {
        return yield* Effect.fail(new Error('INVALID_BROWSER_OWNER_IDENTITY'))
      }

      const session = yield* this.getSession(ticket.appId)
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
        const resumed = previousOwner?.viewerId === ticket.viewerId
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

          if (!resumed || previousOwner.endpoint !== auth.endpoint) {
            await this.closeLocalAutomation(session)
            this.resetVideoDelivery(session)
          }

          previousOwner.transport = transport
          previousOwner.viewerId = ticket.viewerId
          previousOwner.endpoint = auth.endpoint
          previousOwner.challenge = auth.challenge
          previousOwner.generation = resumed
            ? previousOwner.generation
            : ++session.generation
          previousOwner.revision = -1
          previousOwner.ready = false
          previousOwner.controller = 'none'
          previousOwner.viewport = null
          previousOwner.retainPaint = false
          previousOwner.agentActive = false
          previousOwner.readiness = readiness
          owner = previousOwner
        } else {
          await this.closePlaywrightRuntime(session)
          owner = {
            transport,
            viewerId: ticket.viewerId,
            endpoint: auth.endpoint,
            challenge: auth.challenge,
            generation: ++session.generation,
            revision: -1,
            ready: false,
            controller: 'none',
            viewport: null,
            retainPaint: false,
            agentActive: false,
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
          appId: session.appId,
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
      this.queueAppState(session, message.state)
      this.broadcastState(session)

      const becameReady = message.type === 'ready' && !owner.ready
      if (becameReady) {
        owner.ready = true
        Deferred.unsafeDone(owner.readiness, Effect.void)
      }

      if (becameReady || (resized && owner.ready)) {
        const accepted = this.enqueueOperation(session, {
          coalesceKey: `screencast:${session.appId}`,
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
    if (session.controllerId === LOCAL_BROWSER_OWNER_CONTROLLER) {
      const attachment = [...session.attachments.values()].find(
        (candidate) =>
          !candidate.closing &&
          candidate.visible &&
          candidate.transport.isConnected()
      )
      session.controllerId = attachment
        ? attachmentController(attachment)
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
          installCommand: null
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
          controller: 'other' | 'none'
          viewport: { width: number; height: number } | null
          retainPaint: boolean
          agentActive: boolean
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
    controller: 'other' | 'none',
    viewport: { width: number; height: number } | null,
    retainPaint: boolean,
    agentActive: boolean
  ): Promise<void> {
    if (
      owner.controller === controller &&
      owner.viewport?.width === viewport?.width &&
      owner.viewport?.height === viewport?.height &&
      owner.retainPaint === retainPaint &&
      owner.agentActive === agentActive
    ) {
      return
    }

    const accepted = await this.requestLocalOwner(owner, {
      type: 'runtimeControl',
      controller,
      viewport,
      retainPaint,
      agentActive
    })
    if (
      !accepted ||
      session.localOwner !== owner ||
      session.generation !== owner.generation
    ) {
      throw new Error('The local Browser owner did not accept control.')
    }

    owner.controller = controller
    owner.viewport = viewport ? { ...viewport } : null
    owner.retainPaint = retainPaint
    owner.agentActive = agentActive
  }

  private prepareVideoViewer(
    session: BrowserSession,
    attachment: BrowserAttachment,
    controllerId = session.controllerId
  ): void {
    if (
      session.videoError ||
      attachment.closing ||
      !attachment.visible ||
      !attachment.transport.isConnected()
    ) {
      return
    }

    if (
      session.browser?.webcodecs &&
      controllerId !== attachmentController(attachment)
    ) {
      attachment.video.fail(
        'WebCodecs PoC streams only to the controlling viewer. Take control to view this tab.'
      )
      return
    }

    const video = session.localAutomation?.video
    const browser = session.browser
    if (session.localOwner && video) {
      attachment.video.resume({
        negotiate: (sdp) =>
          video
            .send('Treeport.negotiateVideo', { peerId: attachment.id, sdp })
            .then((result) => result.sdp),
        close: () =>
          video
            .send('Treeport.closeVideoPeer', { peerId: attachment.id })
            .then(() => undefined)
      })
    } else if (!session.localOwner && browser) {
      attachment.video.resume({
        webcodecs: browser.webcodecsViewer?.(attachment.id),
        negotiate: (sdp) => browser.negotiateVideo(attachment.id, sdp),
        close: () => browser.closeVideoPeer(attachment.id)
      })
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

    if (message.type === 'fileChooserResponse') {
      const pending = session.fileChooser
      if (
        !pending ||
        pending.id !== message.requestId ||
        pending.attachment !== attachment ||
        pending.submitted
      ) {
        attachment.transport.sendMessage({
          type: 'fileChooserClosed',
          requestId: message.requestId,
          error: 'This file selection is no longer active.'
        })
        return
      }

      // Admit at most one bounded payload per picker, even while input is queued.
      pending.submitted = true
    }

    if (message.type === 'setVideoSettings') {
      this.queueClientOperation(session, attachment, {
        coalesceKey: null,
        message,
        required: false,
        execute: async () => {
          if (
            attachment.closing ||
            session.attachments.get(attachment.id) !== attachment
          ) {
            return
          }

          const respond = (error: string | null) =>
            attachment.transport.sendMessage({
              type: 'videoSettingsResult',
              requestId: message.requestId,
              error
            })
          if (
            !attachment.visible ||
            session.agentActive ||
            session.controllerId !== attachmentController(attachment)
          ) {
            respond('Take control before changing stream settings.')
            return
          }

          if (session.browser?.webcodecs) {
            respond(
              'WebCodecs PoC is fixed at 1280×800 / 60fps target / 8Mbps; resize fits the viewer only.'
            )
            return
          }

          await this.updateScreencast(
            session,
            session.controllerId,
            message.settings
          )
            .then(() => {
              if (session.videoError) {
                throw new Error(session.videoError)
              }
            })
            .then(
              () => {
                session.videoSettings = message.settings
                this.broadcastState(session)
                respond(null)
              },
              async (cause) => {
                await this.updateScreencast(session).catch(() => undefined)
                this.broadcastState(session)
                respond(cause instanceof Error ? cause.message : String(cause))
              }
            )
        }
      })
      return
    }

    if (message.type === 'webcodecsStop') {
      if (session.browser?.webcodecs) {
        attachment.video.fail(message.message)
      }

      return
    }

    if (message.type === 'webcodecsAck') {
      if (
        attachment.visible &&
        session.controllerId === attachmentController(attachment)
      ) {
        attachment.video.ack(message.epoch, message.sequence)
      }

      return
    }

    if (message.type === 'videoOffer') {
      attachment.video.offer(message.requestId, message.sdp)
      return
    }

    if (message.type === 'setVisible') {
      attachment.visible = message.visible
      if (
        !message.visible &&
        session.clipboardInput?.attachment === attachment
      ) {
        session.clipboardInput = null
      }

      if (!message.visible) {
        attachment.video.suspend()
      }

      this.queueClientOperation(session, attachment, {
        coalesceKey: null,
        message: null,
        execute: async () => {
          const previousController = session.controllerId
          let nextController = previousController
          if (attachment.visible && previousController === null) {
            nextController = attachmentController(attachment)
          } else if (
            !attachment.visible &&
            previousController === attachmentController(attachment)
          ) {
            const nextAttachment = [...session.attachments.values()].find(
              (candidate) =>
                candidate.id !== attachment.id &&
                !candidate.closing &&
                candidate.visible
            )
            nextController = nextAttachment
              ? attachmentController(nextAttachment)
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
      this.queueClientOperation(session, attachment, {
        coalesceKey: `resize:${attachment.id}`,
        message,
        execute: async (queuedMessage) => {
          if (
            queuedMessage?.type !== 'resize' ||
            attachment.closing ||
            session.attachments.get(attachment.id) !== attachment ||
            session.controllerId !== attachmentController(attachment)
          ) {
            return
          }

          try {
            await this.cancelTouches(session)
            if (session.localOwner) {
              await this.updateScreencast(session)
            } else {
              const browser = await this.browserFor(session)
              await browser.command(queuedMessage)
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

    if (message.type === 'takeControl') {
      const scheduler = session.scheduler
      const key = `take-control:${attachment.id}`
      const viewport = attachment.viewport
      if (
        scheduler.accepting &&
        (scheduler.controlKey === key ||
          (scheduler.active.size === 0 &&
            scheduler.pending.size === 0 &&
            session.controllerId === attachmentController(attachment)))
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
          const nextController = attachmentController(attachment)
          // Input bursts request control repeatedly; ownership already held
          // must not resize the page or restart its video stream.
          if (previousController === nextController) {
            return
          }

          try {
            if (session.localOwner || session.browser?.webcodecs) {
              await this.updateScreencast(session, nextController)
            } else {
              const browser = await this.browserFor(session)
              await this.cancelTouches(session)
              await browser.command({ type: 'resize', ...viewport })
            }

            session.clipboardInput = null
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
          : message.type === 'touch' && message.phase === 'move'
            ? `touch-move:${attachment.id}`
            : message.type === 'wheel'
              ? `wheel:${attachment.id}:${message.modifiers}:${message.x}:${message.y}`
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

        if (session.controllerId !== attachmentController(attachment)) {
          attachment.transport.sendMessage(
            queuedMessage.type === 'copy'
              ? {
                  type: 'copyResult',
                  requestId: queuedMessage.requestId,
                  clipboard: null,
                  error: 'Take control before copying from this browser.'
                }
              : {
                  type: 'navigationError',
                  message: 'Take control before you interact with this browser.'
                }
          )
          return
        }

        try {
          if (queuedMessage.type === 'fileChooserResponse') {
            const pending = session.fileChooser
            if (
              !pending ||
              pending.id !== queuedMessage.requestId ||
              pending.attachment !== attachment ||
              !attachment.visible ||
              pending.generation !== session.generation ||
              session.agentActive
            ) {
              attachment.transport.sendMessage({
                type: 'fileChooserClosed',
                requestId: queuedMessage.requestId,
                error: 'This file selection is no longer active.'
              })
              return
            }

            const files = queuedMessage.files
            if (files && !pending.chooser.isMultiple() && files.length > 1) {
              this.closeFileChooser(
                session,
                'This input accepts only one file.'
              )
              return
            }

            if (!files) {
              this.closeFileChooser(session)
              return
            }

            await pending.chooser
              .setFiles(
                files.map((file) => ({
                  name: file.name,
                  mimeType: file.mimeType,
                  buffer: Buffer.from(file.base64, 'base64')
                })),
                { timeout: 15_000 }
              )
              .then(
                () => {
                  if (session.fileChooser === pending) {
                    this.closeFileChooser(session)
                  }
                },
                () => {
                  if (session.fileChooser === pending) {
                    this.closeFileChooser(
                      session,
                      'Could not upload files. Open the file picker and try again.'
                    )
                  }
                }
              )
            return
          }

          if (queuedMessage.type === 'touch') {
            if (queuedMessage.phase === 'start') {
              if (session.touchAttachmentId !== attachment.id) {
                await this.cancelTouches(session)
              }

              session.touchAttachmentId = attachment.id
              session.touchIds = new Set(
                queuedMessage.points.map((point) => point.id)
              )
            } else if (session.touchAttachmentId !== attachment.id) {
              return
            } else if (
              queuedMessage.phase === 'cancel' ||
              (queuedMessage.phase === 'end' &&
                queuedMessage.points.length === 0)
            ) {
              session.touchIds.clear()
            } else if (queuedMessage.phase === 'end') {
              for (const point of queuedMessage.points) {
                session.touchIds.delete(point.id)
              }
            }
          }

          if (
            ['navigate', 'back', 'forward', 'reload'].includes(
              queuedMessage.type
            )
          ) {
            await this.cancelTouches(session)
          }

          // Only recent input from this exact viewer may write its clipboard.
          // Agent actions and spectators never authorize syncing; the grant
          // expires and is consumed on the first website clipboard write.
          if (
            (queuedMessage.type === 'pointer' &&
              queuedMessage.phase !== 'move') ||
            (queuedMessage.type === 'key' && queuedMessage.phase === 'down') ||
            (queuedMessage.type === 'touch' &&
              (queuedMessage.phase === 'start' ||
                queuedMessage.phase === 'end'))
          ) {
            session.clipboardInput = {
              attachment,
              expiresAt: Date.now() + 5_000
            }
            session.fileChooserInput = session.clipboardInput
          } else if (
            ['copy', 'navigate', 'back', 'forward', 'reload'].includes(
              queuedMessage.type
            )
          ) {
            session.clipboardInput = null
          }

          const localOwner = session.localOwner
          if (queuedMessage.type === 'copy') {
            const result = localOwner
              ? await (
                  await this.ensureLocalAutomation(session, localOwner)
                ).video.send('Treeport.copy')
              : await (await this.browserFor(session)).copy()
            const clipboard =
              result === null
                ? null
                : decodeUnknownOrNull(browserClipboardSchema, result)
            if (result !== null && clipboard === null) {
              throw new Error('The copied content is too large or unsupported.')
            }

            attachment.transport.sendMessage({
              type: 'copyResult',
              requestId: queuedMessage.requestId,
              clipboard,
              error: null
            })
            return
          }

          if (localOwner) {
            await this.executeLocalClientCommand(
              session,
              localOwner,
              queuedMessage
            )
          } else {
            const browser = await this.browserFor(session)
            const result = await browser.command(queuedMessage)
            if (result) {
              attachment.transport.sendMessage(result)
            }

            this.queueAppState(session, browser.state)
            await this.waitForAppState(session)
          }

          if (queuedMessage.type === 'touch' && session.touchIds.size === 0) {
            session.touchAttachmentId = null
          }

          if (
            queuedMessage.type === 'pointer' ||
            queuedMessage.type === 'wheel'
          ) {
            attachment.cursorPoint = { x: queuedMessage.x, y: queuedMessage.y }
          }

          if (
            attachment.cursorPoint &&
            !attachment.cursorUpdate &&
            (queuedMessage.type === 'pointer' || queuedMessage.type === 'wheel')
          ) {
            // Cursor hit testing can force layout or wait on a busy renderer.
            // It must never hold an input slot. Keep one best-effort lookup,
            // sampling the latest position at roughly 30 Hz at most.
            const generation = session.generation
            const update = (async () => {
              while (true) {
                await new Promise<void>((resolve) => setTimeout(resolve, 33))
                if (
                  session.closing ||
                  attachment.closing ||
                  !attachment.visible ||
                  session.attachments.get(attachment.id) !== attachment ||
                  session.controllerId !== attachmentController(attachment) ||
                  session.generation !== generation ||
                  session.localOwner !== localOwner
                ) {
                  return
                }

                const point = attachment.cursorPoint
                if (!point) {
                  return
                }

                const cursor = await (
                  localOwner
                    ? browserCursor(
                        (await this.ensureLocalAutomation(session, localOwner))
                          .page,
                        point
                      )
                    : (await this.browserFor(session)).cursor(point)
                ).catch(() => 'default' as const)
                if (
                  session.closing ||
                  attachment.closing ||
                  !attachment.visible ||
                  session.attachments.get(attachment.id) !== attachment ||
                  session.controllerId !== attachmentController(attachment) ||
                  session.generation !== generation ||
                  session.localOwner !== localOwner
                ) {
                  return
                }

                if (attachment.cursorPoint === point) {
                  attachment.transport.sendMessage({ type: 'cursor', cursor })
                  return
                }
              }
            })().catch(() => undefined)
            attachment.cursorUpdate = update
            void update.then(() => {
              if (attachment.cursorUpdate === update) {
                attachment.cursorUpdate = null
              }
            })
          }
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause)
          attachment.transport.sendMessage(
            queuedMessage.type === 'copy'
              ? {
                  type: 'copyResult',
                  requestId: queuedMessage.requestId,
                  clipboard: null,
                  error
                }
              : { type: 'navigationError', message: error }
          )
        }
      },
      // Reserve admission capacity for releases after accepting their presses.
      required:
        ((message.type === 'key' || message.type === 'pointer') &&
          message.phase === 'up') ||
        (message.type === 'touch' &&
          (message.phase === 'end' || message.phase === 'cancel'))
    })
  }

  private async cancelTouches(session: BrowserSession): Promise<void> {
    if (!session.touchAttachmentId) {
      return
    }

    session.touchAttachmentId = null
    session.touchIds.clear()
    const message = { type: 'touch', phase: 'cancel', points: [] } as const
    if (session.localAutomation) {
      await browserTouch(session.localAutomation.cdp, message).catch(
        () => undefined
      )
    } else if (session.browser) {
      await session.browser.command(message).catch(() => undefined)
    }
  }

  private async updateScreencast(
    session: BrowserSession,
    controllerId = session.controllerId,
    settings = session.videoSettings
  ): Promise<void> {
    // Revoke the old lane before any asynchronous control handoff.
    if (session.browser?.webcodecs) {
      for (const attachment of session.attachments.values()) {
        if (controllerId !== attachmentController(attachment)) {
          attachment.video.suspend()
        }
      }
    }

    const touchAttachment = session.touchAttachmentId
      ? session.attachments.get(session.touchAttachmentId)
      : null
    if (
      session.touchAttachmentId &&
      (!touchAttachment ||
        touchAttachment.closing ||
        !touchAttachment.visible ||
        attachmentController(touchAttachment) !== controllerId)
    ) {
      await this.cancelTouches(session)
    }

    const visible = [...session.attachments.values()].some(
      (attachment) =>
        !attachment.closing &&
        attachment.visible &&
        attachment.transport.isConnected()
    )
    const localOwner = session.localOwner
    if (localOwner) {
      const controller =
        controllerId && controllerId !== LOCAL_BROWSER_OWNER_CONTROLLER
          ? 'other'
          : 'none'
      const viewport =
        controller === 'other'
          ? ([...session.attachments.values()].find(
              (attachment) => attachmentController(attachment) === controllerId
            )?.viewport ?? null)
          : null
      const retainPaint = visible || session.retainLocalAgentPaint
      if (visible) {
        await this.setLocalOwnerRuntimeControl(
          session,
          localOwner,
          controller,
          viewport,
          retainPaint,
          session.agentActive
        )
        await this.setLocalScreencasting(session, localOwner, true, settings)
      } else {
        await this.setLocalScreencasting(session, localOwner, false, settings)
        await this.setLocalOwnerRuntimeControl(
          session,
          localOwner,
          controller,
          viewport,
          retainPaint,
          session.agentActive
        )
      }

      const automation = session.localAutomation
      if (automation) {
        // Keep the native desktop picker when the desktop owns control.
        automation.page.off('filechooser', automation.fileChooser)
        if (controller === 'other') {
          automation.page.on('filechooser', automation.fileChooser)
        }
      }

      for (const attachment of session.attachments.values()) {
        this.prepareVideoViewer(session, attachment)
      }
      return
    }

    if (!session.launch) {
      return
    }

    const browser = await session.launch.catch(() => null)
    const viewport = [...session.attachments.values()].find(
      (attachment) =>
        !attachment.closing &&
        attachment.visible &&
        attachmentController(attachment) === controllerId
    )?.viewport
    // Visibility and disconnect handoffs need the same viewport update as an
    // explicit takeover. An unchanged app will not emit another resize event.
    if (
      browser &&
      viewport &&
      (browser.state.viewport.width !== viewport.width ||
        browser.state.viewport.height !== viewport.height)
    ) {
      await this.cancelTouches(session)
      await browser.command({ type: 'resize', ...viewport })
    }

    if (visible) {
      session.videoError = null
    }

    await browser
      ?.setScreencasting(visible, settings)
      .catch((cause) =>
        this.broadcastVideoUnavailable(
          session,
          cause instanceof Error ? cause.message : String(cause)
        )
      )
    for (const attachment of session.attachments.values()) {
      this.prepareVideoViewer(session, attachment, controllerId)
    }
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
    this.closeFileChooser(session)
    await this.waitForAppState(session)
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
            this.closeFileChooser(session)
            this.resetVideoDelivery(session)
            if (this.sessions.get(session.appId) === session) {
              this.sessions.delete(session.appId)
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
              attachment.video.dispose()
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
        yield* Effect.promise(() => this.waitForAppState(session))
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
      attachment.video.dispose()
      void this.scheduleOperation(
        session,
        async () => {
          session.attachments.delete(connectionId)
          const previousController = session.controllerId
          if (previousController === attachmentController(attachment)) {
            // A disconnected viewer must not leave a phantom controller behind.
            // Prefer its replacement if it reattached before cleanup ran.
            const visibleAttachments = [...session.attachments.values()].filter(
              (candidate) =>
                !candidate.closing &&
                candidate.visible &&
                candidate.transport.isConnected()
            )
            const nextAttachment =
              visibleAttachments.find(
                (candidate) =>
                  attachmentController(candidate) ===
                  attachmentController(attachment)
              ) ?? visibleAttachments[0]
            session.controllerId = nextAttachment
              ? attachmentController(nextAttachment)
              : session.localOwner
                ? LOCAL_BROWSER_OWNER_CONTROLLER
                : null
            session.clipboardInput = null
          }

          await this.updateScreencast(session)
          if (session.controllerId !== previousController) {
            this.broadcastState(session, 'controlChanged')
          }
        },
        { required: true }
      ).catch(() => undefined)
      return
    }
  }

  async requestAppClose(appId: string, force = false): Promise<boolean> {
    const session =
      this.sessions.get(appId) ??
      (await this.sessionCreations.get(appId)?.catch(() => null))
    if (!session) {
      return true
    }

    if (session.closeApproved) {
      return true
    }

    if (session.closeRequest) {
      const accepted = await session.closeRequest
      return accepted || !force ? accepted : this.requestAppClose(appId, true)
    }

    let canClose = false
    const operation = this.scheduleOperation(
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
      },
      { required: true }
    ).then(() => {
      if (canClose) {
        session.closeApproved = true
        session.closing = true
        this.stopScheduler(session, 'Browser closed.')
      }

      return canClose
    })
    const pending = operation.finally(() => {
      if (session.closeRequest === pending) {
        session.closeRequest = null
      }
    })
    session.closeRequest = pending
    return pending
  }

  async closeApp(appId: string, reason: string): Promise<void> {
    const session =
      this.sessions.get(appId) ??
      (await this.sessionCreations.get(appId)?.catch(() => null))
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
    for (const active of session.scheduler.active) {
      Deferred.unsafeDone(
        active.completion,
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
          appId: session.appId,
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

      const fileChooser = (chooser: FileChooser) => {
        if (
          session.localOwner === owner &&
          session.generation === owner.generation
        ) {
          this.openFileChooser(session, chooser)
        } else {
          void chooser
            .element()
            .dispose()
            .catch(() => undefined)
        }
      }
      const clearFileChooser = () => {
        if (
          session.localOwner === owner &&
          session.generation === owner.generation
        ) {
          this.openFileChooser(session, null)
        }
      }
      page.on('framenavigated', clearFileChooser)
      page.on('framedetached', clearFileChooser)

      // Explicit ownership avoids Playwright's fire-and-forget default dialog
      // close. Electron keeps beforeunload; the bridge hides those native dialogs.
      page.on('dialog', (dialog) => {
        void dialog.dismiss().catch(() => undefined)
      })
      const cdp = await context.newCDPSession(page)
      // SAFETY: The verified exact-guest Electron CDP bridge implements this
      // private domain. Arbitrary remote CDP endpoints are not accepted here.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions -- This private Electron domain extends Playwright's fixed Chromium command table.
      const video = cdp as unknown as BrowserNativeCdpSession
      video.on('Treeport.videoError', ({ message }) => {
        if (
          session.localOwner === owner &&
          session.localAutomation?.generation === owner.generation
        ) {
          automation.screencasting = false
          void video.send('Treeport.stopVideo').catch(() => undefined)
          this.broadcastVideoUnavailable(session, message)
        }
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
        captureViewport: null,
        captureSettings: null,
        fileChooser
      }
      browser.once('disconnected', () => {
        if (session.localAutomation !== automation) {
          return
        }

        this.closeFileChooser(session)
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
    this.closeFileChooser(session)
    session.retainLocalAgentPaint = false
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
    enabled: boolean,
    settings: BrowserVideoSettings
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
            automation.captureViewport.height === height &&
            automation.captureSettings === settings)))
    ) {
      return
    }

    automation.screencasting = enabled
    automation.captureViewport = enabled ? { width, height } : null
    automation.captureSettings = enabled ? settings : null
    if (!enabled) {
      await automation.video.send('Treeport.stopVideo').catch(() => undefined)
      return
    }

    session.videoError = null
    await automation.video
      .send('Treeport.startVideo', {
        width,
        height,
        settings
      })
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
      await browserNavigation(
        page,
        () => page.goto(message.url, { waitUntil: 'commit' }),
        automation.cdp,
        'page'
      )
    } else if (message.type === 'back') {
      await browserNavigation(
        page,
        () => page.goBack({ waitUntil: 'commit' }),
        automation.cdp,
        'page'
      )
    } else if (message.type === 'forward') {
      await browserNavigation(
        page,
        () => page.goForward({ waitUntil: 'commit' }),
        automation.cdp,
        'page'
      )
    } else if (message.type === 'reload') {
      await browserNavigation(
        page,
        () => page.reload({ waitUntil: 'commit' }),
        automation.cdp,
        'page'
      )
    } else if (message.type === 'stop') {
      await automation.cdp.send('Page.stopLoading')
    } else if (message.type === 'pointer') {
      const { cssVisualViewport } = await automation.cdp.send(
        'Page.getLayoutMetrics'
      )
      await page.mouse.move(
        message.x / cssVisualViewport.scale,
        message.y / cssVisualViewport.scale
      )
      if (message.phase === 'down') {
        await page.mouse.down({
          button: message.button ?? 'left',
          clickCount: message.clickCount ?? 1
        })
      } else if (message.phase === 'up') {
        await page.mouse.up({
          button: message.button ?? 'left',
          clickCount: message.clickCount ?? 1
        })
      }
    } else if (message.type === 'touch') {
      await browserTouch(automation.cdp, message)
    } else if (message.type === 'wheel') {
      await browserWheel(automation.cdp, message)
    } else if (message.type === 'key') {
      await browserKey(page, message)
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
      await browserNavigation(
        page,
        () => page.goto(input.args[0]),
        automation.cdp
      )
      return `Navigated to ${page.url()}`
    }

    if (input.command === 'go-back') {
      await browserNavigation(page, () => page.goBack(), automation.cdp)
      return `Navigated to ${page.url()}`
    }

    if (input.command === 'go-forward') {
      await browserNavigation(page, () => page.goForward(), automation.cdp)
      return `Navigated to ${page.url()}`
    }

    await browserNavigation(page, () => page.reload(), automation.cdp)
    return `Reloaded ${page.url()}`
  }

  agentCommand(
    appId: string,
    input: BrowserAgentCommand
  ): Effect.Effect<string, unknown, ApplicationServices> {
    return Effect.gen(this, function* () {
      const session = yield* this.getSession(appId)
      return yield* Effect.tryPromise({
        try: () => this.runAgentCommand(appId, input, session),
        catch: (cause) => cause
      })
    })
  }

  private async runAgentCommand(
    appId: string,
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
      session.clipboardInput = null
      session.agentActive = true
      this.broadcastState(session)
      try {
        if (localOwner) {
          // Keep a background local page paintable for later agent commands.
          // Agent activity does not revoke the local user's native input.
          session.retainLocalAgentPaint = true
          await this.updateScreencast(session)
          if (
            session.localOwner !== localOwner ||
            localOwner.generation !== session.generation
          ) {
            throw new Error('The local Browser owner changed.')
          }
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
            `treeport-${appId}-${session.generation}-${crypto
              .randomBytes(6)
              .toString('hex')}`
          session.agentSessionName = name
          if (!session.agentAttached) {
            await this.executeAgentCli(session, [
              'attach',
              `treeport-${appId}`,
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
          this.queueAppState(session, browser!.state)
        } else {
          result = await browser!.agentCommand(input)
          this.queueAppState(session, browser!.state)
        }

        await this.waitForAppState(session)
      } catch (cause) {
        if (!localOwner) {
          session.agentAttached = false
        }

        throw cause
      } finally {
        session.agentActive = false
        if (localOwner && session.localOwner === localOwner) {
          await this.updateScreencast(session).catch(() => undefined)
        }

        this.broadcastState(session)
      }
    })
    return result
  }

  async status(): Promise<BrowserInstallStatus> {
    return PlaywrightBrowser.status(this.cachePath)
  }

  async install(): Promise<string> {
    throw new Error(browserSetupGuidance())
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
        [...this.sessions.keys()].map((appId) =>
          Effect.promise(() =>
            this.closeApp(appId, 'Treeport is shutting down.')
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
