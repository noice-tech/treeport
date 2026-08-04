import { createRef, type CSSProperties } from 'react'

const cursorOverlayRef = createRef<HTMLDivElement>()

export function forceSpecificCursor(
  cursor: Exclude<CSSProperties['cursor'], undefined>
): void {
  if (!cursorOverlayRef.current) {
    throw new Error('ForceSpecificCursor is not mounted')
  }

  cursorOverlayRef.current.style.cursor = cursor
  cursorOverlayRef.current.style.pointerEvents = 'auto'
}

export function stopForcingSpecificCursor(): void {
  if (!cursorOverlayRef.current) {
    throw new Error('ForceSpecificCursor is not mounted')
  }

  cursorOverlayRef.current.style.cursor = ''
  cursorOverlayRef.current.style.pointerEvents = 'none'
}

export function ForceSpecificCursor() {
  return (
    <div
      ref={cursorOverlayRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: 2_147_483_647 }}
    />
  )
}
