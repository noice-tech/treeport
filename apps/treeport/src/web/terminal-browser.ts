import type { Terminal } from '@xterm/xterm'
import type { TerminalProgress } from '@treeport/shared'
import {
  forceSpecificCursor,
  stopForcingSpecificCursor
} from './force-specific-cursor'

export const TERMINAL_FONT_SIZE = 14

// tmux copy mode advances five rows for each wheel report. Requiring three
// rows of finger travel keeps the gesture responsive without restoring the
// original excessive gain.
const TERMINAL_TOUCH_ROWS_PER_WHEEL = 3
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

export function activateTerminalLink(event: MouseEvent, url: string): void {
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
    void window.treeportDesktop?.openFileUrl(url).catch(() => undefined)
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

const TERMINAL_SELECTION_SCROLL_INTERVAL_MS = 50
const TERMINAL_SELECTION_DRAG_THRESHOLD_PX = 3

export function trackTerminalSelectionAutoscroll(
  wrapper: HTMLElement,
  terminal: Terminal,
  options: {
    canInput: () => boolean
    sendInput: (data: string) => void
    requestControl: () => void
    onSelectionStart: () => void
    onTmuxSelectionStart: () => void
    onTmuxSelectionFinish: () => void
    onTmuxSelectionCancel: () => void
    selectionStartSequence: string
    selectionStopSequence: string
  }
): () => void {
  let activePointerId: number | null = null
  let drag: {
    startColumn: number
    startRow: number
    startClientX: number
    startClientY: number
    clientX: number
    clientY: number
    tmux: boolean
  } | null = null
  let scrollTimer: number | null = null
  let stopDesktopSelectionRelease: (() => void) | undefined

  const terminalCellAt = (clientX: number, clientY: number) => {
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    const bounds = screen?.getBoundingClientRect()
    if (!bounds?.width || !bounds.height) {
      return null
    }

    // Match xterm's text-boundary behavior: the left half of a cell is the
    // boundary before its glyph and the right half is the boundary after it.
    const selectionColumn = Math.ceil(
      ((clientX - bounds.left) / bounds.width) * terminal.cols + 0.5
    )
    return {
      column: Math.max(1, Math.min(terminal.cols, selectionColumn)),
      endOfLine: selectionColumn > terminal.cols,
      row: Math.max(
        1,
        Math.min(
          terminal.rows,
          Math.floor(((clientY - bounds.top) / bounds.height) * terminal.rows) +
            1
        )
      ),
      bounds
    }
  }

  const stopScrolling = () => {
    if (scrollTimer !== null) {
      window.clearInterval(scrollTimer)
      scrollTimer = null
    }
  }

  function sendDrag() {
    if (!drag) {
      return
    }

    const cell = terminalCellAt(drag.clientX, drag.clientY)
    if (!cell) {
      return
    }

    const verticallyOutside =
      drag.clientY < cell.bounds.top || drag.clientY > cell.bounds.bottom
    const horizontallyOutside =
      drag.clientX < cell.bounds.left || drag.clientX > cell.bounds.right
    const shouldScroll = verticallyOutside && !horizontallyOutside
    if (!shouldScroll) {
      stopScrolling()
    }

    // SGR mouse reports stop at the final cell. End moves tmux's exclusive
    // selection boundary past that cell.
    const endOfLineInput = cell.endOfLine ? '\u001b[F' : ''
    if (!drag.tmux) {
      const distance = Math.hypot(
        drag.clientX - drag.startClientX,
        drag.clientY - drag.startClientY
      )
      if (
        distance < TERMINAL_SELECTION_DRAG_THRESHOLD_PX ||
        !options.canInput()
      ) {
        return
      }

      options.sendInput(
        `${options.selectionStartSequence}\u001b[<0;${drag.startColumn};${drag.startRow}M\u001b[<32;${drag.startColumn};${drag.startRow}M\u001b[<32;${cell.column};${cell.row}M${endOfLineInput}`
      )
      terminal.clearSelection()

      if (activePointerId !== null) {
        wrapper.setPointerCapture(activePointerId)
      }

      drag.tmux = true
      stopDesktopSelectionRelease ??=
        window.treeportDesktop?.onTerminalSelectionRelease(finishDrag)
      window.treeportDesktop?.setTerminalSelectionActive(true)
      options.onTmuxSelectionStart()
    } else if (options.canInput()) {
      options.sendInput(
        `\u001b[<32;${cell.column};${cell.row}M${endOfLineInput}`
      )
    }

    if (shouldScroll && scrollTimer === null) {
      scrollTimer = window.setInterval(
        sendDrag,
        TERMINAL_SELECTION_SCROLL_INTERVAL_MS
      )
    }
  }

  const releasePointerCapture = () => {
    const pointerId = activePointerId
    activePointerId = null
    if (pointerId !== null && wrapper.hasPointerCapture(pointerId)) {
      wrapper.releasePointerCapture(pointerId)
    }
  }

  const finishDrag = () => {
    if (!drag) {
      releasePointerCapture()
      return
    }

    const hadTmuxDrag = drag.tmux
    if (hadTmuxDrag && options.canInput()) {
      const cell = terminalCellAt(drag.clientX, drag.clientY)
      if (cell) {
        const releaseRow =
          cell.row === 1
            ? Math.min(2, terminal.rows)
            : cell.row === terminal.rows
              ? Math.max(1, terminal.rows - 1)
              : cell.row
        options.onTmuxSelectionFinish()
        options.sendInput(
          `${options.selectionStopSequence}\u001b[<32;${cell.column};${releaseRow}M\u001b[<0;${cell.column};${releaseRow}m`
        )
      }
    }

    stopScrolling()
    drag = null
    stopForcingSpecificCursor()
    if (hadTmuxDrag) {
      window.treeportDesktop?.setTerminalSelectionActive(false)
    }

    releasePointerCapture()
    document.removeEventListener('mousemove', handleMouseMove, true)
    document.removeEventListener('mouseup', handleMouseUp, true)
    window.removeEventListener('blur', handleWindowBlur)
  }

  const handleMouseMove = (event: MouseEvent) => {
    if (!drag) {
      return
    }

    if (!(event.buttons & 1)) {
      finishDrag()
      return
    }

    drag.clientX = event.clientX
    drag.clientY = event.clientY
    sendDrag()
  }

  const handleMouseUp = () => finishDrag()
  const handlePointerDown = (event: PointerEvent) => {
    if (event.isPrimary && event.button === 0) {
      finishDrag()
      activePointerId = event.pointerId
    }
  }
  const handlePointerUp = () => finishDrag()
  const handleLostPointerCapture = () => finishDrag()
  const handleWindowBlur = () => finishDrag()
  const handleMouseDown = (event: MouseEvent) => {
    options.requestControl()
    forcePlainSelectionWhileMouseReporting(event, terminal)
    const cell = terminalCellAt(event.clientX, event.clientY)
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      !cell ||
      event.clientX < cell.bounds.left ||
      event.clientX > cell.bounds.right ||
      event.clientY < cell.bounds.top ||
      event.clientY > cell.bounds.bottom
    ) {
      return
    }

    options.onSelectionStart()
    forceSpecificCursor('text')
    drag = {
      startColumn: cell.column,
      startRow: cell.row,
      startClientX: event.clientX,
      startClientY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      tmux: false
    }
    document.addEventListener('mousemove', handleMouseMove, true)
    document.addEventListener('mouseup', handleMouseUp, true)
    window.addEventListener('blur', handleWindowBlur)
  }

  wrapper.addEventListener('pointerdown', handlePointerDown, true)
  wrapper.addEventListener('pointerup', handlePointerUp, true)
  wrapper.addEventListener('pointercancel', handlePointerUp, true)
  wrapper.addEventListener('lostpointercapture', handleLostPointerCapture, true)
  wrapper.addEventListener('mousedown', handleMouseDown, true)
  return () => {
    if (drag?.tmux && options.canInput()) {
      options.onTmuxSelectionCancel()
    }

    if (drag?.tmux) {
      window.treeportDesktop?.setTerminalSelectionActive(false)
    }

    stopDesktopSelectionRelease?.()
    stopScrolling()
    if (drag) {
      stopForcingSpecificCursor()
      drag = null
    }

    releasePointerCapture()
    wrapper.removeEventListener('pointerdown', handlePointerDown, true)
    wrapper.removeEventListener('pointerup', handlePointerUp, true)
    wrapper.removeEventListener('pointercancel', handlePointerUp, true)
    wrapper.removeEventListener(
      'lostpointercapture',
      handleLostPointerCapture,
      true
    )
    document.removeEventListener('mousemove', handleMouseMove, true)
    document.removeEventListener('mouseup', handleMouseUp, true)
    window.removeEventListener('blur', handleWindowBlur)
  }
}

export function trackTerminalScrolling(
  wrapper: HTMLElement,
  terminal: Terminal,
  onScroll: (event: WheelEvent) => void,
  onResumeInput: () => void,
  onPasteRequest: () => void
): void {
  let lastTouchY: number | null = null
  let touchScrollRemainder = 0
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
  const resetTouchScroll = (event: TouchEvent) => {
    if (touchSelectionAnchor) {
      event.preventDefault()
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
