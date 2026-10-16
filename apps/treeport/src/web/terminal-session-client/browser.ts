import type { SessionTimer } from './timers'
import * as Effect from 'effect/Effect'
import { FitAddon } from '@xterm/addon-fit'
import { TerminalImages } from '../../terminal-runtime/images'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { toast } from 'sonner'
import { type TerminalClientToServerEvents } from '@treeport/shared'
import {
  terminalKeyboardInput,
  terminalInputWithModifiers,
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
// Image-bearing frames can outlast xterm's one-second synchronized-output
// timeout. Keep the previous frame visible, but still release a stalled frame.
const TERMINAL_SYNCHRONIZED_OUTPUT_MAX_DELAY_MS = 5_000

interface SynchronizedOutputInternals {
  _core: {
    coreService: { decPrivateModes: { synchronizedOutput: boolean } }
    _inputHandler: { _dirtyRowTracker: { start: number; end: number } }
    _renderService: {
      _syncOutputHandler: {
        _timeout: number | undefined
        bufferRows(start: number, end: number): void
      }
    }
  }
}

interface Dependencies {
  copyText(text: string): Promise<void>
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
    | 'fontSize'
    | 'inputModifiers'
    | 'images'
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
      const terminal = new Terminal({ ...options, fontSize: state.fontSize })
      // Own xterm before loading addons so partial initialization is disposable.
      state.terminal = terminal
      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      state.images = new TerminalImages()
      terminal.loadAddon(state.images)
      terminal.loadAddon(
        new WebLinksAddon(options.linkHandler.activate, {
          hover: options.linkHandler.hover,
          leave: options.linkHandler.leave
        })
      )
      terminal.open(state.wrapper)
      // SAFETY: The pinned xterm has no public synchronized-output timeout
      // option. Extend only its existing timer; xterm still owns buffering,
      // frame completion and disposal. Never hide the terminal or its input.
      const { _core: core } = Object(terminal) as SynchronizedOutputInternals
      const sync = core._renderService._syncOutputHandler
      const bufferRows = sync.bufferRows.bind(sync)
      sync.bufferRows = (start, end) => {
        const pending = sync._timeout !== undefined
        bufferRows(start, end)
        terminal.element?.classList.add('terminal-synchronized-output')
        if (!pending) {
          window.clearTimeout(sync._timeout)
          sync._timeout = window.setTimeout(() => {
            sync._timeout = undefined
            core.coreService.decPrivateModes.synchronizedOutput = false
            terminal.refresh(0, terminal.rows - 1)
          }, TERMINAL_SYNCHRONIZED_OUTPUT_MAX_DELAY_MS)
        }
      }
      terminal.parser.registerCsiHandler(
        { prefix: '?', final: 'l' },
        (params) => {
          if (params.length !== 1 || params[0] !== 2026) {
            return false
          }

          // SAFETY: The pinned xterm ends synchronized output with a full-screen
          // refresh, even for a one-cell update. Use its current parser dirty range;
          // RenderService merges buffered ranges from earlier writes and clears the
          // timer. Flush here, not at parse completion: a following image handler
          // can pause parsing. Leave combined mode resets to xterm's default handler.
          core.coreService.decPrivateModes.synchronizedOutput = false
          const buffer = terminal.buffer.active
          const offset = buffer.baseY - buffer.viewportY
          const dirty = core._inputHandler._dirtyRowTracker
          // Clamp offscreen ranges too, so scrollback cannot leave a frame buffered.
          terminal.refresh(
            Math.min(dirty.start + offset, terminal.rows - 1),
            Math.min(dirty.end + offset, terminal.rows - 1)
          )
          return true
        }
      )
      terminal.parser.registerOscHandler(52, (payload) => {
        // OSC 52 is write-only. Never expose the clipboard to a remote process,
        // or let viewers, background sessions or snapshot restoration change it.
        if (
          !dependencies.canInput() ||
          state.snapshotValue.phase !== 'ready' ||
          state.wrapper?.style.visibility === 'hidden' ||
          !document.hasFocus() ||
          !state.wrapper?.contains(document.activeElement)
        ) {
          return true
        }

        const separator = payload.indexOf(';')
        if (separator < 0) {
          return true
        }

        const selection = payload.slice(0, separator)
        const encoded = payload.slice(separator + 1)
        if (
          (selection !== '' && !/^c+$/.test(selection)) ||
          !encoded ||
          encoded === '?' ||
          encoded.length > 1_048_576
        ) {
          return true
        }

        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(
            Uint8Array.from(atob(encoded), (character) =>
              character.charCodeAt(0)
            )
          )
        } catch {
          // Malformed application output must not interrupt terminal parsing.
          return true
        }

        // Do not block the output parser on browser clipboard permissions.
        void dependencies.copyText(text).catch(() => {
          toast.error('Couldn’t copy terminal text', {
            action: {
              label: 'Copy',
              onClick: () => {
                // Some browsers require a fresh user gesture for clipboard writes.
                void dependencies
                  .copyText(text)
                  .catch(() => toast.error('Couldn’t copy text'))
              }
            }
          })
        })
        return true
      })
      terminal.onSelectionChange(() => dependencies.updateSelectionState())
      terminal.onRender(() => {
        if (!terminal.modes.synchronizedOutputMode) {
          terminal.element?.classList.remove('terminal-synchronized-output')
        }

        // xterm puts the block cursor and glyph on one span. Remove only the
        // cursor class so ANSI foreground colors remain unchanged.
        if (state.wrapper?.classList.contains('terminal-scrolling')) {
          hideTerminalCursor()
        }
      })
      terminal.onWriteParsed(() => {
        if (terminal.modes.synchronizedOutputMode) {
          terminal.element?.classList.add('terminal-synchronized-output')
        }

        if (dependencies.hasTimer('cursorRestore')) {
          scheduleTerminalCursorRestore()
        }
      })
      state.selectionDragCancel = trackTerminalSelection(state.wrapper, {
        requestControl: () => dependencies.requestControl()
      })
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
      trackTerminalScrolling(
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
          const modifiers = state.inputModifiers
          if (modifiers) {
            state.inputModifiers = null

            data = terminalInputWithModifiers(data, modifiers)
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
