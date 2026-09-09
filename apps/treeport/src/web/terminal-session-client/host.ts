import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import {
  type TerminalSessionState,
  type TerminalSessionSnapshot
} from './state'

const IOS_BROWSER_TOOLBAR_CLEARANCE = 44

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
    | 'wrapper'
  >,
  dependencies: Dependencies
) {
  return Effect.gen(function* () {
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
            const textarea = state.wrapper?.querySelector<HTMLTextAreaElement>(
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
