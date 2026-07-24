import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { io, type Socket } from 'socket.io-client'
import { apiClient } from './api.js'
import {
  parseTerminalServerEvent,
  SOCKET_IO_PATH,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalClientToServerEvents,
  type TerminalProgress,
  type TerminalRuntimeMetadata,
  type TerminalServerEvent,
  type TerminalSize,
  type TerminalServerToClientEvents
} from '@tasktty/shared'

export type { TerminalProgress } from '@tasktty/shared'

type ConnectionPhase = 'connecting' | 'ready' | 'reconnecting' | 'closed'
export type ArrowDirection = 'up' | 'down' | 'left' | 'right'
export type TerminalFileTransfer = {
  state: 'uploading' | 'error'
  message: string
}

const TERMINAL_SCROLL_EXIT_SEQUENCE = '\u001b[9000~'
const TERMINAL_MAX_FILES_PER_TRANSFER = 8
const TERMINAL_FONT_SIZE = 14
const TERMINAL_MIN_VIEWER_FONT_SIZE = 4
const TERMINAL_MIN_COLS = 2
const TERMINAL_MAX_COLS = 1_000
const TERMINAL_MIN_ROWS = 2
const TERMINAL_MAX_ROWS = 500
const TERMINAL_RESIZE_SETTLE_MS = 150

function normalizeTerminalDimensions(
  dimensions: { cols: number; rows: number },
  fallback: { cols: number; rows: number } = { cols: 100, rows: 30 }
): { cols: number; rows: number } {
  return {
    cols: Number.isFinite(dimensions.cols)
      ? Math.min(
          TERMINAL_MAX_COLS,
          Math.max(TERMINAL_MIN_COLS, Math.trunc(dimensions.cols))
        )
      : fallback.cols,
    rows: Number.isFinite(dimensions.rows)
      ? Math.min(
          TERMINAL_MAX_ROWS,
          Math.max(TERMINAL_MIN_ROWS, Math.trunc(dimensions.rows))
        )
      : fallback.rows
  }
}

// tmux copy mode advances five rows for each wheel report. Requiring three
// rows of finger travel keeps the gesture responsive without restoring the
// original excessive gain.
const TERMINAL_TOUCH_ROWS_PER_WHEEL = 3

export function terminalProgressLabel(progress: TerminalProgress): string {
  const percentage =
    progress.value === null ? '' : `, ${progress.value}% complete`
  if (progress.state === 'error') {
    return `progress error${percentage}`
  }

  if (progress.state === 'paused') {
    return `progress paused${percentage}`
  }

  return progress.value === null ? 'working' : `${progress.value}% complete`
}

type TerminalKeyboardEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey' | 'type'
>

export function terminalKeyboardInput(
  event: TerminalKeyboardEvent,
  applicationCursorKeysMode = false
): string | null {
  if (event.type !== 'keydown' || event.isComposing || event.ctrlKey) {
    return null
  }

  if (
    event.key === 'Enter' &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    return '\u001b[13;2u'
  }

  if (event.altKey && !event.metaKey && !event.shiftKey) {
    if (usesMacKeyboard()) {
      if (event.key === 'ArrowLeft') {
        return '\u001bb'
      }

      if (event.key === 'ArrowRight') {
        return '\u001bf'
      }
    } else {
      const final = {
        ArrowUp: 'A',
        ArrowDown: 'B',
        ArrowRight: 'C',
        ArrowLeft: 'D'
      }[event.key]
      if (final) {
        return `\u001b[1;5${final}`
      }
    }

    return null
  }

  if (!event.metaKey || event.altKey || event.shiftKey) {
    return null
  }

  const prefix = applicationCursorKeysMode ? '\u001bO' : '\u001b['
  if (event.key === 'ArrowLeft') {
    return `${prefix}H`
  }

  if (event.key === 'ArrowRight') {
    return `${prefix}F`
  }

  return null
}

function usesMacKeyboard(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  )
}

function activateTerminalLink(event: MouseEvent, url: string): void {
  if (usesMacKeyboard() ? !event.metaKey : !event.ctrlKey) {
    return
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return
  }
  if (parsedUrl.protocol === 'file:') {
    const opening = window.taskttyDesktop?.openFileUrl(url)
    if (opening) {
      void opening.catch(() => undefined)
    }

    return
  }

  if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

function forcePlainSelectionWhileMouseReporting(
  event: MouseEvent,
  terminal: Terminal
): void {
  if (
    !terminal.element?.classList.contains('enable-mouse-events') ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return
  }

  Object.defineProperty(event, usesMacKeyboard() ? 'altKey' : 'shiftKey', {
    configurable: true,
    value: true
  })
}

function trackTerminalScrolling(
  wrapper: HTMLElement,
  terminal: Terminal,
  onScroll: () => void,
  onResumeInput: () => void
): void {
  let lastTouchY: number | null = null
  let touchScrollRemainder = 0

  wrapper.addEventListener(
    'wheel',
    () => {
      wrapper.classList.add('terminal-scrolling')
      onScroll()
    },
    { capture: true, passive: true }
  )
  wrapper.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) {
        lastTouchY = null
        touchScrollRemainder = 0
        return
      }

      lastTouchY = event.touches[0]!.clientY
      touchScrollRemainder = 0
    },
    { capture: true, passive: true }
  )
  wrapper.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches.length !== 1 || lastTouchY === null) {
        lastTouchY = null
        touchScrollRemainder = 0
        return
      }

      const element = terminal.element
      if (!element) {
        return
      }

      const touch = event.touches[0]!
      touchScrollRemainder += lastTouchY - touch.clientY
      lastTouchY = touch.clientY
      event.preventDefault()

      const bounds = element.getBoundingClientRect()
      const rowHeight = bounds.height / terminal.rows || 16
      const rowsPerWheel = element.classList.contains('enable-mouse-events')
        ? TERMINAL_TOUCH_ROWS_PER_WHEEL
        : 1
      const touchStep = rowHeight * rowsPerWheel
      const steps = Math.trunc(touchScrollRemainder / touchStep)
      if (steps === 0) {
        return
      }

      touchScrollRemainder -= steps * touchStep
      const clientX = Math.min(
        Math.max(touch.clientX, bounds.left),
        bounds.right - 1
      )
      const clientY = Math.min(
        Math.max(touch.clientY, bounds.top),
        bounds.bottom - 1
      )
      for (let index = 0; index < Math.abs(steps); index += 1) {
        element.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX,
            clientY,
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            deltaY: Math.sign(steps)
          })
        )
      }
    },
    { capture: true, passive: false }
  )
  const resetTouchScroll = () => {
    lastTouchY = null
    touchScrollRemainder = 0
  }
  wrapper.addEventListener('touchend', resetTouchScroll, true)
  wrapper.addEventListener('touchcancel', resetTouchScroll, true)
  wrapper.addEventListener('paste', onResumeInput, true)
}

export interface TerminalSessionSnapshot {
  phase: ConnectionPhase
  degraded: boolean
  controller: boolean
  title: string | null
  bellActive: boolean
  bellSerial: number
  exitSerial: number
  fileTransfer: TerminalFileTransfer | null
  error: string | null
}

const DEFAULT_SNAPSHOT: TerminalSessionSnapshot = {
  phase: 'closed',
  degraded: false,
  controller: false,
  title: null,
  bellActive: false,
  bellSerial: 0,
  exitSerial: 0,
  fileTransfer: null,
  error: null
}

let fallbackClientId: string | null = null
function getClientId(): string {
  if (fallbackClientId) {
    return fallbackClientId
  }

  try {
    const stored = sessionStorage.getItem('tasktty-terminal-client-id')
    if (stored) {
      return (fallbackClientId = stored)
    }
  } catch {
    // Storage can be unavailable in private browsing modes.
  }

  const bytes = new Uint8Array(16)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  const created = `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`

  try {
    sessionStorage.setItem('tasktty-terminal-client-id', created)
  } catch {
    // The in-memory ID still keeps reconnects stable for this page load.
  }
  return (fallbackClientId = created)
}

export function terminalOptions() {
  return {
    cursorBlink: true,
    convertEol: false,
    fontFamily:
      '"SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace',
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: 1.15,
    scrollback: 0,
    allowProposedApi: false,
    macOptionClickForcesSelection: true,
    linkHandler: {
      activate: activateTerminalLink,
      allowNonHttpProtocols: true
    },
    theme: {
      background: '#09090b',
      foreground: '#e4e4e7',
      cursor: '#67e8f9',
      selectionBackground: '#3f3f4666',
      scrollbarSliderBackground: '#3f3f46',
      scrollbarSliderHoverBackground: '#52525b',
      scrollbarSliderActiveBackground: '#71717a',
      black: '#18181b',
      red: '#fb7185',
      green: '#86efac',
      yellow: '#fde047',
      blue: '#7dd3fc',
      magenta: '#d8b4fe',
      cyan: '#67e8f9',
      white: '#f4f4f5'
    }
  } as const
}

export class TerminalSession {
  readonly terminalId: string
  private readonly listeners = new Set<() => void>()
  private snapshotValue: TerminalSessionSnapshot = DEFAULT_SNAPSHOT
  private terminal: Terminal | null = null
  private fitAddon: FitAddon | null = null
  private wrapper: HTMLDivElement | null = null
  private host: HTMLElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private socket: Socket<
    TerminalServerToClientEvents,
    TerminalClientToServerEvents
  > | null = null
  private degradedTimer: number | null = null
  private bellTimer: number | null = null
  private fileTransferTimer: number | null = null
  private fileTransferQueue: Promise<void> = Promise.resolve()
  private resizeFrame: number | null = null
  private resizeSettleTimer: number | null = null
  private disposed = false
  private opened = false
  private ready = false
  private reconnectAllowed = true
  private streamId: string | null = null
  private controllerGeneration = 0
  private canonicalCols = 100
  private canonicalRows = 30
  private canonicalRevision = 0
  private appliedRevision = 0
  private proposedDimensions: { cols: number; rows: number } | null = null
  private resizePending = false
  private serverProtocolVersion: 1 | typeof TERMINAL_PROTOCOL_VERSION =
    TERMINAL_PROTOCOL_VERSION
  private resizeIntentDirty = false
  private resizeQuietElapsed = false
  private resizeIntentGeneration = 0
  private renderEpoch = 0
  private renderQueue: Promise<void> = Promise.resolve()
  private renderFailed = false
  private pendingTerminalWrites = 0
  private expectedSequence = 1
  private lastParsedSequence = 0
  private readonly parsedSequences = new Set<number>()
  private scrollExitPending = false
  private resumeOnNextInput = false
  private lastBellAt = 0

  constructor(terminalId: string) {
    this.terminalId = terminalId
  }

  getSnapshot = (): TerminalSessionSnapshot => this.snapshotValue

  getInitialSize(): TerminalSize | null {
    if (!this.host || !this.terminal) {
      return null
    }

    return normalizeTerminalDimensions(
      this.proposedDimensions ?? {
        cols: this.terminal.cols,
        rows: this.terminal.rows
      }
    )
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  mount(host: HTMLElement): void {
    if (this.disposed) {
      return
    }

    this.host = host
    if (!this.wrapper) {
      this.wrapper = document.createElement('div')
      this.wrapper.className = 'terminal-session-host h-full min-h-0 min-w-0'
    }

    host.appendChild(this.wrapper)
    if (!this.opened) {
      this.openTerminal()
    }

    this.resizeObserver?.disconnect()
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit())
    this.resizeObserver.observe(host)
    this.scheduleFit()
    if (!this.socket && this.opened) {
      this.connect()
    }
  }

  unmount(host: HTMLElement): void {
    if (this.host !== host) {
      return
    }

    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.cancelControllerResizeIntent(false)
    this.wrapper?.remove()
    this.host = null
  }

  focus(): void {
    this.terminal?.focus()
  }

  takeControl(): void {
    const dimensions = normalizeTerminalDimensions(
      this.proposedDimensions ?? {
        cols: this.canonicalCols,
        rows: this.canonicalRows
      }
    )
    this.send(
      'take_control',
      this.serverProtocolVersion === TERMINAL_PROTOCOL_VERSION
        ? { generation: this.controllerGeneration, ...dimensions }
        : { generation: this.controllerGeneration }
    )
  }

  retry(): void {
    if (this.disposed || this.ready) {
      return
    }

    if (this.renderFailed) {
      // A rejected render queue must never be reused. Reloading reconstructs
      // xterm, its DOM listeners, and the queue before reconnecting.
      window.location.reload()
      return
    }

    this.reconnectAllowed = true
    this.update({ error: null, phase: 'connecting', degraded: false })
    if (this.socket) {
      this.socket.connect()
    } else {
      this.connect()
    }
  }

  sendText(data: string): void {
    this.prepareScrollExit()

    if (this.canInput()) {
      this.send('input', { generation: this.controllerGeneration, data })
    }

    this.focus()
  }

  sendArrow(direction: ArrowDirection, alt = false): void {
    const final = { up: 'A', down: 'B', right: 'C', left: 'D' }[direction]
    const prefix = this.terminal?.modes.applicationCursorKeysMode
      ? '\u001bO'
      : '\u001b['
    this.sendText(`${alt ? '\u001b' : ''}${prefix}${final}`)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.reconnectAllowed = false
    this.clearTimers()
    this.resizeObserver?.disconnect()
    this.socket?.disconnect()
    this.socket = null
    this.wrapper?.remove()
    this.terminal?.dispose()
    this.terminal = null
    this.fitAddon = null
    this.wrapper = null
    this.listeners.clear()
  }

  private openTerminal(): void {
    if (!this.wrapper || this.opened) {
      return
    }

    const terminal = new Terminal(terminalOptions())
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon(activateTerminalLink))
    terminal.open(this.wrapper)
    this.wrapper.addEventListener(
      'mousedown',
      (event) => forcePlainSelectionWhileMouseReporting(event, terminal),
      true
    )
    trackTerminalScrolling(
      this.wrapper,
      terminal,
      () => {
        this.scrollExitPending = true
      },
      () => this.prepareScrollExit()
    )
    const wrapper = this.wrapper
    const transfersFiles = (transfer: DataTransfer | null) =>
      Boolean(
        transfer &&
        (Array.from(transfer.types).includes('Files') ||
          Array.from(transfer.items).some((item) => item.kind === 'file'))
      )
    const filesFromTransfer = (transfer: DataTransfer | null): File[] => {
      const files = Array.from(transfer?.files ?? [])
      if (files.length) {
        return files
      }

      return Array.from(transfer?.items ?? []).flatMap((item) => {
        const file = item.kind === 'file' ? item.getAsFile() : null
        return file ? [file] : []
      })
    }
    wrapper.addEventListener('dragover', (event) => {
      if (!transfersFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      event.dataTransfer!.dropEffect = 'copy'
      wrapper.classList.add('terminal-file-drag')
    })
    wrapper.addEventListener('dragleave', (event) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !wrapper.contains(event.relatedTarget)
      ) {
        wrapper.classList.remove('terminal-file-drag')
      }
    })
    wrapper.addEventListener('drop', (event) => {
      if (!transfersFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      wrapper.classList.remove('terminal-file-drag')
      this.queueFileUpload(filesFromTransfer(event.dataTransfer))
    })
    wrapper.addEventListener(
      'paste',
      (event) => {
        const files = filesFromTransfer(event.clipboardData)
        if (!files.length) {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        this.queueFileUpload(files)
      },
      true
    )
    this.terminal = terminal
    this.fitAddon = fitAddon
    this.opened = true
    terminal.attachCustomKeyEventHandler((event) => {
      const input = terminalKeyboardInput(
        event,
        terminal.modes.applicationCursorKeysMode
      )
      if (input === null) {
        return true
      }

      event.preventDefault()
      event.stopPropagation()
      this.prepareScrollExit()
      terminal.input(input, true)
      return false
    })
    terminal.onKey(() => this.prepareScrollExit())
    terminal.onData((data) => {
      if (this.canInput()) {
        this.send('input', {
          generation: this.controllerGeneration,
          data: this.withScrollExit(data)
        })
      }
    })
    terminal.onBinary((data) => {
      if (this.canInput()) {
        this.send('binary', {
          generation: this.controllerGeneration,
          data: this.withScrollExit(data)
        })
      }
    })
    terminal.onTitleChange((title) =>
      this.update({ title: title.trim().slice(0, 256) })
    )
    terminal.onBell(() => this.handleBell())
  }

  private queueFileUpload(files: File[]): void {
    this.fileTransferQueue = this.fileTransferQueue
      .catch(() => undefined)
      .then(() => this.uploadFiles(files))
  }

  private async uploadFiles(files: File[]): Promise<void> {
    if (!files.length || this.disposed) {
      return
    }

    if (files.length > TERMINAL_MAX_FILES_PER_TRANSFER) {
      this.showFileTransferError(
        `Choose no more than ${TERMINAL_MAX_FILES_PER_TRANSFER} files at a time`
      )
      return
    }

    if (!this.ready || !this.snapshotValue.controller) {
      this.showFileTransferError('Take control of the terminal first')
      return
    }

    if (!this.canInput()) {
      this.showFileTransferError('Wait for the terminal resize to finish')
      return
    }

    if (this.fileTransferTimer !== null) {
      window.clearTimeout(this.fileTransferTimer)
      this.fileTransferTimer = null
    }

    this.update({
      fileTransfer: {
        state: 'uploading',
        message: `Uploading ${files.length === 1 ? 'file' : `${files.length} files`}…`
      }
    })

    try {
      const paths: string[] = []
      for (const file of files) {
        paths.push(await apiClient.uploadTerminalFile(this.terminalId, file))
      }

      if (this.disposed) {
        return
      }

      if (!this.ready || !this.snapshotValue.controller) {
        this.showFileTransferError(
          'Terminal control was lost during the upload'
        )
        return
      }

      if (!this.canInput()) {
        this.showFileTransferError('Wait for the terminal resize to finish')
        return
      }

      const input = paths.join(' ')
      if (
        new TextEncoder().encode(input).byteLength >
        TERMINAL_MAX_INPUT_BYTES - 32
      ) {
        this.showFileTransferError('The uploaded file paths are too long')
        return
      }

      this.prepareScrollExit()
      this.terminal?.paste(input)
      this.focus()
      this.update({ fileTransfer: null })
    } catch (error) {
      if (!this.disposed) {
        this.showFileTransferError(
          error instanceof Error ? error.message : 'File upload failed'
        )
      }
    }
  }

  private showFileTransferError(message: string): void {
    if (this.fileTransferTimer !== null) {
      window.clearTimeout(this.fileTransferTimer)
    }

    this.update({
      fileTransfer: {
        state: 'error',
        message: `Couldn’t paste file: ${message}`
      }
    })
    this.fileTransferTimer = window.setTimeout(() => {
      this.fileTransferTimer = null
      this.update({ fileTransfer: null })
    }, 6_000)
  }

  private prepareScrollExit(): void {
    if (this.scrollExitPending) {
      this.resumeOnNextInput = true
    }
  }

  private withScrollExit(data: string): string {
    if (!this.resumeOnNextInput) {
      return data
    }

    this.scrollExitPending = false
    this.resumeOnNextInput = false
    this.wrapper?.classList.remove('terminal-scrolling')
    return `${TERMINAL_SCROLL_EXIT_SEQUENCE}${data}`
  }

  private connect(): void {
    if (this.disposed || !this.reconnectAllowed || this.socket) {
      return
    }

    this.ready = false
    this.update({ phase: 'connecting', controller: false, error: null })
    this.startDegradedTimer()
    const socket: Socket<
      TerminalServerToClientEvents,
      TerminalClientToServerEvents
    > = io('/terminals', {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      forceNew: true,
      multiplex: false,
      autoConnect: false,
      reconnection: true,
      retries: 0,
      query: { terminalProtocol: String(TERMINAL_PROTOCOL_VERSION) },
      auth: (authorize) => {
        const dimensions = normalizeTerminalDimensions(
          this.proposedDimensions ?? {
            cols: this.terminal?.cols ?? 100,
            rows: this.terminal?.rows ?? 30
          }
        )
        authorize({
          terminalId: this.terminalId,
          clientId: getClientId(),
          ...dimensions
        })
      }
    })
    this.socket = socket
    socket.on('connect', () => {
      if (this.socket !== socket) {
        return
      }

      this.fit()
    })
    socket.on('ready', (value) => this.handleServerEvent('ready', value))
    socket.on('dimensions', (value) =>
      this.handleServerEvent('dimensions', value)
    )
    socket.on('output', (value) => this.handleServerEvent('output', value))
    socket.on('title', (value) => this.handleServerEvent('title', value))
    socket.on('progress', (value) => this.handleServerEvent('progress', value))
    socket.on('control', (value) => this.handleServerEvent('control', value))
    socket.on('exit', (value) => this.handleServerEvent('exit', value))
    socket.on('terminal_error', (value) =>
      this.handleServerEvent('terminal_error', value)
    )
    socket.on('connect_error', (error) => {
      if (this.socket !== socket || !this.reconnectAllowed) {
        return
      }

      this.update({
        phase: 'reconnecting',
        controller: false,
        error: `Terminal connection failed: ${error.message}`
      })
    })
    socket.on('disconnect', (reason) => {
      if (this.socket !== socket) {
        return
      }

      const connected = this.ready
      this.ready = false
      this.streamId = null
      this.controllerGeneration = 0
      this.cancelControllerResizeIntent()
      if (!this.reconnectAllowed) {
        this.clearDegraded()
      }

      this.update({
        phase:
          this.reconnectAllowed && !this.disposed ? 'reconnecting' : 'closed',
        controller: false,
        degraded: this.reconnectAllowed ? this.snapshotValue.degraded : false,
        error:
          !connected && !this.snapshotValue.error
            ? `Terminal connection closed: ${reason}`
            : this.snapshotValue.error
      })
    })
    socket.io.on('reconnect_attempt', () => {
      if (this.socket === socket && this.reconnectAllowed) {
        this.startDegradedTimer()
        this.update({ phase: 'reconnecting', controller: false })
      }
    })
    socket.connect()
  }

  private handleServerEvent(event: TerminalServerEvent, value: unknown): void {
    if (event === 'ready') {
      const message = parseTerminalServerEvent('ready', value)
      if (!message) {
        this.failProtocol('The terminal server sent an invalid ready event')
        return
      }

      this.cancelControllerResizeIntent()
      const v2 = 'revision' in message
      this.serverProtocolVersion = v2 ? TERMINAL_PROTOCOL_VERSION : 1
      const dimensions = v2
        ? { cols: message.cols, rows: message.rows }
        : normalizeTerminalDimensions(
            this.proposedDimensions ?? {
              cols: this.terminal?.cols ?? 100,
              rows: this.terminal?.rows ?? 30
            }
          )
      const revision = v2 ? message.revision : 1
      this.streamId = message.streamId
      this.controllerGeneration = message.generation
      this.canonicalCols = dimensions.cols
      this.canonicalRows = dimensions.rows
      this.canonicalRevision = revision
      this.appliedRevision = v2 ? 0 : revision
      this.expectedSequence = 1
      this.lastParsedSequence = 0
      this.parsedSequences.clear()
      this.ready = true
      this.renderEpoch += 1
      const epoch = this.renderEpoch
      this.enqueueRender(epoch, async () => {
        await this.drainTerminalWrites()
        if (this.disposed || epoch !== this.renderEpoch) {
          return
        }

        this.terminal?.reset()
        if (v2) {
          this.applyCanonicalDimensions(
            dimensions.cols,
            dimensions.rows,
            revision,
            true
          )
        } else {
          this.fit(true)
        }
      })
      this.clearDegraded()
      this.update({
        phase: 'ready',
        controller: message.controller,
        error: null
      })
      return
    }

    if (event === 'dimensions') {
      if (this.serverProtocolVersion !== TERMINAL_PROTOCOL_VERSION) {
        this.failProtocol('The legacy terminal server sent dimensions')
        return
      }

      const message = parseTerminalServerEvent('dimensions', value)
      if (!message) {
        this.failProtocol('The terminal server sent invalid dimensions')
        return
      }

      if (message.revision <= this.canonicalRevision) {
        return
      }

      this.canonicalCols = message.cols
      this.canonicalRows = message.rows
      this.canonicalRevision = message.revision
      this.resizePending = false
      const epoch = this.renderEpoch
      this.enqueueRender(epoch, async () => {
        await this.drainTerminalWrites()
        if (this.disposed || epoch !== this.renderEpoch) {
          return
        }

        this.applyCanonicalDimensions(
          message.cols,
          message.rows,
          message.revision
        )
        this.flushControllerResize()
      })
      return
    }

    if (event === 'output') {
      const message = parseTerminalServerEvent('output', value)
      if (!message) {
        this.failProtocol('The terminal server sent invalid output')
        return
      }

      this.handleOutput(message.streamId, message.sequence, message.data)
      return
    }

    if (event === 'title') {
      const message = parseTerminalServerEvent('title', value)
      if (!message) {
        this.failProtocol('The terminal server sent an invalid title')
        return
      }

      this.update({ title: message.title.trim().slice(0, 256) })
      return
    }

    if (event === 'progress') {
      if (!parseTerminalServerEvent('progress', value)) {
        this.failProtocol('The terminal server sent invalid progress')
      }

      // Product-event metadata remains the web progress authority.
      return
    }

    if (event === 'control') {
      const message = parseTerminalServerEvent('control', value)
      if (!message) {
        this.failProtocol('The terminal server sent invalid controller state')
        return
      }

      const controllerChanged =
        message.controller !== this.snapshotValue.controller ||
        message.generation !== this.controllerGeneration
      if (controllerChanged) {
        this.cancelControllerResizeIntent()
      }

      this.controllerGeneration = message.generation
      this.update({ controller: message.controller })
      if (controllerChanged) {
        this.scheduleFit()
      }

      return
    }

    if (event === 'exit') {
      if (!parseTerminalServerEvent('exit', value)) {
        this.failProtocol('The terminal server sent an invalid exit event')
        return
      }

      this.update({ exitSerial: this.snapshotValue.exitSerial + 1 })
      return
    }

    const message = parseTerminalServerEvent('terminal_error', value)
    if (!message) {
      this.failProtocol('The terminal server sent an invalid error event')
      return
    }

    this.reconnectAllowed = message.retryable
    this.terminal?.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`)
    if (message.retryable) {
      this.update({ error: message.message })
    } else {
      this.stopWithError(message.message)
      this.socket?.disconnect()
    }
  }

  private handleOutput(streamId: string, sequence: number, data: string): void {
    if (
      !this.ready ||
      streamId !== this.streamId ||
      sequence !== this.expectedSequence
    ) {
      this.failProtocol('Terminal output arrived out of order')
      return
    }

    this.expectedSequence += 1
    const epoch = this.renderEpoch
    this.enqueueRender(epoch, () => {
      const terminal = this.terminal
      if (!terminal) {
        return
      }

      this.pendingTerminalWrites += 1
      terminal.write(data, () => {
        this.pendingTerminalWrites = Math.max(0, this.pendingTerminalWrites - 1)
        if (
          this.ready &&
          epoch === this.renderEpoch &&
          streamId === this.streamId
        ) {
          this.parsedSequences.add(sequence)
          while (this.parsedSequences.delete(this.lastParsedSequence + 1)) {
            this.lastParsedSequence += 1
          }
          this.send('output_ack', {
            streamId,
            sequence: this.lastParsedSequence
          })
        }
      })
    })
  }

  private async drainTerminalWrites(): Promise<void> {
    const terminal = this.terminal
    if (!terminal || this.pendingTerminalWrites === 0) {
      return
    }

    // xterm write callbacks are FIFO and run after parsing, so an empty write
    // marks a boundary without forcing every preceding chunk into its own cycle.
    await new Promise<void>((resolve) => terminal.write('', resolve))
  }

  private enqueueRender(
    epoch: number,
    operation: () => Promise<void> | void
  ): void {
    const queued = this.renderQueue.then(async () => {
      if (this.disposed || this.renderFailed || epoch !== this.renderEpoch) {
        return
      }

      await operation()
    })
    this.renderQueue = queued
    // Rendering is a fatal UI boundary: keep the causal queue rejected so no
    // later operation runs, while observing the rejection to close explicitly.
    void queued.catch((error: unknown) => this.failRendering(error))
  }

  private applyCanonicalDimensions(
    cols: number,
    rows: number,
    revision: number,
    queueControllerResize = false
  ): void {
    if (!this.terminal || revision <= this.appliedRevision) {
      return
    }

    this.terminal.resize(cols, rows)
    this.appliedRevision = revision
    if (this.wrapper) {
      this.wrapper.dataset.terminalCols = String(cols)
      this.wrapper.dataset.terminalRows = String(rows)
      this.wrapper.dataset.terminalRevision = String(revision)
    }

    if (revision === this.canonicalRevision) {
      this.fit(queueControllerResize)
    }
  }

  private canInput(): boolean {
    return (
      this.ready &&
      this.snapshotValue.controller &&
      !this.resizePending &&
      this.appliedRevision === this.canonicalRevision
    )
  }

  private send<E extends keyof TerminalClientToServerEvents>(
    event: E,
    payload: Parameters<TerminalClientToServerEvents[E]>[0]
  ): void {
    if (!this.socket?.connected || !this.ready) {
      return
    }

    if (
      event === 'output_ack' ||
      event === 'resize' ||
      event === 'take_control'
    ) {
      ;(this.socket.emit as (event: string, payload: unknown) => void)(
        event,
        payload
      )
      return
    }

    ;(this.socket.volatile.emit as (event: string, payload: unknown) => void)(
      event,
      payload
    )
  }

  private scheduleFit(): void {
    if (this.resizeFrame !== null) {
      cancelAnimationFrame(this.resizeFrame)
    }

    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null
      this.fit(true)
    })
  }

  private queueControllerResizeIntent(): void {
    if (this.resizeSettleTimer !== null) {
      window.clearTimeout(this.resizeSettleTimer)
    }

    this.resizeIntentDirty = true
    this.resizeQuietElapsed = false
    this.resizeIntentGeneration = this.controllerGeneration
    this.resizeSettleTimer = window.setTimeout(() => {
      this.resizeSettleTimer = null
      this.resizeQuietElapsed = true
      this.flushControllerResize()
    }, TERMINAL_RESIZE_SETTLE_MS)
  }

  private flushControllerResize(): void {
    const proposed = this.proposedDimensions
    if (
      !this.resizeIntentDirty ||
      !this.resizeQuietElapsed ||
      !proposed ||
      !this.host ||
      !this.ready ||
      !this.socket?.connected ||
      !this.snapshotValue.controller ||
      this.resizeIntentGeneration !== this.controllerGeneration ||
      this.appliedRevision !== this.canonicalRevision ||
      this.resizePending
    ) {
      return
    }

    if (
      proposed.cols === this.canonicalCols &&
      proposed.rows === this.canonicalRows
    ) {
      this.resizeIntentDirty = false
      this.resizeQuietElapsed = false
      return
    }

    this.resizeIntentDirty = false
    this.resizeQuietElapsed = false
    if (this.serverProtocolVersion === TERMINAL_PROTOCOL_VERSION) {
      this.resizePending = true
    } else {
      this.canonicalCols = proposed.cols
      this.canonicalRows = proposed.rows
      this.appliedRevision = this.canonicalRevision
    }

    this.send('resize', {
      generation: this.controllerGeneration,
      cols: proposed.cols,
      rows: proposed.rows
    })
  }

  private cancelControllerResizeIntent(clearPending = true): void {
    if (this.resizeSettleTimer !== null) {
      window.clearTimeout(this.resizeSettleTimer)
    }

    this.resizeSettleTimer = null
    if (clearPending) {
      this.resizePending = false
    }

    this.resizeIntentDirty = false
    this.resizeQuietElapsed = false
    this.resizeIntentGeneration = 0
    this.proposedDimensions = null
  }

  private fit(queueControllerResize = false): void {
    if (!this.host || !this.fitAddon || !this.terminal) {
      return
    }

    try {
      if (!this.ready) {
        this.terminal.options.fontSize = TERMINAL_FONT_SIZE
        this.fitAddon.fit()
        if (
          this.terminal.cols >= TERMINAL_MIN_COLS &&
          this.terminal.rows >= TERMINAL_MIN_ROWS
        ) {
          this.proposedDimensions = normalizeTerminalDimensions({
            cols: this.terminal.cols,
            rows: this.terminal.rows
          })
        }

        return
      }

      if (this.serverProtocolVersion === 1) {
        this.terminal.options.fontSize = TERMINAL_FONT_SIZE
        this.fitAddon.fit()
        if (
          this.terminal.cols < TERMINAL_MIN_COLS ||
          this.terminal.rows < TERMINAL_MIN_ROWS
        ) {
          this.cancelControllerResizeIntent(false)
          return
        }

        const proposed = normalizeTerminalDimensions({
          cols: this.terminal.cols,
          rows: this.terminal.rows
        })
        this.proposedDimensions = proposed
        if (this.snapshotValue.controller && queueControllerResize) {
          this.queueControllerResizeIntent()
        }

        return
      }

      if (this.appliedRevision !== this.canonicalRevision) {
        return
      }

      this.terminal.options.fontSize = TERMINAL_FONT_SIZE
      const proposedDimensions = this.fitAddon.proposeDimensions()
      if (
        !proposedDimensions ||
        !Number.isFinite(proposedDimensions.cols) ||
        !Number.isFinite(proposedDimensions.rows) ||
        proposedDimensions.cols < TERMINAL_MIN_COLS ||
        proposedDimensions.rows < TERMINAL_MIN_ROWS
      ) {
        if (this.snapshotValue.controller) {
          this.cancelControllerResizeIntent(false)
        }

        return
      }

      const proposed = normalizeTerminalDimensions(proposedDimensions)
      this.proposedDimensions = proposed
      if (this.snapshotValue.controller) {
        if (!queueControllerResize) {
          return
        }

        if (
          !this.resizePending &&
          proposed.cols === this.canonicalCols &&
          proposed.rows === this.canonicalRows
        ) {
          if (this.resizeSettleTimer !== null) {
            window.clearTimeout(this.resizeSettleTimer)
          }

          this.resizeSettleTimer = null
          this.resizeIntentDirty = false
          this.resizeQuietElapsed = false
          return
        }

        this.queueControllerResizeIntent()
        return
      }

      const scale = Math.min(
        1,
        proposed.cols / this.canonicalCols,
        proposed.rows / this.canonicalRows
      )
      this.terminal.options.fontSize = Math.max(
        TERMINAL_MIN_VIEWER_FONT_SIZE,
        Math.floor(TERMINAL_FONT_SIZE * scale * 100) / 100
      )
      if (
        this.terminal.cols !== this.canonicalCols ||
        this.terminal.rows !== this.canonicalRows
      ) {
        this.terminal.resize(this.canonicalCols, this.canonicalRows)
      }
    } catch (error) {
      // Fit is the DOM/render transition boundary. Missing dimensions are
      // represented above; actual xterm/FitAddon failures close the session.
      this.failRendering(error)
    }
  }

  private startDegradedTimer(): void {
    if (this.degradedTimer !== null) {
      return
    }

    this.degradedTimer = window.setTimeout(() => {
      this.degradedTimer = null
      if (!this.ready) {
        this.update({ degraded: true })
      }
    }, 500)
  }

  private clearDegraded(): void {
    if (this.degradedTimer !== null) {
      window.clearTimeout(this.degradedTimer)
    }

    this.degradedTimer = null
    this.update({ degraded: false })
  }

  private handleBell(): void {
    const now = Date.now()
    if (now - this.lastBellAt < 1_000) {
      return
    }

    this.lastBellAt = now
    if (this.bellTimer !== null) {
      window.clearTimeout(this.bellTimer)
    }

    this.update({
      bellActive: true,
      bellSerial: this.snapshotValue.bellSerial + 1
    })
    this.bellTimer = window.setTimeout(() => {
      this.bellTimer = null
      this.update({ bellActive: false })
    }, 180)
  }

  private failRendering(error: unknown): void {
    if (this.renderFailed || this.disposed) {
      return
    }

    this.renderFailed = true
    const detail = (
      error instanceof Error ? error.message : String(error)
    ).trim()
    this.reconnectAllowed = false
    this.stopWithError(
      detail
        ? `Terminal rendering failed: ${detail.slice(0, 500)}`
        : 'Terminal rendering failed'
    )
    this.socket?.disconnect()
  }

  private failProtocol(message: string): void {
    this.reconnectAllowed = false
    this.stopWithError(message)
    this.socket?.disconnect()
  }

  private stopWithError(message: string): void {
    this.ready = false
    this.clearDegraded()
    this.update({
      error: message,
      phase: 'closed',
      degraded: false,
      controller: false
    })
  }

  private update(patch: Partial<TerminalSessionSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  private clearTimers(): void {
    if (this.degradedTimer !== null) {
      window.clearTimeout(this.degradedTimer)
    }

    if (this.bellTimer !== null) {
      window.clearTimeout(this.bellTimer)
    }

    if (this.fileTransferTimer !== null) {
      window.clearTimeout(this.fileTransferTimer)
    }

    if (this.resizeFrame !== null) {
      cancelAnimationFrame(this.resizeFrame)
    }

    if (this.resizeSettleTimer !== null) {
      window.clearTimeout(this.resizeSettleTimer)
    }

    this.degradedTimer = null
    this.bellTimer = null
    this.fileTransferTimer = null
    this.resizeFrame = null
    this.resizeSettleTimer = null
    this.resizePending = false
    this.resizeIntentDirty = false
    this.resizeQuietElapsed = false
    this.resizeIntentGeneration = 0
    this.proposedDimensions = null
  }
}

interface SessionEntry {
  session: TerminalSession
  references: number
  lastUsed: number
  idleTimer: number | null
  lastTitle: string | null
  unsubscribe: () => void
}

interface BellMetadata {
  sequence: number
  unread: boolean
}

export class TerminalSessionManager {
  private readonly entries = new Map<string, SessionEntry>()
  private readonly listeners = new Set<() => void>()
  private attentionSnapshot: ReadonlySet<string> = new Set()
  private titleSnapshot: ReadonlyMap<string, string> = new Map()
  private foregroundProcessSnapshot: ReadonlySet<string> = new Set()
  private progressSnapshot: ReadonlyMap<string, TerminalProgress> = new Map()
  private bellMetadata = new Map<string, BellMetadata>()
  private bellAcknowledgementTargets = new Map<string, number>()
  private bellAcknowledgementQueues = new Map<string, Promise<void>>()
  private bellAcknowledgementEpoch = 0

  constructor(
    private readonly maxSessions = 3,
    private readonly idleMs = 5 * 60_000,
    private readonly createSession: (terminalId: string) => TerminalSession = (
      terminalId
    ) => new TerminalSession(terminalId),
    private readonly acknowledgeBell: (
      terminalId: string,
      sequence: number
    ) => Promise<unknown> = (terminalId, sequence) =>
      apiClient.acknowledgeTerminalBell(terminalId, sequence)
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getAttentionSnapshot = (): ReadonlySet<string> => this.attentionSnapshot
  getTitleSnapshot = (): ReadonlyMap<string, string> => this.titleSnapshot
  getForegroundProcessSnapshot = (): ReadonlySet<string> =>
    this.foregroundProcessSnapshot
  getProgressSnapshot = (): ReadonlyMap<string, TerminalProgress> =>
    this.progressSnapshot

  getInitialSize(terminalId: string): TerminalSize | null {
    return this.entries.get(terminalId)?.session.getInitialSize() ?? null
  }

  applyRuntimeMetadata(metadata: TerminalRuntimeMetadata): void {
    const currentBell = this.bellMetadata.get(metadata.terminalId)
    const incomingBell = metadata.bell
    const bellIsCurrent =
      incomingBell !== null &&
      (!currentBell ||
        incomingBell.sequence > currentBell.sequence ||
        (incomingBell.sequence === currentBell.sequence &&
          (currentBell.unread || !incomingBell.unread)))
    if (bellIsCurrent) {
      this.bellMetadata.set(metadata.terminalId, {
        sequence: incomingBell.sequence,
        unread: incomingBell.unread
      })
      this.setAttention(metadata.terminalId, incomingBell.unread)
    } else if (!currentBell && incomingBell === null) {
      this.setAttention(metadata.terminalId, false)
    }

    this.setRuntimeTitle(metadata.terminalId, metadata.title)
    this.setForegroundProcess(
      metadata.terminalId,
      metadata.hasForegroundProcess === true
    )
    this.setProgress(metadata.terminalId, metadata.progress)
    this.acknowledgeVisibleBell(metadata.terminalId)
  }

  replaceRuntimeMetadata(metadata: Iterable<TerminalRuntimeMetadata>): void {
    const titles = new Map<string, string>()
    const foregroundProcesses = new Set<string>()
    const progress = new Map<string, TerminalProgress>()
    const bells = new Map<string, BellMetadata>()
    const attention = new Set<string>()
    for (const item of metadata) {
      const title = item.title?.trim().slice(0, 256)
      if (title) {
        titles.set(item.terminalId, title)
      }

      if (item.hasForegroundProcess) {
        foregroundProcesses.add(item.terminalId)
      }

      if (item.progress) {
        progress.set(item.terminalId, item.progress)
      }

      if (item.bell) {
        bells.set(item.terminalId, {
          sequence: item.bell.sequence,
          unread: item.bell.unread
        })
        if (item.bell.unread) {
          attention.add(item.terminalId)
        }
      }
    }
    const titlesChanged =
      titles.size !== this.titleSnapshot.size ||
      [...titles].some(
        ([terminalId, title]) => this.titleSnapshot.get(terminalId) !== title
      )
    const foregroundProcessesChanged =
      foregroundProcesses.size !== this.foregroundProcessSnapshot.size ||
      [...foregroundProcesses].some(
        (terminalId) => !this.foregroundProcessSnapshot.has(terminalId)
      )
    const progressChanged =
      progress.size !== this.progressSnapshot.size ||
      [...progress].some(([terminalId, value]) => {
        const current = this.progressSnapshot.get(terminalId)
        return current?.state !== value.state || current.value !== value.value
      })
    const attentionChanged =
      attention.size !== this.attentionSnapshot.size ||
      [...attention].some(
        (terminalId) => !this.attentionSnapshot.has(terminalId)
      )
    this.bellMetadata = bells
    this.bellAcknowledgementEpoch += 1
    this.bellAcknowledgementTargets.clear()

    if (titlesChanged) {
      this.titleSnapshot = titles
    }

    if (foregroundProcessesChanged) {
      this.foregroundProcessSnapshot = foregroundProcesses
    }

    if (progressChanged) {
      this.progressSnapshot = progress
    }

    if (attentionChanged) {
      this.attentionSnapshot = attention
    }

    if (
      titlesChanged ||
      foregroundProcessesChanged ||
      progressChanged ||
      attentionChanged
    ) {
      this.emit()
    }

    for (const terminalId of bells.keys()) {
      this.acknowledgeVisibleBell(terminalId)
    }
  }

  acquire(terminalId: string): TerminalSession {
    let entry = this.entries.get(terminalId)
    if (!entry) {
      const session = this.createSession(terminalId)
      entry = {
        session,
        references: 0,
        lastUsed: Date.now(),
        idleTimer: null,
        lastTitle: session.getSnapshot().title,
        unsubscribe: () => undefined
      }
      const observedEntry = entry
      entry.unsubscribe = session.subscribe(() => {
        const snapshot = session.getSnapshot()
        if (snapshot.title !== observedEntry.lastTitle) {
          observedEntry.lastTitle = snapshot.title
          this.setRuntimeTitle(terminalId, snapshot.title)
        }
      })
      this.entries.set(terminalId, entry)
      if (entry.lastTitle) {
        this.setRuntimeTitle(terminalId, entry.lastTitle)
      }
    }

    entry.references += 1
    entry.lastUsed = Date.now()
    this.acknowledgeVisibleBell(terminalId)
    if (entry.idleTimer !== null) {
      window.clearTimeout(entry.idleTimer)
    }

    entry.idleTimer = null
    this.evictOverCapacity(terminalId)
    return entry.session
  }

  release(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) {
      return
    }

    entry.references = Math.max(0, entry.references - 1)
    entry.lastUsed = Date.now()
    if (entry.references === 0 && entry.idleTimer === null) {
      entry.idleTimer = window.setTimeout(
        () => this.evictSession(terminalId),
        this.idleMs
      )
    }
  }

  forget(terminalId: string): void {
    this.disposeEntry(terminalId)
    this.bellMetadata.delete(terminalId)
    this.bellAcknowledgementTargets.delete(terminalId)
    this.bellAcknowledgementQueues.delete(terminalId)
    this.clearAttention(terminalId)
    this.clearRuntimeTitle(terminalId)
    this.setForegroundProcess(terminalId, false)
    this.setProgress(terminalId, null)
  }

  private clearAttention(terminalId: string): void {
    if (!this.attentionSnapshot.has(terminalId)) {
      return
    }

    const next = new Set(this.attentionSnapshot)
    next.delete(terminalId)
    this.attentionSnapshot = next
    this.emit()
  }

  reconcile(terminals: Iterable<{ id: string }>): void {
    const valid = new Set([...terminals].map((terminal) => terminal.id))
    for (const terminalId of this.entries.keys()) {
      if (!valid.has(terminalId)) {
        this.disposeEntry(terminalId)
      }
    }
    let changed = false
    const attention = new Set(this.attentionSnapshot)
    const titles = new Map(this.titleSnapshot)
    const foregroundProcesses = new Set(this.foregroundProcessSnapshot)
    const progress = new Map(this.progressSnapshot)
    for (const terminalId of attention) {
      if (!valid.has(terminalId)) {
        attention.delete(terminalId)
        changed = true
      }
    }
    for (const terminalId of titles.keys()) {
      if (!valid.has(terminalId)) {
        titles.delete(terminalId)
        changed = true
      }
    }
    for (const terminalId of foregroundProcesses) {
      if (!valid.has(terminalId)) {
        foregroundProcesses.delete(terminalId)
        changed = true
      }
    }
    for (const terminalId of progress.keys()) {
      if (!valid.has(terminalId)) {
        progress.delete(terminalId)
        changed = true
      }
    }
    for (const terminalId of this.bellMetadata.keys()) {
      if (!valid.has(terminalId)) {
        this.bellMetadata.delete(terminalId)
        this.bellAcknowledgementTargets.delete(terminalId)
        this.bellAcknowledgementQueues.delete(terminalId)
      }
    }
    if (changed) {
      this.attentionSnapshot = attention
      this.titleSnapshot = titles
      this.foregroundProcessSnapshot = foregroundProcesses
      this.progressSnapshot = progress
      this.emit()
    }
  }

  private setRuntimeTitle(terminalId: string, value: string | null): void {
    const title = value?.trim().slice(0, 256) || null
    if (title === null) {
      this.clearRuntimeTitle(terminalId)
      return
    }

    if (this.titleSnapshot.get(terminalId) === title) {
      return
    }

    this.titleSnapshot = new Map(this.titleSnapshot).set(terminalId, title)
    this.emit()
  }

  private clearRuntimeTitle(terminalId: string): void {
    if (!this.titleSnapshot.has(terminalId)) {
      return
    }

    const titles = new Map(this.titleSnapshot)
    titles.delete(terminalId)
    this.titleSnapshot = titles
    this.emit()
  }

  private setForegroundProcess(
    terminalId: string,
    hasForegroundProcess: boolean
  ): void {
    if (
      this.foregroundProcessSnapshot.has(terminalId) === hasForegroundProcess
    ) {
      return
    }

    const next = new Set(this.foregroundProcessSnapshot)
    if (hasForegroundProcess) {
      next.add(terminalId)
    } else {
      next.delete(terminalId)
    }

    this.foregroundProcessSnapshot = next
    this.emit()
  }

  private setAttention(terminalId: string, unread: boolean): void {
    if (!unread) {
      this.bellAcknowledgementTargets.delete(terminalId)
    }

    if (this.attentionSnapshot.has(terminalId) === unread) {
      return
    }

    const next = new Set(this.attentionSnapshot)
    if (unread) {
      next.add(terminalId)
    } else {
      next.delete(terminalId)
    }

    this.attentionSnapshot = next
    this.emit()
  }

  private acknowledgeVisibleBell(terminalId: string): void {
    const bell = this.bellMetadata.get(terminalId)
    if (
      !bell?.unread ||
      (this.entries.get(terminalId)?.references ?? 0) === 0 ||
      bell.sequence <= (this.bellAcknowledgementTargets.get(terminalId) ?? 0)
    ) {
      return
    }

    const sequence = bell.sequence
    const epoch = this.bellAcknowledgementEpoch
    this.bellAcknowledgementTargets.set(terminalId, sequence)
    const previous =
      this.bellAcknowledgementQueues.get(terminalId) ?? Promise.resolve()
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        const currentBell = this.bellMetadata.get(terminalId)
        if (
          this.bellAcknowledgementEpoch !== epoch ||
          (this.entries.get(terminalId)?.references ?? 0) === 0 ||
          currentBell?.sequence !== sequence ||
          !currentBell.unread
        ) {
          if (this.bellAcknowledgementTargets.get(terminalId) === sequence) {
            this.bellAcknowledgementTargets.delete(terminalId)
          }

          return
        }

        await this.acknowledgeBell(terminalId, sequence)
      })
      .then(
        () => undefined,
        () => {
          if (this.bellAcknowledgementTargets.get(terminalId) === sequence) {
            this.bellAcknowledgementTargets.delete(terminalId)
          }
        }
      )
      .finally(() => {
        if (this.bellAcknowledgementQueues.get(terminalId) === queued) {
          this.bellAcknowledgementQueues.delete(terminalId)
        }
      })
    this.bellAcknowledgementQueues.set(terminalId, queued)
  }

  private setProgress(
    terminalId: string,
    progress: TerminalProgress | null
  ): void {
    const current = this.progressSnapshot.get(terminalId)
    if (
      progress &&
      current?.state === progress.state &&
      current.value === progress.value
    ) {
      return
    }

    if (!progress && !current) {
      return
    }

    const next = new Map(this.progressSnapshot)
    if (progress) {
      next.set(terminalId, progress)
    } else {
      next.delete(terminalId)
    }

    this.progressSnapshot = next
    this.emit()
  }

  private evictSession(terminalId: string): void {
    this.disposeEntry(terminalId)
  }

  private disposeEntry(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) {
      return
    }

    if (entry.idleTimer !== null) {
      window.clearTimeout(entry.idleTimer)
    }

    entry.unsubscribe()
    entry.session.dispose()
    this.entries.delete(terminalId)
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }

  private evictOverCapacity(selectedId: string): void {
    while (this.entries.size > this.maxSessions) {
      const candidate = [...this.entries.entries()]
        .filter(([id, entry]) => id !== selectedId && entry.references === 0)
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0]
      if (!candidate) {
        return
      }

      this.evictSession(candidate[0])
    }
  }
}

export const terminalSessions = new TerminalSessionManager()
