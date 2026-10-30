import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import {
  type TerminalSessionState,
  type TerminalSessionSnapshot
} from './state'
import { isIOS } from '../lib/platform'

let keyboardViewportInstalled = false
let keyboardHold: HTMLTextAreaElement | null = null
let keyboardHoldRelease: number | null = null

// EXTERNAL: iOS hides the keyboard as soon as no editable element has focus, and a new
// terminal may need a server round trip before it exists. A hidden field keeps the
// keyboard up until the next terminal takes focus, or briefly if none arrives.
function holdKeyboard(): void {
  if (!keyboardHold) {
    keyboardHold = document.createElement('textarea')
    keyboardHold.tabIndex = -1
    keyboardHold.setAttribute('aria-hidden', 'true')
    keyboardHold.setAttribute('autocapitalize', 'off')
    keyboardHold.setAttribute('autocomplete', 'off')
    keyboardHold.style.cssText =
      'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(keyboardHold)
  }

  const hold = keyboardHold
  hold.focus({ preventScroll: true })

  if (keyboardHoldRelease !== null) {
    window.clearTimeout(keyboardHoldRelease)
  }

  keyboardHoldRelease = window.setTimeout(() => {
    keyboardHoldRelease = null

    if (document.activeElement === hold) {
      hold.blur()
    }
  }, 3000)
}

function installKeyboardViewport(): void {
  const viewport = window.visualViewport

  if (keyboardViewportInstalled || !isIOS() || !viewport) {
    return
  }

  keyboardViewportInstalled = true
  let viewportFrame: number | null = null

  // EXTERNAL: WebKit leaves the layout viewport unchanged when the software keyboard
  // opens. Size and position the application against the visual viewport
  // instead of scrolling the document between the cursor and accessory row.
  // One page-wide owner keeps the frame steady while focus moves between terminals.
  const syncKeyboardViewport = () => {
    if (viewportFrame !== null) {
      window.cancelAnimationFrame(viewportFrame)
    }

    viewportFrame = window.requestAnimationFrame(() => {
      viewportFrame = null
      const appFrame = document.querySelector<HTMLElement>('.app-frame')

      if (!appFrame) {
        return
      }

      const focused = document.activeElement

      // EXTERNAL: With a hardware keyboard, iPadOS shows only the short shortcut bar
      // but still scrolls the visual viewport to reveal the focused textarea.
      const viewportReduced =
        viewport.height < document.documentElement.clientHeight ||
        viewport.offsetTop > 0

      const focusMovingBetweenTerminals = !focused || focused === document.body

      if (focusMovingBetweenTerminals && viewportReduced) {
        return
      }

      const keyboardOpen =
        focused instanceof HTMLTextAreaElement &&
        (focused === keyboardHold || focused.closest('.xterm-host') !== null) &&
        viewportReduced

      if (!keyboardOpen) {
        appFrame.style.removeProperty('--app-frame-height')
        appFrame.style.removeProperty('--app-keyboard-inset')
        appFrame.style.removeProperty('--app-visual-viewport-offset-top')

        return
      }

      // EXTERNAL: The visual viewport already excludes Safari's toolbars. The frame
      // still reaches the layout viewport bottom so its background fills the area
      // behind the keyboard, while padding keeps content above it.
      const frameHeight =
        document.documentElement.clientHeight - viewport.offsetTop

      appFrame.style.setProperty('--app-frame-height', `${frameHeight}px`)
      appFrame.style.setProperty(
        '--app-keyboard-inset',
        `${Math.max(0, frameHeight - viewport.height)}px`
      )
      appFrame.style.setProperty(
        '--app-visual-viewport-offset-top',
        `${viewport.offsetTop}px`
      )
    })
  }

  viewport.addEventListener('resize', syncKeyboardViewport)
  viewport.addEventListener('scroll', syncKeyboardViewport)
  document.addEventListener('focusin', syncKeyboardViewport)
  document.addEventListener('focusout', syncKeyboardViewport)
  syncKeyboardViewport()
}

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
    let detachedScroll: { top: number; following: boolean } | null = null
    let wakeListenersAttached = false
    let resizeObserver: ResizeObserver | null = null
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
        // EXTERNAL: An empty write makes wterm re-read follow-output from the restored offset.
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

      installKeyboardViewport()

      if (document.activeElement === keyboardHold) {
        state.terminal?.focus()
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

      if (isIOS() && state.wrapper?.contains(document.activeElement)) {
        holdKeyboard()
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
