import * as Effect from 'effect/Effect'

type NetworkCloseReason =
  | 'failed'
  | 'interrupted'
  | 'normal'
  | 'peer_closed'
  | 'request_complete'
  | 'slow_client'
  | 'stream_closed'

export function logConnectionClosed(
  channel: string,
  reason: NetworkCloseReason,
  details?: { closeCode?: number; wireReason?: string }
): Effect.Effect<void> {
  return Effect.logDebug('Network connection closed').pipe(
    Effect.annotateLogs({
      channel,
      closeReason: reason,
      closeCode: details?.closeCode ?? null,
      wireReason: details?.wireReason ?? null
    })
  )
}
