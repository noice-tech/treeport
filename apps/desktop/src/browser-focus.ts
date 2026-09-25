import crypto from 'node:crypto'
import type { WebContents } from 'electron'
import * as Effect from 'effect/Effect'

// Mouse dispatch focuses a native widget; keyboard dispatch also needs the
// embedder's focused-frame mapping. WebContents.focus alone does not establish
// that mapping for a hidden guest. Await the webview focus IPC, dispatch, then
// restore the desktop control without revealing/selecting the Browser panel.
export function preserveDesktopFocus<A, E>(
  guest: WebContents,
  operation: Effect.Effect<A, E>,
  focusGuest = false
) {
  return Effect.suspend(() => {
    const host = guest.hostWebContents
    if (!host || host.isDestroyed()) {
      return operation
    }

    const key = JSON.stringify(`__treeportFocus_${crypto.randomUUID()}`)
    return Effect.tryPromise(() =>
      host.executeJavaScript(`(async () => {
      const previous = document.activeElement;
      const target = [...document.querySelectorAll('webview')].find(element => element.getWebContentsId() === ${guest.id});
      if (!(previous instanceof HTMLElement) || !target || previous === target) return;
      const workspace = ${focusGuest} ? target.closest('section[aria-hidden="true"][inert]') : null;
      const restoreInert = () => {
        if (workspace?.getAttribute('aria-hidden') === 'true' && !workspace.inert) workspace.inert = true;
      };
      const restore = () => {
        restoreInert();
        if (document.activeElement === target && previous.isConnected && !previous.closest('[inert]')) {
          previous.focus({ preventScroll: true });
        }
      };
      globalThis[${key}] = restore;
      if (${focusGuest}) {
        if (workspace) workspace.inert = false;
        try {
          await target.focus();
        } finally {
          restoreInert();
          if (!globalThis[${key}]) restore();
        }
      }
    })()`)
    ).pipe(
      Effect.timeout('1 second'),
      Effect.zipRight(operation),
      // Schedule cleanup even if capture is interrupted. Electron cannot cancel
      // executeJavaScript; its queued capture must not leave a late DOM reference.
      Effect.ensuring(
        Effect.suspend(() =>
          host.isDestroyed()
            ? Effect.void
            : Effect.tryPromise(() =>
                host.executeJavaScript(`(() => {
        const restore = globalThis[${key}];
        delete globalThis[${key}];
        restore?.();
      })()`)
              ).pipe(
                Effect.timeout('1 second'),
                Effect.catchAll((error) =>
                  Effect.logError('Could not restore desktop focus', error)
                ),
                Effect.asVoid
              )
        )
      )
    )
  })
}
