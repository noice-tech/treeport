import * as Effect from 'effect/Effect'
import { WTerm } from '@wterm/dom'
import { toast } from 'sonner'
import type { TerminalClientToServerEvents } from '#protocol/terminal-session'
import {
  setTerminalFontSize,
  terminalKeyboardInput,
  terminalInputWithModifiers,
  terminalOptions,
  trackTerminalScrolling,
  trackTerminalSelection
} from '../terminal-browser'
import { GhosttyTerminalCore, loadGhosttyVtModule } from './ghostty-core'
import {
  type TerminalSessionState,
  type TerminalSessionSnapshot
} from './state'

interface Dependencies {
  copyText(text: string): Promise<void>
  canInput(): boolean
  clearSelection(): void
  failRendering(cause: unknown): void
  handleBell(): void
  pasteFiles(files: File[]): void
  pasteResolvedFilePaths(paths: string[], controlError?: string): void
  reconnectImmediately(): void
  requestControl(): void
  scheduleFit(): void
  send<E extends keyof TerminalClientToServerEvents>(
    event: E,
    payload: Parameters<TerminalClientToServerEvents[E]>[0]
  ): void
  update(patch: Partial<TerminalSessionSnapshot>): void
}

export function makeBrowser(
  state: Pick<
    TerminalSessionState,
    | 'controllerGeneration'
    | 'disposed'
    | 'fontSize'
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
    let inputObserver: ResizeObserver | null = null
    let core: GhosttyTerminalCore | null = null
    let loading = false

    function openTerminal(): void {
      if (!state.wrapper || state.opened || loading) {
        return
      }

      const options = terminalOptions(state.terminalId)

      if (!core) {
        loading = true
        void loadGhosttyVtModule().then((module) => {
          loading = false

          if (state.disposed) {
            return
          }

          core = new GhosttyTerminalCore(module, options.scrollbackLines)
          openTerminal()
        }, dependencies.failRendering)

        return
      }

      const wrapper = state.wrapper
      const element = document.createElement('div')
      element.className = 'terminal-wterm'
      wrapper.appendChild(element)

      const terminal = new WTerm(element, {
        core,
        autoResize: false,
        onData: (data) => {
          if (!dependencies.canInput()) {
            return
          }

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
        },
        onBinary: (data) => {
          if (dependencies.canInput()) {
            dependencies.send('binary', {
              generation: state.controllerGeneration,
              data: String.fromCharCode(...data)
            })
          }
        },
        onBell: () => dependencies.handleBell(),
        onClipboardWrite: (text) => {
          if (
            !dependencies.canInput() ||
            state.snapshotValue.phase !== 'ready' ||
            wrapper.style.opacity === '0' ||
            !document.hasFocus() ||
            !wrapper.contains(document.activeElement) ||
            !text
          ) {
            return
          }

          void dependencies.copyText(text).catch(() => {
            toast.error('Couldn’t copy terminal text', {
              action: {
                label: 'Copy',
                onClick: () => {
                  // EXTERNAL: Some browsers require a fresh user gesture for clipboard writes.
                  void dependencies
                    .copyText(text)
                    .catch(() => toast.error('Couldn’t copy text'))
                }
              }
            })
          })
        }
      })

      setTerminalFontSize(terminal, state.fontSize)
      // EXTERNAL: wterm focuses its input during initialization; keep focus where it was.
      const focused = document.activeElement
      // EXTERNAL: With a supplied core, initialization completes synchronously.
      void terminal.init().catch(dependencies.failRendering)

      if (focused instanceof HTMLElement && focused !== document.body) {
        focused.focus({ preventScroll: true })
      } else {
        element.querySelector('textarea')?.blur()
      }

      // EXTERNAL: A fixed grid makes wterm lock its height; let it fill the host instead.
      element.style.height = ''
      state.terminal = terminal
      // EXTERNAL: wterm moves its hidden input to the cursor only on focus, keys and
      // composition. Left below history that shrank (clear, Pi redraws, the
      // alternate screen) it keeps the scroll area tall, so following output
      // scrolls the viewport past every row.
      const grid = element.querySelector<HTMLElement>('.term-grid')
      const input = element.querySelector<HTMLElement>('textarea')

      if (grid && input) {
        inputObserver = new ResizeObserver(() => {
          const row = grid.querySelector<HTMLElement>(
            '.term-row:not(.term-scrollback-row)'
          )

          const cursor = terminal.bridge?.getCursor()

          if (row && cursor) {
            input.style.top = `${grid.offsetTop + row.offsetTop + cursor.row * row.offsetHeight}px`
          }
        })
        inputObserver.observe(grid)
      }

      let hoveredLink: string | null = null

      const hoverLink = (event: MouseEvent) => {
        const link =
          event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>('a.term-link')
            : null

        const href = link?.href ?? null

        if (href === hoveredLink) {
          return
        }

        hoveredLink = href
        dependencies.update({ hoveredLink: href })
      }

      wrapper.addEventListener('mouseover', hoverLink)
      wrapper.addEventListener('mouseleave', hoverLink)
      wrapper.addEventListener(
        'click',
        (event) => {
          const link =
            event.target instanceof Element
              ? event.target.closest<HTMLAnchorElement>('a.term-link')
              : null

          if (!link) {
            return
          }

          event.preventDefault()
          options.linkHandler.activate(event, link.href)

          if (window.getSelection()?.isCollapsed !== false) {
            terminal.focus()
          }
        },
        true
      )

      element.addEventListener(
        'scroll',
        () =>
          setTerminalScrolling(
            element.scrollHeight - element.scrollTop - element.clientHeight >= 5
          ),
        { passive: true }
      )
      state.selectionDragCancel = trackTerminalSelection(wrapper, {
        requestControl: () => dependencies.requestControl()
      })
      wrapper.addEventListener(
        'click',
        () => dependencies.requestControl(),
        true
      )
      wrapper.addEventListener(
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
            terminal.bridge?.cursorKeysApp() ?? false
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

          if (mappedInput !== null) {
            event.preventDefault()
            event.stopPropagation()
            terminal.onData?.(mappedInput)
          }
        },
        true
      )
      trackTerminalScrolling(
        wrapper,
        terminal,
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

      // EXTERNAL: iOS drags a long-pressed selection with a web archive file. Dropping
      // terminal text back onto the terminal must not upload and paste it.
      let draggingTerminalText = false
      wrapper.addEventListener('dragstart', () => {
        draggingTerminalText = true
      })
      wrapper.addEventListener('dragend', () => {
        draggingTerminalText = false
      })
      wrapper.addEventListener('dragover', (event) => {
        if (draggingTerminalText || !transfersFiles(event.dataTransfer)) {
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
        if (draggingTerminalText || !transfersFiles(event.dataTransfer)) {
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
      state.opened = true
      dependencies.scheduleFit()
      dependencies.reconnectImmediately()
    }

    function restoreTerminal(snapshot: string): void {
      const terminal = state.terminal
      const terminalCore = terminal?.bridge

      if (!terminal || !(terminalCore instanceof GhosttyTerminalCore)) {
        return
      }

      const binary = atob(snapshot)
      const bytes = new Uint8Array(binary.length)

      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index)
      }

      terminalCore.restore(bytes)
      // EXTERNAL: An empty write makes wterm repaint the restored grid and history.
      terminal.write('')
    }

    function setTerminalScrolling(scrolling: boolean): void {
      state.wrapper?.classList.toggle('terminal-scrolling', scrolling)
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.terminal?.destroy()
        core?.dispose()
        core = null
      })
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        desktopLocalFilePasteCleanup?.()
        desktopLocalFilePasteCleanup = null
        inputObserver?.disconnect()
        inputObserver = null
      })
    )

    return {
      openTerminal,
      restoreTerminal,
      setTerminalScrolling
    }
  })
}
