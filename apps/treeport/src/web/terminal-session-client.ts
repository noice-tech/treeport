import { makeTimers } from './terminal-session-client/timers'
import { makeRender } from './terminal-session-client/render'
import { makeTransfers } from './terminal-session-client/transfers'
import { makeLayout } from './terminal-session-client/layout'
import { makeConnection } from './terminal-session-client/connection'
import { makeBrowser } from './terminal-session-client/browser'
import { makeHost } from './terminal-session-client/host'
import { makeProtocol } from './terminal-session-client/protocol'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import { createProtocolSocket, type TerminalSize } from '@treeport/shared'
import {
  TerminalSessionState,
  type TerminalSessionSnapshot,
  type TerminalSocketFactory,
  type ArrowDirection,
  normalizeTerminalDimensions
} from './terminal-session-client/state'

// The synchronous React/xterm adapter composes session-owned Effect services.
// Unmount detaches a host; only dispose closes the scope and stops rendering.
export class TerminalSession {
  private readonly state: TerminalSessionState
  private readonly scope = Effect.runSync(Scope.make())
  private readonly services

  constructor(
    readonly terminalId: string,
    createSocket: TerminalSocketFactory = createProtocolSocket
  ) {
    const state = (this.state = new TerminalSessionState(terminalId))
    this.services = Effect.runSync(
      Scope.extend(
        Effect.gen(this, function* () {
          // Register first: clear references only after every service has released
          // its resources, even if an addon disposer fails.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              state.terminal = null
              state.fitAddon = null
              state.wrapper = null
              state.host = null
              state.socket = null
              state.selectionDragCancel = null
              state.pendingPaste = ''
              state.inputModifiers = null
              state.listeners.clear()
            })
          )
          const timers = yield* makeTimers(state, {
            failRendering: (...args) => render.failRendering(...args)
          })
          const render = yield* makeRender(state, {
            failProtocol: (...args) => connection.failProtocol(...args),
            send: (...args) => connection.send(...args),
            stopWithError: (...args) => connection.stopWithError(...args)
          })
          const transfers = yield* makeTransfers(state, {
            canInput: (...args) => connection.canInput(...args),
            cancelTimer: timers.cancelTimer,
            clearSelection: (...args) => this.clearSelection(...args),
            focus: (...args) => this.focus(...args),
            scheduleTimer: timers.scheduleTimer,
            update: (...args) => this.update(...args)
          })
          const layout = yield* makeLayout(state, {
            cancelTimer: timers.cancelTimer,
            failRendering: render.failRendering,
            scheduleTimer: timers.scheduleTimer,
            send: (...args) => connection.send(...args)
          })
          // Finalizers run in reverse: detach the host and disconnect the
          // socket before disposing xterm, then interrupt the async workers.
          const browser = yield* makeBrowser(state, {
            hasTimer: timers.hasTimer,
            canInput: (...args) => connection.canInput(...args),
            cancelTimer: timers.cancelTimer,
            clearSelection: (...args) => this.clearSelection(...args),
            handleBell: (...args) => this.handleBell(...args),
            pasteFiles: (...args) => this.pasteFiles(...args),
            pasteResolvedFilePaths: transfers.pasteResolvedFilePaths,
            requestControl: (...args) => this.requestControl(...args),
            scheduleTimer: timers.scheduleTimer,
            send: (...args) => connection.send(...args),
            update: (...args) => this.update(...args),
            updateSelectionState: (...args) =>
              this.updateSelectionState(...args)
          })
          const connection: Effect.Effect.Success<
            ReturnType<typeof makeConnection>
          > = yield* makeConnection(
            state,
            {
              hasTimer: timers.hasTimer,
              cancelControllerResizeIntent: layout.cancelControllerResizeIntent,
              cancelTimer: timers.cancelTimer,
              fit: layout.fit,
              handleServerEvent: (...args) =>
                protocol.handleServerEvent(...args),
              scheduleTimer: timers.scheduleTimer,
              setTerminalScrolling: browser.setTerminalScrolling,
              update: (...args) => this.update(...args)
            },
            createSocket
          )
          const host = yield* makeHost(state, {
            cancelControllerResizeIntent: layout.cancelControllerResizeIntent,
            connect: connection.connect,
            failRendering: render.failRendering,
            openTerminal: browser.openTerminal,
            reconnectImmediately: connection.reconnectImmediately,
            scheduleFit: layout.scheduleFit,
            update: (...args) => this.update(...args)
          })
          const protocol = yield* makeProtocol(state, {
            applyCanonicalDimensions: layout.applyCanonicalDimensions,
            cancelControllerResizeIntent: layout.cancelControllerResizeIntent,
            clearDegraded: connection.clearDegraded,
            drainTerminalWrites: render.drainTerminalWrites,
            enqueueRender: render.enqueueRender,
            failProtocol: connection.failProtocol,
            flushControllerResize: layout.flushControllerResize,
            fit: layout.fit,
            focus: (...args) => this.focus(...args),
            handleOutput: render.handleOutput,
            scheduleFit: layout.scheduleFit,
            send: connection.send,
            setTerminalScrolling: browser.setTerminalScrolling,
            stopWithError: connection.stopWithError,
            update: (...args) => this.update(...args),
            writeTerminal: render.writeTerminal
          })
          return {
            timers,
            render,
            transfers,
            layout,
            connection,
            browser,
            host,
            protocol
          }
        }),
        this.scope
      )
    )
  }

  getSnapshot = (): TerminalSessionSnapshot => this.state.snapshotValue

  subscribe = (listener: () => void): (() => void) => {
    if (this.state.disposed) {
      return () => undefined
    }

    this.state.listeners.add(listener)
    return () => this.state.listeners.delete(listener)
  }

  getInitialSize(): TerminalSize | null {
    if (!this.state.host || !this.state.terminal) {
      return null
    }

    return normalizeTerminalDimensions(
      this.state.proposedDimensions ?? {
        cols: this.state.terminal.cols,
        rows: this.state.terminal.rows
      }
    )
  }

  focus(options: { requestControl?: boolean } = {}): void {
    if (options.requestControl) {
      this.requestControl()
    }

    if (this.state.wrapper?.style.visibility === 'hidden') {
      this.state.focusAfterRender = true
      return
    }

    this.state.focusAfterRender = false
    this.state.terminal?.focus()
  }

  requestControl(): void {
    if (
      !this.state.ready ||
      !this.state.socket?.connected ||
      this.state.snapshotValue.controller ||
      this.state.controlRequestGeneration === this.state.controllerGeneration
    ) {
      return
    }

    const dimensions = normalizeTerminalDimensions(
      this.state.proposedDimensions ?? {
        cols: this.state.canonicalCols,
        rows: this.state.canonicalRows
      }
    )
    this.state.controlRequestGeneration = this.state.controllerGeneration
    this.update({ controlPending: true })
    this.services.connection.send('take_control', {
      generation: this.state.controllerGeneration,
      ...dimensions
    })
  }

  retry(): void {
    if (this.state.disposed || this.state.ready) {
      return
    }

    if (this.state.renderFailed) {
      // A rejected render queue must never be reused. Reloading reconstructs
      // xterm, its DOM listeners, and the queue before reconnecting.
      window.location.reload()
      return
    }

    this.state.reconnectAllowed = true
    this.update({ error: null, phase: 'connecting', degraded: false })
    if (this.state.socket) {
      this.state.socket.connect()
    } else {
      this.services.connection.connect()
    }
  }

  setInputModifiers(ctrl: boolean, alt: boolean, onConsumed: () => void): void {
    this.state.inputModifiers = ctrl || alt ? { ctrl, alt, onConsumed } : null
  }

  sendText(data: string, options: { focus?: boolean } = {}): void {
    this.requestControl()
    this.clearSelection()

    if (this.services.connection.canInput()) {
      this.services.connection.send('input', {
        generation: this.state.controllerGeneration,
        data
      })
    }

    if (options.focus !== false) {
      this.focus()
    }
  }

  pasteText(data: string): void {
    if (!data || this.state.disposed) {
      return
    }

    this.requestControl()
    this.clearSelection()
    if (this.services.connection.canInput()) {
      this.state.terminal?.paste(data)
    } else {
      this.state.pendingPaste += data
    }

    this.focus()
  }

  pasteFiles(files: File[]): void {
    if (!files.length) {
      return
    }

    this.requestControl()
    this.services.transfers.queueFileTransfer(files)
  }

  sendArrow(
    direction: ArrowDirection,
    alt = false,
    options: { focus?: boolean } = {}
  ): void {
    const final = { up: 'A', down: 'B', right: 'C', left: 'D' }[direction]
    const prefix = this.state.terminal?.modes.applicationCursorKeysMode
      ? '\u001bO'
      : '\u001b['
    this.sendText(`${alt ? '\u001b' : ''}${prefix}${final}`, options)
  }

  async copyText(
    text = this.state.terminal?.getSelection() ?? ''
  ): Promise<void> {
    if (!text) {
      return
    }

    // Clipboard.writeText is unavailable on non-HTTPS iOS installations.
    // execCommand remains the reliable synchronous path from a user gesture
    // there, provided the selected value lives in a real form control.
    const copyBuffer = document.createElement('textarea')
    copyBuffer.value = text
    copyBuffer.readOnly = true
    copyBuffer.style.position = 'fixed'
    copyBuffer.style.left = '-9999px'
    copyBuffer.style.opacity = '0'
    // Stay inside the active focus scope when copying from a modal menu.
    ;(document.activeElement?.parentElement ?? document.body).appendChild(
      copyBuffer
    )
    copyBuffer.focus({ preventScroll: true })
    copyBuffer.select()
    copyBuffer.setSelectionRange(0, text.length)
    const copied = document.execCommand('copy')
    copyBuffer.remove()
    this.focus()

    if (!copied) {
      if (!navigator.clipboard) {
        throw new Error('Clipboard is unavailable')
      }

      await navigator.clipboard.writeText(text)
    }
  }

  clearSelection(): void {
    if (!this.state.terminal?.hasSelection?.()) {
      return
    }

    this.state.terminal.clearSelection()
    this.updateSelectionState()
  }

  dispose(): void {
    if (this.state.disposed) {
      return
    }

    this.state.disposed = true
    this.state.renderEpoch += 1
    this.state.ready = false
    this.state.reconnectAllowed = false
    // Scope closure interrupts callback waits, uploads and sleeps. Submitted
    // xterm writes cannot be cancelled and remain epoch-fenced.
    Effect.runFork(
      Scope.close(this.scope, Exit.void).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError('Terminal session cleanup failed', cause)
        )
      )
    )
  }

  private handleBell(): void {
    const now = Date.now()
    if (now - this.state.lastBellAt < 1_000) {
      return
    }

    this.state.lastBellAt = now
    this.services.timers.cancelTimer('bell')

    this.update({
      bellActive: true,
      bellSerial: this.state.snapshotValue.bellSerial + 1
    })
    this.services.timers.scheduleTimer(
      'bell',
      () => {
        this.update({ bellActive: false })
      },
      180
    )
  }

  private updateSelectionState(): void {
    this.update({
      hasSelection: Boolean(this.state.terminal?.hasSelection())
    })
  }

  private update(patch: Partial<TerminalSessionSnapshot>): void {
    if (this.state.disposed) {
      return
    }

    this.state.snapshotValue = { ...this.state.snapshotValue, ...patch }
    this.state.listeners.forEach((listener) => listener())
  }

  mount(host: HTMLElement): void {
    this.services.host.mount(host)
  }
  unmount(host: HTMLElement): void {
    this.services.host.unmount(host)
  }
}

export type {
  ArrowDirection,
  TerminalFileTransfer,
  TerminalSessionSnapshot,
  TerminalSocketFactory
} from './terminal-session-client/state'
