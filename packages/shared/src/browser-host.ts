import * as Schema from 'effect/Schema'

export { decodeUnknownOrNull } from './schema.js'

export {
  BROWSER_VIDEO_CAPTURE_SOURCE,
  DEFAULT_BROWSER_VIDEO_SETTINGS,
  browserVideoSettingsSchema,
  type BrowserVideoSettings
} from './browser-video.js'

export { browserClipboardSchema, copyBrowserPage } from './browser-clipboard.js'

export const BROWSER_MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export const browserAppIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128)
)

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
          (url.protocol === 'chrome:' &&
            /^chrome:\/\//i.test(value) &&
            url.hostname !== '' &&
            url.port === '') ||
          (url.protocol === 'file:' && url.hostname === '')) &&
        url.username === '' &&
        url.password === ''
      )
    },
    {
      message: () =>
        'Expected an absolute HTTP, HTTPS, chrome://, or local file URL without credentials'
    }
  )
)

export const browserUrlSchema = browserObservedUrlSchema.pipe(
  Schema.maxLength(4_096)
)
