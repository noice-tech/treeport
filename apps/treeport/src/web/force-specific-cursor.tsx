import { createRef } from 'react'

const cursorOverlayRef = createRef<HTMLDivElement>()

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
