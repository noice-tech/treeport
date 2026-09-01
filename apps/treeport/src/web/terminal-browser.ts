import type { Terminal } from '@xterm/xterm'
import type { TerminalProgress } from '@treeport/shared'

export const TERMINAL_FONT_SIZE = 14

const TERMINAL_TOUCH_ROWS_PER_WHEEL = 1
const TERMINAL_TOUCH_SELECTION_DELAY_MS = 450
const TERMINAL_TOUCH_PASTE_DELAY_MS = 550
const TERMINAL_TOUCH_SELECTION_SLOP = 10

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
  return /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform ?? '')
}

export function activateTerminalLink(
  event: MouseEvent,
  url: string,
  terminalId?: string
): void {
  if (
    !globalThis.matchMedia?.('(pointer: coarse)').matches &&
    (usesMacKeyboard() ? !event.metaKey : !event.ctrlKey)
  ) {
    return
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return
  }
  if (parsedUrl.protocol === 'file:') {
    void window.treeportDesktop?.openFileUrl(url).catch(() => undefined)
    return
  }

  if (
    terminalId &&
    (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')
  ) {
    void fetch(
      `/api/terminals/${encodeURIComponent(terminalId)}/browser-panels/open`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url })
      }
    ).catch(() => undefined)
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

export function trackTerminalSelection(
  wrapper: HTMLElement,
  terminal: Terminal,
  options: {
    requestControl: () => void
  }
): () => void {
  const handleMouseDown = (event: MouseEvent) => {
    options.requestControl()
    // Selection stays inside this browser even when a full-screen application
    // has enabled mouse reporting. xterm interprets the platform modifier as
    // a request for local selection and never sends it to the child PTY.
    forcePlainSelectionWhileMouseReporting(event, terminal)
  }

  wrapper.addEventListener('mousedown', handleMouseDown, true)
  return () => wrapper.removeEventListener('mousedown', handleMouseDown, true)
}

export function trackTerminalScrolling(
  wrapper: HTMLElement,
  terminal: Terminal,
  onScroll: (event: WheelEvent) => void,
  onResumeInput: () => void,
  onPasteRequest: () => void
): (data: string) => string {
  let lastTouchY: number | null = null
  let touchScrollRemainder = 0
  let wheelScrollRemainder = 0
  const wheelInputRepeats: number[] = []
  const syntheticWheelEvents = new WeakSet<WheelEvent>()
  let touchStart: { x: number; y: number } | null = null
  let touchSelectionTimer: number | null = null
  let touchSelectionAnchor: { column: number; row: number } | null = null
  let touchPasteTimer: number | null = null
  let touchPasteStart: Array<{ identifier: number; x: number; y: number }> = []

  const terminalCellAt = (clientX: number, clientY: number) => {
    const element = terminal.element
    if (!element) {
      return null
    }

    const bounds = element.getBoundingClientRect()
    return {
      column: Math.min(
        terminal.cols - 1,
        Math.max(
          0,
          Math.floor(((clientX - bounds.left) / bounds.width) * terminal.cols)
        )
      ),
      row:
        terminal.buffer.active.viewportY +
        Math.min(
          terminal.rows - 1,
          Math.max(
            0,
            Math.floor(((clientY - bounds.top) / bounds.height) * terminal.rows)
          )
        )
    }
  }

  const clearTouchSelectionTimer = () => {
    if (touchSelectionTimer !== null) {
      window.clearTimeout(touchSelectionTimer)
      touchSelectionTimer = null
    }
  }
  const clearTouchPasteTimer = () => {
    if (touchPasteTimer !== null) {
      window.clearTimeout(touchPasteTimer)
      touchPasteTimer = null
    }

    touchPasteStart = []
  }

  // xterm reduces likely trackpad deltas to 30% and emits only one mouse
  // report when an event crosses multiple rows. Preserve the pixel distance,
  // let xterm encode one valid report, and expand it before transport.
  terminal.attachCustomWheelEventHandler((event) => {
    const element = terminal.element
    if (
      !element?.classList.contains('enable-mouse-events') ||
      syntheticWheelEvents.has(event) ||
      event.deltaY === 0
    ) {
      return true
    }

    const bounds = element.getBoundingClientRect()
    const rowHeight = bounds.height / terminal.rows || 16
    const rowDelta =
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        ? event.deltaY / rowHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * terminal.rows
          : event.deltaY
    wheelScrollRemainder += rowDelta
    const rows = Math.trunc(wheelScrollRemainder)
    wheelScrollRemainder -= rows

    if (rows === 0) {
      return false
    }

    const syntheticEvent = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: event.clientX,
      clientY: event.clientY,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: Math.sign(rows),
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey
    })
    syntheticWheelEvents.add(syntheticEvent)
    wheelInputRepeats.push(Math.abs(rows))
    queueMicrotask(() => element.dispatchEvent(syntheticEvent))
    return false
  })

  wrapper.addEventListener('wheel', onScroll, {
    capture: true,
    passive: true
  })
  wrapper.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length === 2) {
        clearTouchSelectionTimer()
        clearTouchPasteTimer()
        lastTouchY = null
        touchScrollRemainder = 0
        touchStart = null
        touchSelectionAnchor = null
        touchPasteStart = Array.from(event.touches, (touch) => ({
          identifier: touch.identifier,
          x: touch.clientX,
          y: touch.clientY
        }))
        touchPasteTimer = window.setTimeout(() => {
          touchPasteTimer = null
          touchPasteStart = []
          navigator.vibrate?.(10)
          onPasteRequest()
        }, TERMINAL_TOUCH_PASTE_DELAY_MS)
        return
      }

      if (event.touches.length !== 1) {
        clearTouchSelectionTimer()
        clearTouchPasteTimer()
        lastTouchY = null
        touchScrollRemainder = 0
        touchStart = null
        touchSelectionAnchor = null
        return
      }

      clearTouchPasteTimer()
      const touch = event.touches[0]!
      lastTouchY = touch.clientY
      touchScrollRemainder = 0
      touchStart = { x: touch.clientX, y: touch.clientY }
      touchSelectionAnchor = null
      clearTouchSelectionTimer()
      touchSelectionTimer = window.setTimeout(() => {
        touchSelectionTimer = null
        if (!touchStart) {
          return
        }

        touchSelectionAnchor = terminalCellAt(touchStart.x, touchStart.y)
        if (touchSelectionAnchor) {
          terminal.select(
            touchSelectionAnchor.column,
            touchSelectionAnchor.row,
            1
          )
          navigator.vibrate?.(10)
        }
      }, TERMINAL_TOUCH_SELECTION_DELAY_MS)
    },
    { capture: true, passive: true }
  )
  wrapper.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches.length === 2 && touchPasteStart.length === 2) {
        const moved = touchPasteStart.some((start) => {
          const touch = Array.from(event.touches).find(
            (candidate) => candidate.identifier === start.identifier
          )
          return (
            !touch ||
            Math.hypot(touch.clientX - start.x, touch.clientY - start.y) >
              TERMINAL_TOUCH_SELECTION_SLOP
          )
        })
        if (moved) {
          clearTouchPasteTimer()
        } else {
          event.preventDefault()
        }

        return
      }

      if (event.touches.length !== 1 || lastTouchY === null) {
        clearTouchSelectionTimer()
        clearTouchPasteTimer()
        lastTouchY = null
        touchScrollRemainder = 0
        touchStart = null
        touchSelectionAnchor = null
        return
      }

      const element = terminal.element
      if (!element) {
        return
      }

      const touch = event.touches[0]!
      if (touchSelectionAnchor) {
        event.preventDefault()
        const end = terminalCellAt(touch.clientX, touch.clientY)
        if (!end) {
          return
        }

        const anchorOffset =
          touchSelectionAnchor.row * terminal.cols + touchSelectionAnchor.column
        const endOffset = end.row * terminal.cols + end.column
        const startOffset = Math.min(anchorOffset, endOffset)
        terminal.select(
          startOffset % terminal.cols,
          Math.floor(startOffset / terminal.cols),
          Math.abs(endOffset - anchorOffset) + 1
        )
        return
      }

      if (
        touchStart &&
        Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) >
          TERMINAL_TOUCH_SELECTION_SLOP
      ) {
        clearTouchSelectionTimer()
        touchStart = null
      }

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
      if (!element.classList.contains('enable-mouse-events')) {
        terminal.scrollLines(steps)
        return
      }

      const wheelTarget = element.querySelector<HTMLElement>('.xterm-screen')
      if (!wheelTarget) {
        return
      }

      const clientX = Math.min(
        Math.max(touch.clientX, bounds.left),
        bounds.right - 1
      )
      const clientY = Math.min(
        Math.max(touch.clientY, bounds.top),
        bounds.bottom - 1
      )
      for (let index = 0; index < Math.abs(steps); index += 1) {
        wheelTarget.dispatchEvent(
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
  const resetTouchScroll = (event: TouchEvent) => {
    if (touchSelectionAnchor) {
      event.preventDefault()
    } else if (event.type === 'touchend' && touchStart) {
      event.preventDefault()
      const screen =
        terminal.element?.querySelector<HTMLElement>('.xterm-screen')
      if (screen) {
        for (const type of ['mousemove', 'mousedown', 'mouseup'] as const) {
          screen.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: touchStart.x,
              clientY: touchStart.y,
              buttons: type === 'mousedown' ? 1 : 0
            })
          )
        }
      }
    }

    clearTouchSelectionTimer()
    clearTouchPasteTimer()
    lastTouchY = null
    touchScrollRemainder = 0
    touchStart = null
    touchSelectionAnchor = null
  }
  wrapper.addEventListener('touchend', resetTouchScroll, {
    capture: true,
    passive: false
  })
  wrapper.addEventListener('touchcancel', resetTouchScroll, {
    capture: true,
    passive: false
  })
  wrapper.addEventListener('paste', onResumeInput, true)

  return (data) => {
    const repeat = wheelInputRepeats.shift() ?? 1
    return repeat === 1 ? data : data.repeat(repeat)
  }
}

export function terminalOptions(terminalId?: string) {
  return {
    cursorBlink: true,
    convertEol: false,
    fontFamily:
      '"SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace',
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: 1.15,
    scrollback: 50_000,
    // FitAddon reserves the configured scrollbar width from the terminal grid.
    // Keep that reservation negligible and expand the absolute scrollbar with
    // CSS so it overlays the terminal instead.
    overviewRuler: { width: 1 },
    allowProposedApi: false,
    macOptionClickForcesSelection: true,
    linkHandler: {
      activate: (event: MouseEvent, url: string) =>
        activateTerminalLink(event, url, terminalId),
      allowNonHttpProtocols: true
    },
    theme: {
      background: '#09090b',
      foreground: '#e4e4e7',
      cursor: '#67e8f9',
      selectionBackground: '#f4f4f5',
      selectionForeground: '#09090b',
      scrollbarSliderBackground: '#3f3f46',
      scrollbarSliderHoverBackground: '#52525b',
      scrollbarSliderActiveBackground: '#71717a',
      overviewRulerBorder: '#00000000',
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
