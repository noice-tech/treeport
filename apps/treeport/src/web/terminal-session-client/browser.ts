import type { SessionTimer } from './timers'
import * as Effect from 'effect/Effect'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { type TerminalClientToServerEvents } from '@treeport/shared'
import {
  terminalKeyboardInput,
  terminalOptions,
  trackTerminalScrolling,
  trackTerminalSelection
} from '../terminal-browser'
import {
  type TerminalSessionState,
  type TerminalSessionSnapshot
} from './state'

const TERMINAL_CURSOR_RESTORE_DELAY_MS = 50
const TERMINAL_CURSOR_RESTORE_MAX_DELAY_MS = 250

interface Dependencies {
  hasTimer(key: SessionTimer): boolean
  canInput(): boolean
  cancelTimer(key: SessionTimer): void
  clearSelection(): void
  handleBell(): void
  pasteFiles(files: File[]): void
  pasteResolvedFilePaths(paths: string[], controlError?: string): void
  requestControl(): void
  scheduleTimer(key: SessionTimer, callback: () => void, delay: number): void
  send<E extends keyof TerminalClientToServerEvents>(
    event: E,
    payload: Parameters<TerminalClientToServerEvents[E]>[0]
  ): void
  update(patch: Partial<TerminalSessionSnapshot>): void
  updateSelectionState(): void
}

export function makeBrowser(
  state: Pick<
    TerminalSessionState,
    | 'controllerGeneration'
    | 'fitAddon'
    | 'inputModifiers'
    | 'opened'
    | 'selectionDragCancel'
    | 'snapshotValue'
    | 'terminal'
    | 'terminalId'
    | 'wrapper'
  >,
  dependencies: Dependencies
) {
  return Effect.gen(function* () {
    let desktopLocalFilePasteCleanup: (() => void) | null = null
    let cursorRestoreStartedAt: number | null = null

    function openTerminal(): void {
      if (!state.wrapper || state.opened) {
        return
      }

      const options = terminalOptions(state.terminalId, (hoveredLink) =>
        dependencies.update({ hoveredLink })
      )
      const terminal = new Terminal(options)
      // Own xterm before loading addons so partial initialization is disposable.
      state.terminal = terminal
      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.loadAddon(
        new ImageAddon({
          iipSupport: false,
          kittySupport: true,
          sixelSupport: false,
          storageLimit: 64
        })
      )
      terminal.loadAddon(
        new WebLinksAddon(options.linkHandler.activate, {
          hover: options.linkHandler.hover,
          leave: options.linkHandler.leave
        })
      )
      terminal.open(state.wrapper)
      terminal.onSelectionChange(() => dependencies.updateSelectionState())
      terminal.onRender(() => {
        // xterm puts the block cursor and glyph on one span. Remove only the
        // cursor class so ANSI foreground colors remain unchanged.
        if (state.wrapper?.classList.contains('terminal-scrolling')) {
          hideTerminalCursor()
        }
      })
      terminal.onWriteParsed(() => {
        if (dependencies.hasTimer('cursorRestore')) {
          scheduleTerminalCursorRestore()
        }
      })
      state.selectionDragCancel = trackTerminalSelection(
        state.wrapper,
        terminal,
        {
          requestControl: () => dependencies.requestControl()
        }
      )
      state.wrapper.addEventListener(
        'click',
        () => dependencies.requestControl(),
        true
      )
      state.wrapper.addEventListener(
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
            dependencies.clearSelection()
            dependencies.requestControl()
          }
        },
        true
      )
      const expandWheelInput = trackTerminalScrolling(
        state.wrapper,
        terminal,
        () => undefined,
        () => {
          dependencies.requestControl()
          dependencies.clearSelection()
        },
        () => {
          dependencies.requestControl()
          dependencies.update({
            pasteRequestSerial: state.snapshotValue.pasteRequestSerial + 1
          })
        }
      )
      const wrapper = state.wrapper
      desktopLocalFilePasteCleanup =
        window.treeportDesktop?.onLocalFilePaste?.((paths) => {
          if (!state.wrapper?.contains(document.activeElement)) {
            return
          }

          dependencies.requestControl()
          dependencies.pasteResolvedFilePaths(paths)
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

        dependencies.requestControl()
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
        dependencies.pasteFiles(filesFromTransfer(event.dataTransfer))
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
          dependencies.pasteFiles(files)
        },
        true
      )
      state.fitAddon = fitAddon
      state.opened = true
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
        terminal.input(input, true)
        return false
      })
      terminal.onData((data) => {
        if (dependencies.canInput()) {
          data = expandWheelInput(data)
          const modifiers = state.inputModifiers
          if (modifiers) {
            state.inputModifiers = null

            if (modifiers.ctrl && data.length === 1) {
              data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
            }

            if (modifiers.alt) {
              data = `\u001b${data}`
            }

            modifiers.onConsumed()
          }

          dependencies.send('input', {
            generation: state.controllerGeneration,
            data
          })
        }
      })
      terminal.onBinary((data) => {
        if (dependencies.canInput()) {
          dependencies.send('binary', {
            generation: state.controllerGeneration,
            data
          })
        }
      })
      terminal.onTitleChange((title) =>
        dependencies.update({ title: title.trim().slice(0, 256) })
      )
      terminal.onScroll(() =>
        setTerminalScrolling(
          terminal.buffer.active.viewportY < terminal.buffer.active.baseY
        )
      )
      terminal.onBell(() => dependencies.handleBell())
    }

    function hideTerminalCursor(): void {
      state.terminal?.element
        ?.querySelector('.xterm-cursor')
        ?.classList.remove('xterm-cursor')
    }

    function scheduleTerminalCursorRestore(): void {
      // Wait for terminal writes to settle before restoring the live cursor.
      dependencies.cancelTimer('cursorRestore')

      cursorRestoreStartedAt ??= Date.now()
      const remainingDelay = Math.max(
        0,
        TERMINAL_CURSOR_RESTORE_MAX_DELAY_MS -
          (Date.now() - cursorRestoreStartedAt)
      )
      dependencies.scheduleTimer(
        'cursorRestore',
        () => {
          cursorRestoreStartedAt = null
          if (
            !state.wrapper ||
            (state.terminal &&
              state.terminal.buffer.active.viewportY <
                state.terminal.buffer.active.baseY)
          ) {
            return
          }

          state.wrapper.classList.remove('terminal-scrolling')
          state.terminal?.refresh(0, state.terminal.rows - 1)
        },
        Math.min(TERMINAL_CURSOR_RESTORE_DELAY_MS, remainingDelay)
      )
    }

    function setTerminalScrolling(scrolling: boolean): void {
      if (!state.wrapper) {
        return
      }

      if (scrolling) {
        dependencies.cancelTimer('cursorRestore')

        cursorRestoreStartedAt = null

        state.wrapper.classList.add('terminal-scrolling')
        hideTerminalCursor()
        return
      }

      if (state.wrapper.classList.contains('terminal-scrolling')) {
        scheduleTerminalCursorRestore()
      }
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.terminal?.dispose()
      })
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const cleanup = desktopLocalFilePasteCleanup
        desktopLocalFilePasteCleanup = null
        cleanup?.()
      })
    )

    return {
      openTerminal,
      setTerminalScrolling
    }
  })
}
