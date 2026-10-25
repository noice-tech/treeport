import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import {
  type TerminalSessionState,
  type TerminalSessionSnapshot
} from './state'

interface Dependencies {
  cancelControllerResizeIntent(clearPending?: boolean): void
  connect(): void
  failRendering(cause: unknown): void
  openTerminal(): void
  reconnectImmediately(): void
  scheduleFit(): void
  update(patch: Partial<TerminalSessionSnapshot>): void
}

export function makeHost(
  state: Pick<
    TerminalSessionState,
    | 'disposed'
    | 'focusAfterRender'
    | 'host'
    | 'opened'
    | 'selectionDragCancel'
    | 'socket'
    | 'terminal'
    | 'wrapper'
  >,
  dependencies: Dependencies
) {
  return Effect.gen(function* () {
    // A detached wrapper lays out at zero height and loses its scroll offset.
    // wterm keeps parsing output meanwhile, so painting must pause and the
    // offset must be restored before wterm next derives its follow-output state.
    let detachedScroll: { top: number; following: boolean } | null = null
    let wakeListenersAttached = false
    let resizeObserver: ResizeObserver | null = null
    let keyboardViewportCleanup: (() => void) | null = null
    const reconnectWhenOnline = () => dependencies.reconnectImmediately()

    const reconnectWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        dependencies.reconnectImmediately()
      }
    }

    function mount(host: HTMLElement): void {
      if (state.disposed) {
        return
      }

      state.host = host

      if (!state.wrapper) {
        state.wrapper = document.createElement('div')
        state.wrapper.className = 'terminal-session-host h-full min-h-0 min-w-0'
      }

      host.appendChild(state.wrapper)
      const terminal = state.terminal

      if (terminal && detachedScroll) {
        const element = terminal.element
        element.scrollTop = detachedScroll.following
          ? element.scrollHeight
          : detachedScroll.top
        detachedScroll = null
        terminal.setRenderingPaused(false)
        // An empty write makes wterm re-read follow-output from the restored offset.
        terminal.write('')
      }

      state.socket?.manager.reconnection(true)

      if (!state.opened) {
        const opened = Effect.runSyncExit(
          Effect.sync(() => dependencies.openTerminal())
        )

        if (Exit.isFailure(opened)) {
          dependencies.failRendering(Cause.squash(opened.cause))

          return
        }
      }

      keyboardViewportCleanup?.()
      keyboardViewportCleanup = null

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

            const textarea =
              state.wrapper?.querySelector<HTMLTextAreaElement>(
                '.wterm textarea'
              )

            const keyboardOpen =
              document.activeElement === textarea &&
              viewport.height < document.documentElement.clientHeight - 100

            if (!keyboardOpen) {
              appFrame.style.removeProperty('--app-visual-viewport-height')
              appFrame.style.removeProperty('--app-visual-viewport-offset-top')

              return
            }

            // The visual viewport already excludes Safari's toolbars.
            appFrame.style.setProperty(
              '--app-visual-viewport-height',
              `${viewport.height}px`
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
        keyboardViewportCleanup = () => {
          viewport.removeEventListener('resize', syncKeyboardViewport)
          viewport.removeEventListener('scroll', syncKeyboardViewport)

          if (viewportFrame !== null) {
            window.cancelAnimationFrame(viewportFrame)
          }

          appFrame.style.removeProperty('--app-visual-viewport-height')
          appFrame.style.removeProperty('--app-visual-viewport-offset-top')
        }
      }

      resizeObserver?.disconnect()
      resizeObserver = new ResizeObserver(() => dependencies.scheduleFit())
      resizeObserver.observe(host)

      if (!wakeListenersAttached) {
        window.addEventListener('online', reconnectWhenOnline)
        document.addEventListener('visibilitychange', reconnectWhenVisible)
        wakeListenersAttached = true
      }

      dependencies.scheduleFit()

      if (!state.socket && state.opened) {
        dependencies.connect()
      } else {
        dependencies.reconnectImmediately()
      }
    }

    function unmount(host: HTMLElement): void {
      if (state.host !== host) {
        return
      }

      resizeObserver?.disconnect()
      resizeObserver = null
      state.socket?.manager.reconnection(false)

      if (wakeListenersAttached) {
        window.removeEventListener('online', reconnectWhenOnline)
        document.removeEventListener('visibilitychange', reconnectWhenVisible)
        wakeListenersAttached = false
      }

      keyboardViewportCleanup?.()
      keyboardViewportCleanup = null
      dependencies.cancelControllerResizeIntent(false)
      state.selectionDragCancel?.()
      const element = state.terminal?.element

      if (element) {
        detachedScroll = {
          top: element.scrollTop,
          following:
            element.scrollHeight - element.scrollTop - element.clientHeight < 5
        }
        state.terminal?.setRenderingPaused(true)
      }

      state.wrapper?.remove()
      state.host = null
      dependencies.update({ hoveredLink: null })
      state.focusAfterRender = false
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.wrapper?.remove()
      })
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const cleanup = keyboardViewportCleanup
        keyboardViewportCleanup = null
        cleanup?.()
      })
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (wakeListenersAttached) {
          window.removeEventListener('online', reconnectWhenOnline)
          document.removeEventListener('visibilitychange', reconnectWhenVisible)
          wakeListenersAttached = false
        }
      })
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const observer = resizeObserver
        resizeObserver = null
        observer?.disconnect()
      })
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.selectionDragCancel?.()
      })
    )

    return { mount, unmount }
  })
}
