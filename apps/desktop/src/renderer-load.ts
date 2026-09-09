import type { WebContents } from 'electron'
import * as Effect from 'effect/Effect'
import { z } from 'zod'

// The connecting UI lives in this document too. Backend health checks cannot
// recover a failed renderer navigation (for example while Vite is starting).
export function loadRenderer(
  renderer: Pick<WebContents, 'loadURL' | 'isDestroyed'>,
  url: string
) {
  return Effect.gen(function* () {
    while (!renderer.isDestroyed()) {
      const loaded = yield* Effect.tryPromise(() => renderer.loadURL(url)).pipe(
        Effect.as(true),
        Effect.catchAll((error) => {
          const failure = z.object({ code: z.string() }).safeParse(error.cause)
          // A newer navigation superseded this one; never navigate back to it.
          if (failure.success && failure.data.code === 'ERR_ABORTED') {
            return Effect.succeed(true)
          }

          return Effect.logWarning(
            'Renderer load failed; retrying',
            error
          ).pipe(Effect.as(false))
        })
      )
      if (loaded) {
        return
      }

      yield* Effect.sleep('500 millis')
    }
  })
}
