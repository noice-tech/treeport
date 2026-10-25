/* eslint-disable anti-slop/no-runtime-typeof -- This dependency-free worker validates external push and notification data at the browser I/O boundary. */
// Notification-only worker: no caching of authenticated pages, API responses,
// or terminal output, and no interception of Treeport's live network traffic.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = {}

  try {
    payload = event.data?.json() ?? {}
  } catch {
    // A malformed delivery still needs a visible notification on iOS.
  }

  // Always display received pushes: iOS may revoke subscriptions when the
  // worker silently consumes a push. Focused BELs are suppressed by the daemon.
  event.waitUntil(
    self.registration.showNotification(
      typeof payload.title === 'string' ? payload.title : 'Treeport',
      {
        body:
          typeof payload.body === 'string'
            ? payload.body
            : 'A terminal needs attention.',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag:
          typeof payload.tag === 'string' ? payload.tag : 'treeport-attention',
        data: { url: typeof payload.url === 'string' ? payload.url : '/' }
      }
    )
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      let target = new URL('/', self.location.origin)
      const requested = event.notification.data?.url

      if (typeof requested === 'string') {
        try {
          const candidate = new URL(requested, self.location.origin)

          if (
            candidate.origin === self.location.origin &&
            candidate.pathname.startsWith('/projects/')
          ) {
            target = candidate
          }
        } catch {
          // Invalid notification targets fall back to the workspace root.
        }
      }

      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      })

      clients.sort(
        (left, right) =>
          Number(right.url === target.href) - Number(left.url === target.href)
      )

      for (const client of clients) {
        // Do not replace auxiliary app pages on the same origin.
        const pathname = new URL(client.url).pathname

        if (pathname !== '/' && !pathname.startsWith('/projects/')) {
          continue
        }

        try {
          const navigated =
            client.url === target.href
              ? client
              : await client.navigate(target.href)

          if (!navigated) {
            continue
          }

          await navigated.focus()

          return
        } catch {
          // A client can close between enumeration and navigation.
        }
      }

      await self.clients.openWindow(target.href)
    })()
  )
})
