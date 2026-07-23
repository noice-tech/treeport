const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  "[tabindex]:not([tabindex='-1'])"
].join(',')

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ].filter(
    (element) =>
      !element.closest('[inert]') && element.getClientRects().length > 0
  )
}

export function trapTabKey(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') {
    return
  }

  const elements = focusableElements(container)
  if (!elements.length) {
    event.preventDefault()
    container.focus()
    return
  }

  const first = elements[0]!
  const last = elements.at(-1)!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
