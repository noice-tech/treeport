// This function runs inside Chromium through Playwright or Electron. Keep it
// self-contained so it can be serialized without importing code into the page.
export function readBrowserPageMetadata() {
  let faviconUrl: string | null = null
  let bestPriority = -1
  for (const link of document.querySelectorAll<HTMLLinkElement>(
    'link[rel~="icon"]'
  )) {
    // Tab chrome is always dark, even when the page itself uses a light theme.
    const media = link.media.replace(
      /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi,
      (_query, scheme: string) =>
        scheme.toLowerCase() === 'dark'
          ? '(min-width: 0px)'
          : '(max-width: 0px)'
    )
    if (media && !matchMedia(media).matches) {
      continue
    }

    const dark = /prefers-color-scheme\s*:\s*dark/i.test(link.media)
    const svg =
      link.type === 'image/svg+xml' || /\.svg(?:[?#]|$)/i.test(link.href)
    const priority =
      (dark ? 4 : 0) +
      (svg ? 2 : 0) +
      (link.relList.contains('alternate') ? 0 : 1)
    if (link.href && priority >= bestPriority) {
      bestPriority = priority
      faviconUrl = link.href
    }
  }

  return {
    title: document.title,
    faviconUrl:
      faviconUrl ??
      (location.protocol === 'http:' || location.protocol === 'https:'
        ? new URL('/favicon.ico', location.href).href
        : null)
  }
}
