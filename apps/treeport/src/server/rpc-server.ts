import type * as HttpApp from '@effect/platform/HttpApp'
import { RpcSerialization, RpcServer } from '@effect/rpc'
import {
  TreeportRpcs,
  type ProjectEventsFailure,
  type ProjectEventsItem
} from '#protocol/rpc'
import { parseProductEvent, type NetworkProductEvent } from '#protocol/socket'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as Scope from 'effect/Scope'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'
import type { TreeportService } from './core/index.ts'
import type { ApplicationServices } from './core/services/infrastructure/application-runtime.ts'
import { logConnectionClosed } from './network-telemetry.ts'
import type { TerminalMetadataManager } from './terminal-metadata.ts'
import type { WorkspacePresenceManager } from './workspace-presence.ts'

const EVENT_QUEUE_CAPACITY = 256

export function makeRpcHttpApp(
  service: TreeportService,
  terminalMetadata: TerminalMetadataManager,
  presence: WorkspacePresenceManager
): Effect.Effect<
  HttpApp.Default<never, Scope.Scope>,
  never,
  ApplicationServices | Scope.Scope
> {
  const handlers = TreeportRpcs.toLayer(
    Effect.succeed({
      WatchProjectEvents: () =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const queue =
              yield* Queue.bounded<ProjectEventsItem>(EVENT_QUEUE_CAPACITY)

            const overflow = yield* Deferred.make<never, ProjectEventsFailure>()
            const queuedEvents: NetworkProductEvent[] = []
            let snapshotted = false

            let closeReason: 'stream_closed' | 'slow_client' = 'stream_closed'

            const overflowSlowClient = () => {
              closeReason = 'slow_client'
              Deferred.unsafeDone(
                overflow,
                Effect.fail({
                  _tag: 'ProjectEventsFailure',
                  message: 'Project event client could not keep up'
                })
              )
            }

            const unsubscribe = service.events.subscribe((event) => {
              const parsed = parseProductEvent(event)

              if (!parsed) {
                return
              }

              if (!snapshotted) {
                if (queuedEvents.length < EVENT_QUEUE_CAPACITY) {
                  queuedEvents.push(parsed)
                } else {
                  overflowSlowClient()
                }

                return
              }

              if (
                !Queue.unsafeOffer(queue, {
                  _tag: 'ProductEvent',
                  event: parsed
                })
              ) {
                overflowSlowClient()
              }
            })

            yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()))
            yield* Effect.addFinalizer((exit) =>
              logConnectionClosed(
                'rpc',
                Exit.isInterrupted(exit) ? 'interrupted' : closeReason
              )
            )
            const terminalMetadataSnapshot = terminalMetadata.snapshot()
            const presenceSnapshot = presence.snapshot()
            const representedEventCount = queuedEvents.length

            Queue.unsafeOffer(queue, {
              _tag: 'Snapshot',
              snapshot: {
                at: new Date().toISOString(),
                terminalMetadata: terminalMetadataSnapshot,
                presence: presenceSnapshot
              }
            })
            queuedEvents.splice(0, representedEventCount)

            for (const event of queuedEvents) {
              if (
                !Queue.unsafeOffer(queue, {
                  _tag: 'ProductEvent',
                  event
                })
              ) {
                overflowSlowClient()
              }
            }

            snapshotted = true

            return Stream.merge(
              Stream.fromQueue(queue),
              Stream.fromEffect(Deferred.await(overflow))
            )
          })
        )
    })
  )

  return RpcServer.toHttpApp(TreeportRpcs, {
    spanPrefix: 'treeport.rpc',
    disableFatalDefects: true
  }).pipe(
    Effect.provide(handlers),
    Effect.provide(RpcSerialization.layerNdjson),
    Effect.withSpan('treeport.rpc.server')
  )
}
