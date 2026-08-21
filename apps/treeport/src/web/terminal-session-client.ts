import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { io, type Socket } from 'socket.io-client'
import { parseResponse } from 'hono/client'
import { z } from 'zod'
import { rpc } from './api'
import { errorMessage } from './error-message'
import {
  activateTerminalLink,
  TERMINAL_FONT_SIZE,
  terminalKeyboardInput,
  terminalOptions,
  trackTerminalScrolling,
  trackTerminalSelectionAutoscroll
} from './terminal-browser'
import {
  parseTerminalServerEvent,
  SOCKET_IO_PATH,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_UPLOAD_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  TERMINAL_SCROLL_EXIT_SEQUENCE,
  TERMINAL_SELECTION_CLEAR_SEQUENCE,
  TERMINAL_SELECTION_RESTORE_SEQUENCE,
  TERMINAL_SELECTION_START_SEQUENCE,
  TERMINAL_SELECTION_STOP_SEQUENCE,
  type TerminalClientToServerEvents,
  type TerminalServerEvent,
  type TerminalProtocolInput,
  type TerminalSize,
  type TerminalServerToClientEvents
} from '@treeport/shared'

type ConnectionPhase = 'connecting' | 'ready' | 'reconnecting' | 'closed'
export type TerminalSocketFactory = typeof io
export type ArrowDirection = 'up' | 'down' | 'left' | 'right'
export type TerminalFileTransfer = {
  state: 'uploading' | 'error'
  message: string
}

const TERMINAL_MAX_FILES_PER_TRANSFER = 8
const BROWSER_LOCAL_FILE_PATH_SCHEMA = z
  .string()
  .max(16_384)
  .startsWith('/')
  .refine((filePath) =>
    Array.from(filePath).every((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint > 31 && codePoint !== 127
    })
  )
const LOOPBACK_BROWSER_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
const TERMINAL_MAX_SELECTION_ENCODED_LENGTH = 8 * 1024 * 1024
const TERMINAL_MIN_VIEWER_FONT_SIZE = 4
const TERMINAL_MIN_COLS = 2
const TERMINAL_MAX_COLS = 1_000
const TERMINAL_MIN_ROWS = 2
const TERMINAL_MAX_ROWS = 500
const TERMINAL_RESIZE_SETTLE_MS = 150
const IOS_BROWSER_TOOLBAR_CLEARANCE = 44

function normalizeTerminalDimensions(
  dimensions: TerminalSize,
  fallback: TerminalSize = { cols: 100, rows: 30 }
): TerminalSize {
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

export interface TerminalSessionSnapshot {
  phase: ConnectionPhase
  degraded: boolean
  controller: boolean
  controlPending: boolean
  title: string | null
  bellActive: boolean
  bellSerial: number
  exitSerial: number
  fileTransfer: TerminalFileTransfer | null
  hasSelection: boolean
  selecting: boolean
  viewingHistory: boolean
  pasteRequestSerial: number
  error: string | null
}

const DEFAULT_SNAPSHOT: TerminalSessionSnapshot = {
  phase: 'closed',
  degraded: false,
  controller: false,
  controlPending: false,
  title: null,
  bellActive: false,
  bellSerial: 0,
  exitSerial: 0,
  fileTransfer: null,
  hasSelection: false,
  selecting: false,
  viewingHistory: false,
  pasteRequestSerial: 0,
  error: null
}

let fallbackClientId: string | null = null
function getClientId(): string {
  if (fallbackClientId) {
    return fallbackClientId
  }

  try {
    const stored = sessionStorage.getItem('treeport-terminal-client-id')
    if (stored) {
      sessionStorage.setItem('treeport-terminal-client-id', stored)
      return (fallbackClientId = stored)
    }
  } catch {
    // Storage can be unavailable in private browsing modes.
  }

  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) {
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
    sessionStorage.setItem('treeport-terminal-client-id', created)
  } catch {
    // The in-memory ID still keeps reconnects stable for this page load.
  }
  return (fallbackClientId = created)
}

const TERMINAL_CURSOR_RESTORE_DELAY_MS = 50
const TERMINAL_CURSOR_RESTORE_MAX_DELAY_MS = 250

export class TerminalSession {
  readonly terminalId: string
  private readonly listeners = new Set<() => void>()
  private snapshotValue: TerminalSessionSnapshot = DEFAULT_SNAPSHOT
  private terminal: Terminal | null = null
  private fitAddon: FitAddon | null = null
  private wrapper: HTMLDivElement | null = null
  private host: HTMLElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private keyboardViewportCleanup: (() => void) | null = null
  private desktopLocalFilePasteCleanup: (() => void) | null = null
  private socket: Socket<
    TerminalServerToClientEvents,
    TerminalClientToServerEvents
  > | null = null
  private degradedTimer: number | null = null
  private bellTimer: number | null = null
  private fileTransferTimer: number | null = null
  private cursorRestoreTimer: number | null = null
  private cursorRestoreStartedAt: number | null = null
  private fileTransferQueue: Promise<void> = Promise.resolve()
  private resizeFrame: number | null = null
  private resizeSettleTimer: number | null = null
  private disposed = false
  private opened = false
  private ready = false
  private reconnectAllowed = true
  private streamId: string | null = null
  private controllerGeneration = 0
  private controlRequestGeneration: number | null = null
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
  private historyExitRequested = false
  private selectionClearRequested = false
  private selectionDragCancel: (() => void) | null = null
  private tmuxSelectionPending = false
  private tmuxSelectionText: string | null = null
  private pendingPaste = ''
  private inputModifiers: {
    ctrl: boolean
    alt: boolean
    onConsumed: () => void
  } | null = null
  private lastBellAt = 0
  private wakeListenersAttached = false
  private readonly reconnectWhenOnline = () => this.reconnectImmediately()
  private readonly reconnectWhenVisible = () => {
    if (document.visibilityState === 'visible') {
      this.reconnectImmediately()
    }
  }

  constructor(
    terminalId: string,
    private readonly createSocket: TerminalSocketFactory = io
  ) {
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

    this.keyboardViewportCleanup?.()
    this.keyboardViewportCleanup = null
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    const viewport = window.visualViewport
    const appFrame = document.querySelector<HTMLElement>('.app-frame')
    if (isIOS && viewport && appFrame) {
      // WebKit leaves the layout viewport unchanged when the software keyboard
      // opens. Size and position the application against the visual viewport
      // instead of scrolling the document between the cursor and accessory row.
      let viewportFrame: number | null = null
      const syncKeyboardViewport = () => {
        if (viewportFrame !== null) {
          window.cancelAnimationFrame(viewportFrame)
        }

        viewportFrame = window.requestAnimationFrame(() => {
          viewportFrame = null
          const textarea = this.wrapper?.querySelector<HTMLTextAreaElement>(
            '.xterm-helper-textarea'
          )
          const keyboardOpen =
            document.activeElement === textarea &&
            viewport.height < document.documentElement.clientHeight - 100
          if (!keyboardOpen) {
            appFrame.style.removeProperty('--app-visual-viewport-height')
            appFrame.style.removeProperty('--app-visual-viewport-offset-top')
            return
          }

          const standalone =
            window.matchMedia('(display-mode: standalone)').matches ||
            Boolean(
              // SAFETY: The terminal protocol and xterm contracts establish this asserted value.
              (navigator as Navigator & { standalone?: boolean }).standalone
            )
          const browserToolbarGap = standalone
            ? 0
            : IOS_BROWSER_TOOLBAR_CLEARANCE
          appFrame.style.setProperty(
            '--app-visual-viewport-height',
            `${Math.max(0, viewport.height - browserToolbarGap)}px`
          )
          appFrame.style.setProperty(
            '--app-visual-viewport-offset-top',
            `${viewport.offsetTop}px`
          )
        })
      }
      viewport.addEventListener('resize', syncKeyboardViewport)
      viewport.addEventListener('scroll', syncKeyboardViewport)
      syncKeyboardViewport()
      this.keyboardViewportCleanup = () => {
        viewport.removeEventListener('resize', syncKeyboardViewport)
        viewport.removeEventListener('scroll', syncKeyboardViewport)
        if (viewportFrame !== null) {
          window.cancelAnimationFrame(viewportFrame)
        }

        appFrame.style.removeProperty('--app-visual-viewport-height')
        appFrame.style.removeProperty('--app-visual-viewport-offset-top')
      }
    }

    this.resizeObserver?.disconnect()
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit())
    this.resizeObserver.observe(host)
    if (!this.wakeListenersAttached) {
      window.addEventListener('online', this.reconnectWhenOnline)
      document.addEventListener('visibilitychange', this.reconnectWhenVisible)
      this.wakeListenersAttached = true
    }

    this.scheduleFit()
    if (!this.socket && this.opened) {
      this.connect()
    } else {
      this.reconnectImmediately()
    }
  }

  unmount(host: HTMLElement): void {
    if (this.host !== host) {
      return
    }

    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (this.wakeListenersAttached) {
      window.removeEventListener('online', this.reconnectWhenOnline)
      document.removeEventListener(
        'visibilitychange',
        this.reconnectWhenVisible
      )
      this.wakeListenersAttached = false
    }

    this.keyboardViewportCleanup?.()
    this.keyboardViewportCleanup = null
    this.cancelControllerResizeIntent(false)
    this.selectionDragCancel?.()
    this.wrapper?.remove()
    this.host = null
  }

  focus(options: { requestControl?: boolean } = {}): void {
    if (options.requestControl) {
      this.requestControl()
    }

    this.terminal?.focus()
  }

  requestControl(): void {
    if (
      !this.ready ||
      !this.socket?.connected ||
      this.snapshotValue.controller ||
      this.controlRequestGeneration === this.controllerGeneration
    ) {
      return
    }

    const dimensions = normalizeTerminalDimensions(
      this.proposedDimensions ?? {
        cols: this.canonicalCols,
        rows: this.canonicalRows
      }
    )
    this.controlRequestGeneration = this.controllerGeneration
    this.update({ controlPending: true })
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

  setInputModifiers(ctrl: boolean, alt: boolean, onConsumed: () => void): void {
    this.inputModifiers = ctrl || alt ? { ctrl, alt, onConsumed } : null
  }

  sendText(data: string, options: { focus?: boolean } = {}): void {
    this.requestControl()
    this.clearSelection()
    this.prepareScrollExit()

    if (this.canInput()) {
      this.send('input', {
        generation: this.controllerGeneration,
        data: this.withScrollExit(data)
      })
    }

    if (options.focus !== false) {
      this.focus()
    }
  }

  pasteText(data: string): void {
    if (!data) {
      return
    }

    this.requestControl()
    this.clearSelection()
    this.prepareScrollExit()
    if (this.canInput()) {
      this.terminal?.paste(data)
    } else {
      this.pendingPaste += data
    }

    this.focus()
  }

  pasteFiles(files: File[]): void {
    if (!files.length) {
      return
    }

    this.requestControl()
    this.queueFileTransfer(files)
  }

  sendArrow(
    direction: ArrowDirection,
    alt = false,
    options: { focus?: boolean } = {}
  ): void {
    const final = { up: 'A', down: 'B', right: 'C', left: 'D' }[direction]
    const prefix = this.terminal?.modes.applicationCursorKeysMode
      ? '\u001bO'
      : '\u001b['
    this.sendText(`${alt ? '\u001b' : ''}${prefix}${final}`, options)
  }

  jumpToLatest(): void {
    if (!this.ready) {
      return
    }

    this.historyExitRequested = true
    this.requestControl()
    if (this.canInput()) {
      this.sendHistoryExit()
    }

    this.focus()
  }

  copySelection(): void {
    const selection =
      this.tmuxSelectionText ?? this.terminal?.getSelection() ?? ''
    if (!selection) {
      return
    }

    // Clipboard.writeText is unavailable on non-HTTPS iOS installations.
    // execCommand remains the reliable synchronous path from a user gesture
    // there, provided the selected value lives in a real form control.
    const copyBuffer = document.createElement('textarea')
    copyBuffer.value = selection
    copyBuffer.readOnly = true
    copyBuffer.style.position = 'fixed'
    copyBuffer.style.left = '-9999px'
    copyBuffer.style.opacity = '0'
    document.body.appendChild(copyBuffer)
    copyBuffer.focus({ preventScroll: true })
    copyBuffer.select()
    copyBuffer.setSelectionRange(0, selection.length)
    const copied = document.execCommand('copy')
    copyBuffer.remove()

    if (!copied && navigator.clipboard) {
      void navigator.clipboard.writeText(selection)
    }

    this.focus()
  }

  clearSelectionAndJumpToLatest(): void {
    if (!this.ready) {
      return
    }

    this.historyExitRequested = true
    this.selectionClearRequested = true
    this.requestControl()
    if (this.canInput()) {
      this.send('input', {
        generation: this.controllerGeneration,
        data: `${TERMINAL_SCROLL_EXIT_SEQUENCE}${TERMINAL_SELECTION_CLEAR_SEQUENCE}`
      })
      this.historyExitRequested = false
      this.selectionClearRequested = false
      this.setViewingHistory(false)
    }

    this.tmuxSelectionPending = false
    this.tmuxSelectionText = null
    this.terminal?.clearSelection()
    this.update({ selecting: false, hasSelection: false })
    this.focus()
  }

  clearSelection(): void {
    const hadTmuxSelection =
      this.tmuxSelectionPending || this.tmuxSelectionText !== null
    if (!hadTmuxSelection && !this.terminal?.hasSelection?.()) {
      return
    }

    if (hadTmuxSelection) {
      this.selectionClearRequested = true
      this.sendSelectionClear()
    }

    this.tmuxSelectionPending = false
    this.tmuxSelectionText = null
    this.update({ selecting: false })
    this.terminal?.clearSelection()
    this.updateSelectionState()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.reconnectAllowed = false
    this.clearTimers()
    this.selectionDragCancel?.()
    this.selectionDragCancel = null
    this.resizeObserver?.disconnect()
    if (this.wakeListenersAttached) {
      window.removeEventListener('online', this.reconnectWhenOnline)
      document.removeEventListener(
        'visibilitychange',
        this.reconnectWhenVisible
      )
      this.wakeListenersAttached = false
    }

    this.keyboardViewportCleanup?.()
    this.keyboardViewportCleanup = null
    this.desktopLocalFilePasteCleanup?.()
    this.desktopLocalFilePasteCleanup = null
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
    terminal.onSelectionChange(() => this.updateSelectionState())
    terminal.onRender(() => {
      // xterm puts the block cursor and glyph on one span. Remove only the
      // cursor class so ANSI foreground colors remain unchanged.
      if (this.wrapper?.classList.contains('terminal-scrolling')) {
        this.hideTerminalCursor()
      }
    })
    terminal.onWriteParsed(() => {
      if (this.cursorRestoreTimer !== null) {
        this.scheduleTerminalCursorRestore()
      }
    })
    this.selectionDragCancel = trackTerminalSelectionAutoscroll(
      this.wrapper,
      terminal,
      {
        canInput: () => this.canInput(),
        sendInput: (data) => {
          this.send('input', {
            generation: this.controllerGeneration,
            data
          })
        },
        requestControl: () => this.requestControl(),
        onSelectionStart: () => this.clearSelection(),
        onTmuxSelectionStart: () => {
          this.scrollExitPending = true
          this.update({ selecting: true })
          this.setTerminalScrolling(true)
        },
        onTmuxSelectionFinish: () => {
          this.tmuxSelectionPending = true
          this.update({ selecting: false, hasSelection: true })
        },
        onTmuxSelectionCancel: () => {
          this.update({ selecting: false })
          this.sendHistoryExit()
        },
        selectionStartSequence: TERMINAL_SELECTION_START_SEQUENCE,
        selectionStopSequence: TERMINAL_SELECTION_STOP_SEQUENCE
      }
    )
    this.wrapper.addEventListener(
      'copy',
      (event) => {
        if (this.tmuxSelectionText === null || !event.clipboardData) {
          return
        }

        event.preventDefault()
        event.stopImmediatePropagation()
        event.clipboardData.setData('text/plain', this.tmuxSelectionText)
      },
      true
    )
    this.wrapper.addEventListener('click', () => this.requestControl(), true)
    this.wrapper.addEventListener(
      'keydown',
      (event) => {
        const key = event.key.toLowerCase()
        const modifierOnly = [
          'alt',
          'altgraph',
          'control',
          'meta',
          'shift'
        ].includes(key)
        const mappedInput = terminalKeyboardInput(
          event,
          terminal.modes.applicationCursorKeysMode
        )
        const browserOwnedMetaShortcut = event.metaKey && mappedInput === null
        const copyOrPasteShortcut =
          event.ctrlKey && event.shiftKey && (key === 'c' || key === 'v')
        if (
          !modifierOnly &&
          !browserOwnedMetaShortcut &&
          !copyOrPasteShortcut
        ) {
          this.clearSelection()
          this.requestControl()
        }
      },
      true
    )
    const expandWheelInput = trackTerminalScrolling(
      this.wrapper,
      terminal,
      (event) => {
        if (event.deltaY < 0 && this.canInput()) {
          if (
            !this.snapshotValue.viewingHistory &&
            this.tmuxSelectionText !== null
          ) {
            this.send('input', {
              generation: this.controllerGeneration,
              data: TERMINAL_SELECTION_RESTORE_SEQUENCE
            })
          }

          this.scrollExitPending = true
        }
      },
      () => {
        this.requestControl()
        this.clearSelection()
        this.prepareScrollExit()
      },
      () => {
        this.requestControl()
        this.update({
          pasteRequestSerial: this.snapshotValue.pasteRequestSerial + 1
        })
      }
    )
    const wrapper = this.wrapper
    this.desktopLocalFilePasteCleanup =
      window.treeportDesktop?.onLocalFilePaste?.((paths) => {
        if (!this.wrapper?.contains(document.activeElement)) {
          return
        }

        this.requestControl()
        this.pasteResolvedFilePaths(paths)
      }) ?? null
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

      this.requestControl()
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
      this.pasteFiles(filesFromTransfer(event.dataTransfer))
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
        this.pasteFiles(files)
      },
      true
    )
    this.terminal = terminal
    this.fitAddon = fitAddon
    this.opened = true
    terminal.parser.registerOscHandler(52, (payload) => {
      if (!this.tmuxSelectionPending) {
        return false
      }

      this.tmuxSelectionPending = false
      const separator = payload.indexOf(';')
      const encoded = separator === -1 ? '' : payload.slice(separator + 1)
      const unpadded = encoded.replace(/=+$/, '')
      if (
        !encoded ||
        encoded === '?' ||
        encoded.length > TERMINAL_MAX_SELECTION_ENCODED_LENGTH ||
        payload.indexOf(';', separator + 1) !== -1 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
        unpadded.length % 4 === 1
      ) {
        this.updateSelectionState()
        return true
      }

      const normalized = unpadded.padEnd(
        Math.ceil(unpadded.length / 4) * 4,
        '='
      )
      const binary = atob(normalized)
      this.tmuxSelectionText = new TextDecoder().decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0))
      )
      this.update({ selecting: false })
      this.updateSelectionState()
      return true
    })
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
        data = expandWheelInput(data)
        const modifiers = this.inputModifiers
        if (modifiers) {
          this.inputModifiers = null

          if (modifiers.ctrl && data.length === 1) {
            data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
          }

          if (modifiers.alt) {
            data = `\u001b${data}`
          }

          modifiers.onConsumed()
        }

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

  private queueFileTransfer(files: File[]): void {
    this.fileTransferQueue = this.fileTransferQueue
      .catch(() => undefined)
      .then(() => this.transferFiles(files))
  }

  private async transferFiles(files: File[]): Promise<void> {
    if (!files.length || this.disposed) {
      return
    }

    if (files.length > TERMINAL_MAX_FILES_PER_TRANSFER) {
      this.showFileTransferError(
        `Choose no more than ${TERMINAL_MAX_FILES_PER_TRANSFER} files at a time`
      )
      return
    }

    if (files.some((file) => file.size > TERMINAL_MAX_UPLOAD_BYTES)) {
      this.showFileTransferError(
        `Files are limited to ${TERMINAL_MAX_UPLOAD_BYTES} bytes`
      )
      return
    }

    if (!this.ready || !this.snapshotValue.controller) {
      this.showFileTransferError(
        this.snapshotValue.controlPending
          ? 'taking control; try again in a moment'
          : 'interact with the terminal to take control first'
      )
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

    try {
      const desktopBridge = window.treeportDesktop
      let sourcePaths: Array<string | null>
      if (desktopBridge?.getPathForFile) {
        sourcePaths = await Promise.all(
          files.map((file) =>
            Promise.resolve()
              .then(() => desktopBridge.getPathForFile?.(file) ?? null)
              .catch(() => null)
          )
        )
      } else if (LOOPBACK_BROWSER_HOSTNAMES.has(window.location.hostname)) {
        sourcePaths = files.map((file) => {
          // SAFETY: Privileged browser platforms can add this optional, read-only capability to a File.
          const platformFile = file as File & { readonly path?: string }
          const parsedPath = BROWSER_LOCAL_FILE_PATH_SCHEMA.safeParse(
            platformFile.path
          )
          return parsedPath.success ? parsedPath.data : null
        })
      } else {
        sourcePaths = files.map(() => null)
      }

      const uploadCount = sourcePaths.filter((filePath) => !filePath).length
      if (uploadCount > 0) {
        this.update({
          fileTransfer: {
            state: 'uploading',
            message: `Uploading ${uploadCount === 1 ? 'file' : `${uploadCount} files`}…`
          }
        })
      }

      const paths: string[] = []
      for (const [index, file] of files.entries()) {
        const sourcePath = sourcePaths[index]
        if (sourcePath) {
          paths.push(sourcePath)
          continue
        }

        const extension = /\.([a-z0-9]{1,16})$/i.exec(file.name)?.[1]
        const headers = new Headers({
          'content-type': file.type || 'application/octet-stream'
        })
        if (extension) {
          headers.set('x-treeport-file-extension', extension.toLowerCase())
        }

        const result = await parseResponse(
          rpc.api.terminals[':terminalId'].files.$post(
            { param: { terminalId: this.terminalId } },
            { init: { body: file, headers } }
          )
        )
        paths.push(result.file.path)
      }

      this.pasteResolvedFilePaths(
        paths,
        'Terminal control was lost during the upload'
      )
    } catch (error) {
      if (!this.disposed) {
        this.showFileTransferError(errorMessage(error))
      }
    }
  }

  private pasteResolvedFilePaths(paths: string[], controlError?: string): void {
    if (!paths.length || this.disposed) {
      return
    }

    if (paths.length > TERMINAL_MAX_FILES_PER_TRANSFER) {
      this.showFileTransferError(
        `Choose no more than ${TERMINAL_MAX_FILES_PER_TRANSFER} files at a time`
      )
      return
    }

    if (!this.ready || !this.snapshotValue.controller) {
      this.showFileTransferError(
        controlError ??
          (this.snapshotValue.controlPending
            ? 'taking control; try again in a moment'
            : 'interact with the terminal to take control first')
      )
      return
    }

    if (!this.canInput()) {
      this.showFileTransferError('Wait for the terminal resize to finish')
      return
    }

    const input = paths
      .map((filePath) =>
        /^[A-Za-z0-9_+,./:@%=-]+$/u.test(filePath)
          ? filePath
          : `'${filePath.replaceAll("'", "'\\''")}'`
      )
      .join(' ')
    if (
      new TextEncoder().encode(input).byteLength >
      TERMINAL_MAX_INPUT_BYTES - 32
    ) {
      this.showFileTransferError('The file paths are too long')
      return
    }

    this.clearSelection()
    this.prepareScrollExit()
    this.terminal?.paste(input)
    this.focus()
    this.update({ fileTransfer: null })
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
    if (this.scrollExitPending || this.snapshotValue.viewingHistory) {
      this.resumeOnNextInput = true
    }
  }

  private withScrollExit(data: string): string {
    if (!this.resumeOnNextInput) {
      return data
    }

    this.setViewingHistory(false)
    return `${TERMINAL_SCROLL_EXIT_SEQUENCE}${data}`
  }

  private sendHistoryExit(): void {
    if (!this.canInput()) {
      return
    }

    this.send('input', {
      generation: this.controllerGeneration,
      data: TERMINAL_SCROLL_EXIT_SEQUENCE
    })
    this.historyExitRequested = false
    this.setViewingHistory(false)
  }

  private sendSelectionClear(): void {
    if (!this.canInput()) {
      return
    }

    this.send('input', {
      generation: this.controllerGeneration,
      data: TERMINAL_SELECTION_CLEAR_SEQUENCE
    })
    this.selectionClearRequested = false
  }

  private hideTerminalCursor(): void {
    this.terminal?.element
      ?.querySelector('.xterm-cursor')
      ?.classList.remove('xterm-cursor')
  }

  private scheduleTerminalCursorRestore(): void {
    // tmux emits intermediate copy-cursor frames while it returns to the live
    // pane. Wait for terminal writes to settle, but do not hide a cursor
    // indefinitely when an application produces continuous output.
    if (this.cursorRestoreTimer !== null) {
      window.clearTimeout(this.cursorRestoreTimer)
    }

    this.cursorRestoreStartedAt ??= Date.now()
    const remainingDelay = Math.max(
      0,
      TERMINAL_CURSOR_RESTORE_MAX_DELAY_MS -
        (Date.now() - this.cursorRestoreStartedAt)
    )
    this.cursorRestoreTimer = window.setTimeout(
      () => {
        this.cursorRestoreTimer = null
        this.cursorRestoreStartedAt = null
        if (
          !this.wrapper ||
          this.scrollExitPending ||
          this.snapshotValue.viewingHistory
        ) {
          return
        }

        this.wrapper.classList.remove('terminal-scrolling')
        this.terminal?.refresh(0, this.terminal.rows - 1)
      },
      Math.min(TERMINAL_CURSOR_RESTORE_DELAY_MS, remainingDelay)
    )
  }

  private setTerminalScrolling(scrolling: boolean): void {
    if (!this.wrapper) {
      return
    }

    if (scrolling) {
      if (this.cursorRestoreTimer !== null) {
        window.clearTimeout(this.cursorRestoreTimer)
        this.cursorRestoreTimer = null
      }

      this.cursorRestoreStartedAt = null

      this.wrapper.classList.add('terminal-scrolling')
      this.hideTerminalCursor()
      return
    }

    if (this.wrapper.classList.contains('terminal-scrolling')) {
      this.scheduleTerminalCursorRestore()
    }
  }

  private setViewingHistory(viewing: boolean): void {
    if (viewing) {
      this.scrollExitPending = true
    } else {
      this.scrollExitPending = false
      this.resumeOnNextInput = false
      this.historyExitRequested = false
    }

    this.setTerminalScrolling(viewing)

    if (viewing !== this.snapshotValue.viewingHistory) {
      this.update({ viewingHistory: viewing })
    }
  }

  private reconnectImmediately(): void {
    if (
      !this.host ||
      this.disposed ||
      !this.reconnectAllowed ||
      this.ready ||
      this.socket?.connected
    ) {
      return
    }

    const staleSocket = this.socket
    if (staleSocket) {
      staleSocket.disconnect()
      if (this.socket === staleSocket) {
        this.socket = null
      }
    }

    if (this.opened) {
      this.connect()
    }
  }

  private connect(): void {
    if (this.disposed || !this.reconnectAllowed || this.socket) {
      return
    }

    this.ready = false
    this.controlRequestGeneration = null
    this.update({
      phase: 'connecting',
      controller: false,
      controlPending: false,
      error: null
    })
    this.startDegradedTimer()
    const socket: Socket<
      TerminalServerToClientEvents,
      TerminalClientToServerEvents
    > = this.createSocket('/terminals', {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      forceNew: true,
      multiplex: false,
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 100,
      reconnectionDelayMax: 1_000,
      randomizationFactor: 0.2,
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
    socket.on('history', (value) => this.handleServerEvent('history', value))
    socket.on('control', (value) => this.handleServerEvent('control', value))
    socket.on('exit', (value) => this.handleServerEvent('exit', value))
    socket.on('terminal_error', (value) =>
      this.handleServerEvent('terminal_error', value)
    )
    socket.on('connect_error', (error) => {
      if (this.socket !== socket || !this.reconnectAllowed) {
        return
      }

      this.controlRequestGeneration = null
      this.update({
        phase: 'reconnecting',
        controller: false,
        controlPending: false,
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
      this.selectionDragCancel?.()
      this.tmuxSelectionPending = false
      this.tmuxSelectionText = null
      this.setViewingHistory(false)
      this.controllerGeneration = 0
      this.controlRequestGeneration = null
      this.cancelControllerResizeIntent()
      if (!this.reconnectAllowed) {
        this.clearDegraded()
      }

      this.update({
        phase:
          this.reconnectAllowed && !this.disposed ? 'reconnecting' : 'closed',
        controller: false,
        controlPending: false,
        hasSelection: false,
        selecting: false,
        viewingHistory: false,
        degraded: this.reconnectAllowed ? this.snapshotValue.degraded : false,
        error:
          !connected && !this.snapshotValue.error
            ? `Terminal connection closed: ${reason}`
            : this.snapshotValue.error
      })
    })
    socket.io.on('reconnect_attempt', () => {
      if (this.socket === socket && this.reconnectAllowed) {
        this.controlRequestGeneration = null
        this.startDegradedTimer()
        this.update({
          phase: 'reconnecting',
          controller: false,
          controlPending: false
        })
      }
    })
    socket.connect()
  }

  private handleServerEvent(
    event: TerminalServerEvent,
    value: TerminalProtocolInput
  ): void {
    if (event === 'ready') {
      const message = parseTerminalServerEvent('ready', value)
      if (!message) {
        this.failProtocol('The terminal server sent an invalid ready event')
        return
      }

      this.cancelControllerResizeIntent()
      this.controlRequestGeneration = null
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
      this.selectionDragCancel?.()
      this.tmuxSelectionPending = false
      this.tmuxSelectionText = null
      this.setViewingHistory(false)
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
        controlPending: false,
        hasSelection: false,
        selecting: false,
        viewingHistory: false,
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

    if (event === 'history') {
      const message = parseTerminalServerEvent('history', value)
      if (!message) {
        this.failProtocol('The terminal server sent invalid history state')
        return
      }

      this.setViewingHistory(message.viewing)
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
      this.controlRequestGeneration = null
      this.update({
        controller: message.controller,
        controlPending: false
      })

      if (controllerChanged && !message.controller) {
        this.selectionDragCancel?.()
        this.tmuxSelectionPending = false
      }

      if (message.controller && this.selectionClearRequested) {
        this.sendSelectionClear()
      }

      if (message.controller && this.historyExitRequested) {
        this.sendHistoryExit()
      }

      if (message.controller && this.pendingPaste) {
        const pendingPaste = this.pendingPaste
        this.pendingPaste = ''
        this.terminal?.paste(pendingPaste)
      }

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
      this.controlRequestGeneration = null
      this.update({ controlPending: false, error: message.message })
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
    void queued.catch((error) => this.failRendering(error))
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
      // SAFETY: The generic event selects its matching protocol payload.
      const emit = this.socket.emit.bind(this.socket) as (
        event: E,
        payload: Parameters<TerminalClientToServerEvents[E]>[0]
      ) => void
      emit(event, payload)
      return
    }

    // SAFETY: The generic event selects its matching protocol payload.
    const emit = this.socket.volatile.emit.bind(this.socket.volatile) as (
      event: E,
      payload: Parameters<TerminalClientToServerEvents[E]>[0]
    ) => void
    emit(event, payload)
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

  private failRendering(cause: unknown): void {
    if (this.renderFailed || this.disposed) {
      return
    }

    this.renderFailed = true
    const detail = (
      cause instanceof Error ? cause.message : String(cause)
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
    this.controlRequestGeneration = null
    this.update({
      error: message,
      phase: 'closed',
      degraded: false,
      controller: false,
      controlPending: false
    })
  }

  private updateSelectionState(): void {
    this.update({
      hasSelection:
        this.tmuxSelectionPending ||
        this.tmuxSelectionText !== null ||
        Boolean(this.terminal?.hasSelection())
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

    if (this.cursorRestoreTimer !== null) {
      window.clearTimeout(this.cursorRestoreTimer)
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
    this.cursorRestoreTimer = null
    this.cursorRestoreStartedAt = null
    this.resizeFrame = null
    this.resizeSettleTimer = null
    this.resizePending = false
    this.resizeIntentDirty = false
    this.resizeQuietElapsed = false
    this.resizeIntentGeneration = 0
    this.proposedDimensions = null
  }
}
