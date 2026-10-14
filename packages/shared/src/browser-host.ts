// Host-level primitives shared by Chromium and Electron, independent of the
// daemon's workspace protocols. Do not re-export the application barrel here.
import * as Schema from 'effect/Schema'

export { decodeUnknownOrNull } from './schema.js'
export { BROWSER_VIDEO_CAPTURE_SOURCE } from './browser-video.js'

export const browserPanelIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)

// Observed addresses are metadata, not navigation input. Never shorten a URL:
// doing so can change its destination. Transport payload limits still apply.
export const browserObservedUrlSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.filter(
    (value) => {
      if (!URL.canParse(value)) {
        return false
      }

      const url = new URL(value)
      return (
        (url.protocol === 'http:' ||
          url.protocol === 'https:' ||
          // File paths belong to the browser runtime. Do not accept UNC hosts.
          (url.protocol === 'file:' && url.hostname === '')) &&
        url.username === '' &&
        url.password === ''
      )
    },
    {
      message: () =>
        'Expected an absolute HTTP, HTTPS, or local file URL without credentials'
    }
  )
)

export const browserUrlSchema = browserObservedUrlSchema.pipe(
  Schema.maxLength(4_096)
)
