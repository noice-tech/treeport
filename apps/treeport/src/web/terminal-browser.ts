import type { WTerm } from '@wterm/dom'
import type { TerminalActivity } from '@treeport/shared'

import {
  browserTrace,
  browserTracingEnabled,
  newBrowserCorrelationId
} from './agent-tracing'

export const TERMINAL_FONT_SIZE = 14
const TERMINAL_LINE_HEIGHT = 1.15

const TERMINAL_TOUCH_SELECTION_DELAY_MS = 450
const TERMINAL_TOUCH_PASTE_DELAY_MS = 550
const TERMINAL_TOUCH_SELECTION_SLOP = 10
const TERMINAL_TOUCH_MOMENTUM_DECAY = 0.95
const TERMINAL_TOUCH_MOMENTUM_MIN_ROWS_PER_FRAME = 0.05
// Matches wterm's tolerance for treating the viewport as following live output.
const TERMINAL_SCROLLBACK_BOTTOM_TOLERANCE = 5

interface WTermMetrics {
  _charWidth: number
  _rowHeight: number
}

export function setTerminalFontSize(terminal: WTerm, fontSize: number): void {
  // wterm sizes rows from --term-row-height and measures the cell width from
  // the font, so both follow the font size without rebuilding the grid.
  terminal.element.style.setProperty('--term-font-size', `${fontSize}px`)
  terminal.element.style.setProperty(
    '--term-row-height',
    `${Math.ceil(fontSize * TERMINAL_LINE_HEIGHT)}px`
  )
}

export function terminalCellSize(
  terminal: WTerm
): { width: number; height: number } | null {
  // SAFETY: The pinned wterm keeps its measured cell metrics private and
  // refreshes them whenever it measures the font.
  const { _charWidth: width, _rowHeight: height } = Object(
    terminal
  ) as WTermMetrics
  return width > 0 && height > 0 ? { width, height } : null
}

export function pasteTerminalText(terminal: WTerm, text: string): void {
  const normalized = text.replace(/\r?\n/g, '\r')
  // Strip ESC so pasted text cannot end bracketed paste and inject commands.
  terminal.onData?.(
    terminal.bridge?.bracketedPaste()
      ? `\u001b[200~${normalized.replaceAll('\u001b', '')}\u001b[201~`
      : normalized
  )
}

export function terminalActivityLabel(activity: TerminalActivity): string {
  const label =
    activity.state === 'working'
      ? activity.progress === null
        ? 'working'
        : `${activity.progress}% complete`
      : activity.state === 'blocked'
        ? activity.kind === 'permission'
          ? 'needs approval'
          : activity.kind === 'question'
            ? 'needs an answer'
            : activity.kind === 'auth'
              ? 'needs sign-in'
              : 'needs attention'
        : activity.state
  return activity.message ? `${label}: ${activity.message}` : label
}

// Shells default their title to `user@host:cwd`; the user and host repeat on
// every row, so show only the reported directory.
export function terminalDisplayTitle(
  runtimeTitle: string | undefined,
  name: string
): string {
  return (
    /^[^\s@]+@[^\s:]+:\s*(\S.*)$/.exec(runtimeTitle ?? '')?.[1] ||
    runtimeTitle ||
    name
  )
}

export interface TerminalInputModifiers {
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export function terminalInputWithModifiers(
  data: string,
  modifiers: TerminalInputModifiers
): string {
  if (modifiers.shift && (data === '\t' || data === '\u001b[Z')) {
    return '\u001b[Z'
  }

  if (modifiers.shift && data === '\r' && !modifiers.ctrl && !modifiers.alt) {
    return '\u001b[13;2u'
  }

  const arrow =
    data.length === 3 &&
    (data.startsWith('\u001b[') || data.startsWith('\u001bO'))
      ? data[2]
      : null
  if (
    arrow &&
    'ABCDHF'.includes(arrow) &&
    (modifiers.ctrl || modifiers.alt || modifiers.shift)
  ) {
    const modifier =
      1 +
      Number(modifiers.shift) +
      2 * Number(modifiers.alt) +
      4 * Number(modifiers.ctrl)
    return `\u001b[1;${modifier}${arrow}`
  }

  if (modifiers.shift && data.length === 1) {
    // A software Shift latch also covers the standard US punctuation pairs.
    const unshifted = "1234567890-=[]\\;',./`"
    const shifted = '!@#$%^&*()_+{}|:"<>?~'
    const index = unshifted.indexOf(data)
    data = index === -1 ? data.toUpperCase() : shifted[index]!
  }

  if (modifiers.ctrl && data.length === 1) {
    data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
  }

  return modifiers.alt ? `\u001b${data}` : data
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

function activateTerminalLink(
  event: MouseEvent,
  url: string,
  terminalId?: string
): void {
  if (
    event.button !== 0 ||
    (!globalThis.matchMedia?.('(pointer: coarse)').matches &&
      (usesMacKeyboard() ? !event.metaKey : !event.ctrlKey))
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
    void window.treeportDesktop?.openFileUrl?.(url).catch(() => undefined)
    return
  }

  if (
    terminalId &&
    (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')
  ) {
    const requestId = browserTracingEnabled() ? newBrowserCorrelationId() : null
    const startedAt = performance.now()
    const headers = new Headers({ 'content-type': 'application/json' })
    if (requestId) {
      headers.set('x-request-id', requestId)
      browserTrace('browser.open.click', requestId, { terminalId })
    }

    void fetch(
      `/api/terminals/${encodeURIComponent(terminalId)}/browser-apps/open`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ url })
      }
    ).then(
      (response) => {
        if (requestId) {
          browserTrace('browser.open.response', requestId, {
            status: response.status,
            elapsedMs: performance.now() - startedAt
          })
        }
      },
      () => {
        if (requestId) {
          browserTrace('browser.open.failed', requestId, {
            elapsedMs: performance.now() - startedAt
          })
        }
      }
    )
  }
}

export function trackTerminalSelection(
  wrapper: HTMLElement,
  options: {
    requestControl: () => void
  }
): () => void {
  const handleMouseDown = () => {
    options.requestControl()
    // Let wterm route plain clicks and drags to mouse-aware applications such
    // as Pi fullscreen, which owns transcript selection. Shift still lets the
    // user explicitly choose local terminal selection.
  }

  wrapper.addEventListener('mousedown', handleMouseDown, true)
  return () => wrapper.removeEventListener('mousedown', handleMouseDown, true)
}

export function trackTerminalScrolling(
  wrapper: HTMLElement,
  terminal: WTerm,
  onResumeInput: () => void,
  onPasteRequest: () => void
): void {
  let touchStart: { x: number; y: number } | null = null
  let touchScroll: { x: number; y: number; time: number } | null = null
  let touchScrollVelocity = 0
  let touchMomentumFrame: number | null = null
  let wheelRows = 0
  let wheelAxis: 'x' | 'y' = 'y'
  let touchSelectionTimer: number | null = null
  let touchSelectionActive = false
  let touchPasteTimer: number | null = null
  let touchPasteStart: Array<{ identifier: number; x: number; y: number }> = []

  const terminalCellAt = (clientX: number, clientY: number) => {
    const cell = terminalCellSize(terminal)
    if (!cell || !terminal.bridge) {
      return null
    }

    // Rows count from the oldest retained history row, matching wterm's
    // scroll content where every retained row has the same height.
    const element = terminal.element
    const bounds = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const x = clientX - bounds.left - (parseFloat(style.paddingLeft) || 0)
    const y =
      clientY -
      bounds.top -
      (parseFloat(style.paddingTop) || 0) +
      element.scrollTop
    return {
      col: Math.min(terminal.cols - 1, Math.max(0, Math.floor(x / cell.width))),
      row: Math.min(
        terminal.bridge.getScrollbackCount() + terminal.rows - 1,
        Math.max(0, Math.floor(y / cell.height))
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
  const stopTouchMomentum = () => {
    if (touchMomentumFrame !== null) {
      window.cancelAnimationFrame(touchMomentumFrame)
      touchMomentumFrame = null
    }
  }

  const reportsWheel = () => {
    // wterm reports wheels to mouse-aware applications such as Pi fullscreen
    // unless the user has scrolled back into local history.
    const element = terminal.element
    return (
      Boolean(terminal.bridge?.mouseTracking?.()) &&
      element.scrollHeight - element.clientHeight - element.scrollTop <=
        TERMINAL_SCROLLBACK_BOTTOM_TOLERANCE
    )
  }
  // wterm sends one report per wheel event whatever its delta, so trackpads
  // and touch would scroll applications far too fast. Pace reports to one per
  // row of travel through untrusted events that wterm encodes as usual.
  const reportWheelRows = (
    rows: number,
    axis: 'x' | 'y',
    source: {
      clientX: number
      clientY: number
      altKey: boolean
      ctrlKey: boolean
    }
  ) => {
    if (terminal.bridge?.synchronizedOutput?.()) {
      wheelRows = 0
      return
    }

    if (axis !== wheelAxis || Math.sign(rows) !== Math.sign(wheelRows)) {
      wheelRows = 0
      wheelAxis = axis
    }

    wheelRows += rows
    const count = Math.trunc(wheelRows)
    wheelRows -= count
    for (let index = 0; index < Math.abs(count); index += 1) {
      terminal.element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: source.clientX,
          clientY: source.clientY,
          altKey: source.altKey,
          ctrlKey: source.ctrlKey,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaX: axis === 'x' ? Math.sign(count) : 0,
          deltaY: axis === 'y' ? Math.sign(count) : 0
        })
      )
    }
  }

  const suppressSynchronizedScroll = (event: Event) => {
    if (!terminal.bridge?.synchronizedOutput?.()) {
      return false
    }

    // The painted frame is frozen while the buffer changes underneath it.
    // Block both local scrolling and mouse-wheel reports to the application.
    event.preventDefault()
    event.stopImmediatePropagation()
    clearTouchSelectionTimer()
    clearTouchPasteTimer()
    touchStart = null
    touchSelectionActive = false
    return true
  }

  wrapper.addEventListener(
    'wheel',
    (event) => {
      if (
        !event.isTrusted ||
        suppressSynchronizedScroll(event) ||
        event.shiftKey ||
        !reportsWheel()
      ) {
        return
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      const delta = horizontal ? event.deltaX : event.deltaY
      const rows =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? delta
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? delta * terminal.rows
            : delta / (terminalCellSize(terminal)?.height ?? 16)
      reportWheelRows(rows, horizontal ? 'x' : 'y', event)
    },
    { capture: true, passive: false }
  )
  // wterm scrolls history natively; Treeport intercepts touches while it owns
  // a selection/paste gesture, output is frozen, or an application receives
  // wheel reports.
  wrapper.addEventListener(
    'touchstart',
    (event) => {
      stopTouchMomentum()
      touchScroll = null
      if (suppressSynchronizedScroll(event)) {
        return
      }

      if (event.touches.length === 2) {
        clearTouchSelectionTimer()
        clearTouchPasteTimer()
        touchStart = null
        touchSelectionActive = false
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
        touchStart = null
        touchSelectionActive = false
        return
      }

      clearTouchPasteTimer()
      const touch = event.touches[0]!
      touchStart = { x: touch.clientX, y: touch.clientY }
      touchScroll = reportsWheel()
        ? { x: touch.clientX, y: touch.clientY, time: event.timeStamp }
        : null
      touchScrollVelocity = 0
      touchSelectionActive = false
      clearTouchSelectionTimer()
      touchSelectionTimer = window.setTimeout(() => {
        touchSelectionTimer = null
        if (!touchStart) {
          return
        }

        const anchor = terminalCellAt(touchStart.x, touchStart.y)
        if (anchor && terminal.selectWord(anchor)) {
          touchSelectionActive = true
          navigator.vibrate?.(10)
        }
      }, TERMINAL_TOUCH_SELECTION_DELAY_MS)
    },
    { capture: true, passive: false }
  )
  wrapper.addEventListener(
    'touchmove',
    (event) => {
      if (suppressSynchronizedScroll(event)) {
        return
      }

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

      if (event.touches.length !== 1) {
        clearTouchSelectionTimer()
        clearTouchPasteTimer()
        touchStart = null
        touchScroll = null
        touchSelectionActive = false
        return
      }

      const touch = event.touches[0]!
      if (touchSelectionActive) {
        event.preventDefault()
        // wterm selections are native DOM ranges, so dragging moves their focus.
        const end = document.caretRangeFromPoint(touch.clientX, touch.clientY)
        const selection = window.getSelection()
        if (
          end &&
          selection?.rangeCount &&
          wrapper.contains(end.startContainer)
        ) {
          selection.extend(end.startContainer, end.startOffset)
        }

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

      const cell = terminalCellSize(terminal)
      if (touchScroll && cell) {
        event.preventDefault()
        // Content follows the finger, so dragging up scrolls toward newer rows.
        const rows = (touchScroll.y - touch.clientY) / cell.height
        const elapsed = event.timeStamp - touchScroll.time
        if (elapsed > 0) {
          touchScrollVelocity = rows / elapsed
        }

        touchScroll = {
          x: touch.clientX,
          y: touch.clientY,
          time: event.timeStamp
        }
        reportWheelRows(rows, 'y', {
          clientX: touch.clientX,
          clientY: touch.clientY,
          altKey: false,
          ctrlKey: false
        })
      }
    },
    { capture: true, passive: false }
  )
  const resetTouchScroll = (event: TouchEvent) => {
    if (suppressSynchronizedScroll(event)) {
      touchScroll = null
      return
    }

    if (touchSelectionActive) {
      event.preventDefault()
    }

    const momentum = touchScroll
    if (
      event.type === 'touchend' &&
      momentum &&
      !touchSelectionActive &&
      event.timeStamp - momentum.time < 100
    ) {
      let previous = performance.now()
      const glide = (now: number) => {
        const elapsed = now - previous
        previous = now
        const rows = touchScrollVelocity * elapsed
        touchScrollVelocity *= TERMINAL_TOUCH_MOMENTUM_DECAY ** (elapsed / 16)
        if (
          Math.abs(touchScrollVelocity * 16) <
            TERMINAL_TOUCH_MOMENTUM_MIN_ROWS_PER_FRAME ||
          !reportsWheel()
        ) {
          touchMomentumFrame = null
          return
        }

        reportWheelRows(rows, 'y', {
          clientX: momentum.x,
          clientY: momentum.y,
          altKey: false,
          ctrlKey: false
        })
        touchMomentumFrame = window.requestAnimationFrame(glide)
      }
      touchMomentumFrame = window.requestAnimationFrame(glide)
    }

    clearTouchSelectionTimer()
    clearTouchPasteTimer()
    touchStart = null
    touchScroll = null
    touchSelectionActive = false
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

export function terminalOptions(terminalId?: string) {
  return {
    scrollbackLines: 50_000,
    linkHandler: {
      activate: (event: MouseEvent, url: string) =>
        activateTerminalLink(event, url, terminalId)
    }
  } as const
}
