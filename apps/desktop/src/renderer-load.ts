import type { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import * as Effect from 'effect/Effect'
import { z } from 'zod'

// Connection readiness follows navigation, not a daemon API or release number.
// The separate private shell stays usable while this document is unavailable.
export function loadRenderer(
  renderer: Pick<WebContents, 'loadURL' | 'isDestroyed'> &
    Pick<EventEmitter, 'on' | 'removeListener'>,
  url: string,
  onFailure: () => void = () => undefined
) {
  return Effect.gen(function* () {
    while (!renderer.isDestroyed()) {
      let httpStatus = 200
      const navigated = (
        _event: Electron.Event,
        _url: string,
        status: number
      ) => {
        httpStatus = status
      }
      const loaded = yield* Effect.acquireUseRelease(
        Effect.sync(() => renderer.on('did-navigate', navigated)),
        () =>
          Effect.tryPromise(() => renderer.loadURL(url)).pipe(
            // loadURL can finish successfully even when the HTTP document is an
            // error page. Keep recovery controls available for those responses.
            Effect.map(() => httpStatus < 400),
            Effect.catchAll((error) => {
              const failure = z
                .object({ code: z.string() })
                .safeParse(error.cause)
              // A newer navigation superseded this one; never navigate back to it.
              if (failure.success && failure.data.code === 'ERR_ABORTED') {
                return Effect.succeed(null)
              }

              return Effect.logWarning(
                'Renderer load failed; retrying',
                error
              ).pipe(Effect.as(false))
            })
          ),
        () =>
          Effect.sync(() => {
            renderer.removeListener('did-navigate', navigated)
          })
      )
      if (loaded !== false) {
        return loaded === true
      }

      onFailure()
      yield* Effect.sleep('500 millis')
    }
    return false
  })
}
