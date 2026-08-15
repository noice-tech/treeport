import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import type {
  BrowserAgentCommand,
  BrowserClientMessage,
  BrowserFrame,
  BrowserServerMessage,
  BrowserSessionState
} from '@treeport/shared'
import {
  BROWSER_MAX_FRAME_BYTES,
  parseBrowserClientMessage
} from '@treeport/shared'
import type { AppConfig, TreeportService } from './core/index'
import {
  PlaywrightBrowser,
  type BrowserInstallStatus
} from './playwright-browser'

export interface BrowserTransport {
  id: string
  isConnected(): boolean
  sendMessage(message: BrowserServerMessage): boolean
  sendFrame(frame: BrowserFrame): boolean
  disconnect(): void
}

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
  awaitingFrame: number | null
  pendingFrame: BrowserFrame | null
  viewport: { width: number; height: number }
}

interface BrowserSession {
  panelId: string
  agentDirectory: string
  title: string
  browser: PlaywrightBrowser | null
  launch: Promise<PlaywrightBrowser>
  attachments: Map<string, BrowserAttachment>
  controllerId: string | null
  pendingControllerId: string | null
  state: Omit<
    BrowserSessionState,
    'controlled' | 'hasController' | 'controller'
  >
  sequence: number
  latestFrame: BrowserFrame | null
  commandTail: Promise<void>
  agentTail: Promise<void>
  agentAttached: boolean
  agentProcess: ChildProcess | null
  crashMessage: string | null
}

const MAX_BROWSER_ATTACHMENTS = 8
const MAX_BROWSER_TICKETS = 256

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
  private readonly permissionTimer: NodeJS.Timeout
  private installing: Promise<string> | null = null

  constructor(
    private readonly service: TreeportService,
    private readonly config: AppConfig
  ) {
    this.cachePath = path.join(config.cacheDir, 'playwright')
    this.unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'panel.removed') {
        void this.closePanel(String(event.data.panelId), 'Panel closed')
      } else if (event.type === 'panel.updated') {
        const panelId = String(event.data.panelId)
        if (this.sessions.has(panelId)) {
          void this.service
            .authorizeHostBrowserPanel(panelId)
            .catch(() =>
              this.closePanel(panelId, 'Remote Browser permission revoked')
            )
        }
      } else if (event.type === 'worktree.removed' && event.data.worktreeId) {
        for (const session of this.sessions.values()) {
          void this.service
            .authorizeHostBrowserPanel(session.panelId)
            .catch(() => this.closePanel(session.panelId, 'Worktree removed'))
        }
      }
    })
    this.permissionTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        void this.service
          .authorizeHostBrowserPanel(session.panelId)
          .catch(() =>
            this.closePanel(
              session.panelId,
              'Remote Browser permission revoked'
            )
          )
      }
    }, 2_000)
    this.permissionTimer.unref()
  }

  async issueTicket(panelId: string, clientId: string): Promise<string> {
    await this.service.authorizeHostBrowserPanel(panelId)
    for (const [value, ticket] of this.tickets) {
      if (ticket.expiresAt < Date.now()) {
        this.tickets.delete(value)
      }
    }
    if (this.tickets.size >= MAX_BROWSER_TICKETS) {
      throw new Error(
        'Too many Remote Browser attachment requests are pending.'
      )
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

  private async createSession(panelId: string): Promise<BrowserSession> {
    if (this.sessions.size >= 6) {
      throw new Error(
        'Treeport supports at most six active Remote Browser panels. Close one and try again.'
      )
    }

    const authorized = await this.service.authorizeHostBrowserPanel(panelId)
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
      launch: Promise.resolve(null as never),
      attachments: new Map(),
      controllerId: null,
      pendingControllerId: null,
      state: { ...DEFAULT_STATE, viewport: { ...DEFAULT_STATE.viewport } },
      sequence: 0,
      latestFrame: null,
      commandTail: Promise.resolve(),
      agentTail: Promise.resolve(),
      agentAttached: false,
      agentProcess: null,
      crashMessage: null
    }
    session.launch = (async () => {
      const browser = new PlaywrightBrowser(
        this.cachePath,
        session.agentDirectory,
        session.title,
        panelId,
        authorized.panel.worktreeId,
        {
          state: (state) => {
            session.state = state
            this.broadcastState(session)
          },
          frame: (frame) => this.publishFrame(session, frame),
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
      return browser
    })()
    this.sessions.set(panelId, session)
    return session
  }

  private async getSession(panelId: string): Promise<BrowserSession> {
    const existing = this.sessions.get(panelId)
    if (existing) {
      await this.service.authorizeHostBrowserPanel(panelId)
      return existing
    }

    const pending = this.sessionCreations.get(panelId)
    if (pending) {
      return pending
    }

    if (this.sessions.size + this.sessionCreations.size >= 6) {
      throw new Error(
        'Treeport supports at most six active Remote Browser panels. Close one and try again.'
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
          'This Remote Browser panel already has the maximum of eight attached clients.',
        installCommand: null
      })
      return transport.id
    }

    const attachment: BrowserAttachment = {
      id: transport.id,
      clientId: ticket.clientId,
      transport,
      visible: true,
      awaitingFrame: null,
      pendingFrame: null,
      viewport: { ...session.state.viewport }
    }
    session.attachments.set(attachment.id, attachment)
    session.controllerId ??= attachment.id

    try {
      await session.launch
      if (!transport.isConnected()) {
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

      await this.updateScreencast(session)
      this.sendLatestFrame(session, attachment)
    } catch (error) {
      if (this.sessions.get(session.panelId) === session) {
        this.sessions.delete(session.panelId)
      }

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

  message(connectionId: string, value: unknown): void {
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

      void this.updateScreencast(session)
      return
    }

    const queueViewport = (afterAgent = false) => {
      session.commandTail = session.commandTail.then(async () => {
        if (afterAgent) {
          await session.agentTail
        }

        if (session.controllerId !== attachment.id) {
          return
        }

        try {
          const browser = await session.launch
          await browser.command({ type: 'resize', ...attachment.viewport })
        } catch (error) {
          attachment.transport.sendMessage({
            type: 'navigationError',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
    }

    if (message.type === 'resize') {
      attachment.viewport = { width: message.width, height: message.height }
      if (session.controllerId === attachment.id) {
        queueViewport()
      }

      return
    }

    if (message.type === 'takeControl') {
      if (session.controllerId === 'agent') {
        session.pendingControllerId = attachment.id
        queueViewport(true)
      } else {
        session.pendingControllerId = null
        session.controllerId = attachment.id
        this.broadcastState(session, 'controlChanged')
        queueViewport()
      }

      return
    }

    if (
      session.controllerId === 'agent' &&
      session.pendingControllerId === attachment.id
    ) {
      session.commandTail = session.commandTail.then(async () => {
        await session.agentTail
        if (session.controllerId !== attachment.id) {
          return
        }

        try {
          if (message.type === 'reset') {
            await this.resetSession(session)
          } else {
            const browser = await session.launch
            await browser.command(message as BrowserClientMessage)
          }
        } catch (error) {
          attachment.transport.sendMessage({
            type: 'navigationError',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
      return
    }

    if (session.controllerId !== attachment.id) {
      attachment.transport.sendMessage({
        type: 'navigationError',
        message: 'Take control before you interact with this browser.'
      })
      return
    }

    if (message.type === 'reset') {
      session.commandTail = session.commandTail.then(() =>
        this.resetSession(session)
      )
      return
    }

    session.commandTail = session.commandTail.then(async () => {
      try {
        const browser = await session.launch
        await browser.command(message as BrowserClientMessage)
      } catch (error) {
        attachment.transport.sendMessage({
          type: 'navigationError',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })
  }

  private async updateScreencast(session: BrowserSession): Promise<void> {
    const browser = await session.launch.catch(() => null)
    if (!browser) {
      return
    }

    await browser
      .setScreencasting(
        [...session.attachments.values()].some(
          (attachment) =>
            attachment.visible && attachment.transport.isConnected()
        )
      )
      .catch(() => undefined)
  }

  private async detachAgent(session: BrowserSession): Promise<void> {
    if (!session.agentAttached) {
      return
    }

    session.agentAttached = false
    await this.runAgentCli(session, [
      `-s=treeport-${session.panelId}`,
      'detach'
    ]).catch(() => undefined)
  }

  private async resetSession(session: BrowserSession): Promise<void> {
    await this.detachAgent(session)
    await session.launch
      .catch(() => session.browser)
      .then((browser) => browser?.close())
    this.sessions.delete(session.panelId)
    await fs.rm(session.agentDirectory, { recursive: true, force: true })
    for (const attachment of session.attachments.values()) {
      attachment.transport.sendMessage({
        type: 'closed',
        reason: 'Remote Browser reset; reconnecting to a new empty session.'
      })
      attachment.transport.disconnect()
    }
  }

  close(connectionId: string): void {
    for (const session of this.sessions.values()) {
      const attachment = session.attachments.get(connectionId)
      if (!attachment) {
        continue
      }

      session.attachments.delete(connectionId)
      if (session.pendingControllerId === connectionId) {
        session.pendingControllerId = null
      }

      if (session.controllerId === connectionId) {
        session.controllerId = session.attachments.keys().next().value ?? null
        this.broadcastState(session, 'controlChanged')
      }

      void this.updateScreencast(session)
      return
    }
  }

  async closePanel(panelId: string, reason: string): Promise<void> {
    const session =
      this.sessions.get(panelId) ??
      (await this.sessionCreations.get(panelId)?.catch(() => null))
    if (!session) {
      return
    }

    this.sessions.delete(panelId)
    session.agentProcess?.kill('SIGTERM')
    await session.agentTail.catch(() => undefined)
    await this.detachAgent(session)
    for (const attachment of session.attachments.values()) {
      attachment.transport.sendMessage({ type: 'closed', reason })
      attachment.transport.disconnect()
    }
    await session.launch
      .catch(() => session.browser)
      .then((browser) => browser?.close())
    await fs.rm(session.agentDirectory, { recursive: true, force: true })
  }

  private async playwrightCliPath(): Promise<string> {
    const require = createRequire(import.meta.url)
    const packageJsonPath = require.resolve('@playwright/cli/package.json')
    return path.join(path.dirname(packageJsonPath), 'playwright-cli.js')
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
      const append = (data: unknown) => {
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
    const previousAgent = session.agentTail
    let releaseAgent!: () => void
    session.agentTail = new Promise<void>((resolve) => {
      releaseAgent = resolve
    })
    await previousAgent.catch(() => undefined)
    try {
      await session.launch.catch(async (error) => {
        if (this.sessions.get(session.panelId) === session) {
          this.sessions.delete(session.panelId)
        }

        await session.browser?.close()
        await fs.rm(session.agentDirectory, { recursive: true, force: true })
        throw error
      })
      await session.commandTail.catch(() => undefined)
      const name = `treeport-${panelId}`
      if (!session.agentAttached) {
        await this.runAgentCli(session, ['attach', name, '--session', name])
        session.agentAttached = true
      }

      const previousController = session.controllerId
      session.controllerId = 'agent'
      this.broadcastState(session, 'controlChanged')
      try {
        return await this.runAgentCli(session, [
          `-s=${name}`,
          input.command,
          '--',
          ...input.args
        ])
      } finally {
        const pendingController = session.pendingControllerId
        session.pendingControllerId = null
        session.controllerId =
          pendingController && session.attachments.has(pendingController)
            ? pendingController
            : previousController && session.attachments.has(previousController)
              ? previousController
              : (session.attachments.keys().next().value ?? null)
        this.broadcastState(session, 'controlChanged')
      }
    } finally {
      releaseAgent()
    }
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
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, 'utf8')
      ) as {
        bin?: { playwright?: string }
      }
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
      throw new Error('Close Remote Browser panels before you remove Chromium.')
    }

    await fs.rm(this.cachePath, { recursive: true, force: true })
  }

  async dispose(): Promise<void> {
    this.unsubscribe()
    clearInterval(this.permissionTimer)
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
