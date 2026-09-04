import type * as HttpApp from '@effect/platform/HttpApp'
import { RpcSerialization, RpcServer } from '@effect/rpc'
import {
  TreeportRpcs,
  parseProductEvent,
  type NetworkProductEvent,
  type ProjectEventsFailure,
  type ProjectEventsItem
} from '@treeport/shared'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as Scope from 'effect/Scope'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'
import type { TreeportService } from './core/index'
import type { ApplicationServices } from './core/services/infrastructure/application-runtime'
import { networkTelemetry } from './network-telemetry'
import type { TerminalMetadataManager } from './terminal-metadata'

const EVENT_QUEUE_CAPACITY = 256

export function makeRpcHttpApp(
  service: TreeportService,
  terminalMetadata: TerminalMetadataManager
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
            const started = Date.now()
            const queue = yield* Queue.bounded<{
              item: ProjectEventsItem
              queuedAt: number
            }>(EVENT_QUEUE_CAPACITY)
            const overflow = yield* Deferred.make<never, ProjectEventsFailure>()
            const queuedEvents: NetworkProductEvent[] = []
            let snapshotted = false
            let closeReason: 'stream_closed' | 'slow_client' | 'interrupted' =
              'stream_closed'
            let queuedCount = 0
            const offer = (item: ProjectEventsItem) => {
              const offered = Queue.unsafeOffer(queue, {
                item,
                queuedAt: Date.now()
              })
              if (offered) {
                queuedCount += 1
                networkTelemetry.queueDepthNow('rpc', queuedCount)
              }

              return offered
            }
            const overflowSlowClient = () => {
              closeReason = 'slow_client'
              networkTelemetry.droppedNow('rpc', 'dropped')
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
                networkTelemetry.decodeFailureNow('rpc')
                return
              }

              if (!snapshotted) {
                if (queuedEvents.length < EVENT_QUEUE_CAPACITY) {
                  queuedEvents.push(parsed)
                  networkTelemetry.queueDepthNow('rpc', queuedEvents.length)
                } else {
                  overflowSlowClient()
                }

                return
              }

              if (
                !offer({
                  _tag: 'ProductEvent',
                  event: parsed
                })
              ) {
                overflowSlowClient()
              }
            })
            yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()))
            yield* networkTelemetry.connectionOpened('rpc')
            yield* Effect.addFinalizer((exit) => {
              if (Exit.isInterrupted(exit)) {
                closeReason = 'interrupted'
              }

              return Effect.all([
                ...(Exit.isInterrupted(exit)
                  ? [networkTelemetry.interrupted('rpc')]
                  : []),
                networkTelemetry.queueDepth('rpc', 0),
                networkTelemetry.duration(
                  'rpc',
                  'stream_lifetime',
                  Date.now() - started
                ),
                networkTelemetry.connectionClosed('rpc', closeReason)
              ]).pipe(Effect.asVoid)
            })
            const terminalMetadataSnapshot = terminalMetadata.snapshot()
            const representedEventCount = queuedEvents.length
            const [webPanels, browserPanels] = yield* Effect.all([
              service.panels.listWebPanels(),
              service.panels.listBrowserPanels()
            ]).pipe(
              Effect.mapError(
                (cause): ProjectEventsFailure => ({
                  _tag: 'ProjectEventsFailure',
                  message:
                    cause instanceof Error
                      ? cause.message
                      : 'Panel snapshot failed'
                })
              )
            )
            queuedCount = 0
            networkTelemetry.queueDepthNow('rpc', 0)
            offer({
              _tag: 'Snapshot',
              snapshot: {
                at: new Date().toISOString(),
                terminalMetadata: terminalMetadataSnapshot,
                webPanels,
                browserPanels
              }
            })
            queuedEvents.splice(0, representedEventCount)
            for (const event of queuedEvents) {
              if (
                !offer({
                  _tag: 'ProductEvent',
                  event
                })
              ) {
                overflowSlowClient()
              }
            }
            snapshotted = true
            yield* networkTelemetry.duration(
              'rpc',
              'snapshot_setup',
              Date.now() - started
            )
            const items = Stream.fromQueue(queue).pipe(
              Stream.mapEffect(({ item, queuedAt }) =>
                Effect.gen(function* () {
                  queuedCount = Math.max(0, queuedCount - 1)
                  yield* networkTelemetry.queueDepth('rpc', queuedCount)
                  yield* networkTelemetry.duration(
                    'rpc',
                    'queue_wait',
                    Date.now() - queuedAt
                  )
                  yield* networkTelemetry.message(
                    'rpc',
                    'out',
                    Buffer.byteLength(JSON.stringify(item))
                  )
                  return item
                })
              )
            )
            return Stream.merge(
              items,
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
