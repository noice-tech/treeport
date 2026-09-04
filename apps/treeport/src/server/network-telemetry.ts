import * as Effect from 'effect/Effect'
import * as Metric from 'effect/Metric'
import * as MetricBoundaries from 'effect/MetricBoundaries'

const activeConnections = Metric.gauge('treeport_network_active_connections', {
  description: 'Current network connections'
})
const messages = Metric.counter('treeport_network_messages_total', {
  description: 'Network messages'
})
const bytes = Metric.counter('treeport_network_bytes_total', {
  description: 'Network payload bytes'
})
const decodeFailures = Metric.counter('treeport_network_decode_failures_total')
const reconnects = Metric.counter('treeport_network_reconnects_total')
const closes = Metric.counter('treeport_network_closes_total')
const dropped = Metric.counter('treeport_network_dropped_total')
const interruptions = Metric.counter('treeport_network_interruptions_total')
const queueDepth = Metric.histogram(
  'treeport_network_queue_depth',
  MetricBoundaries.linear({ start: 0, width: 8, count: 65 })
)
const duration = Metric.histogram(
  'treeport_network_duration_ms',
  MetricBoundaries.exponential({ start: 1, factor: 2, count: 16 })
)
const watermarkBytes = Metric.histogram(
  'treeport_network_watermark_bytes',
  MetricBoundaries.exponential({ start: 1, factor: 2, count: 24 })
)

type NetworkCloseReason =
  | 'failed'
  | 'interrupted'
  | 'normal'
  | 'peer_closed'
  | 'request_complete'
  | 'slow_client'
  | 'stream_closed'

const channelMetric = <Type, In, Out>(
  metric: Metric.Metric<Type, In, Out>,
  channel: string
) => Metric.tagged(metric, 'channel', channel)

export const networkTelemetry = {
  connectionOpened: (channel: string) =>
    Metric.increment(channelMetric(activeConnections, channel)),
  connectionClosed: (
    channel: string,
    reason: NetworkCloseReason,
    details?: { closeCode?: number; wireReason?: string }
  ) =>
    Effect.all([
      Metric.incrementBy(channelMetric(activeConnections, channel), -1),
      Metric.increment(
        Metric.tagged(channelMetric(closes, channel), 'reason', reason)
      ),
      Effect.logDebug('Network connection closed').pipe(
        Effect.annotateLogs({
          channel,
          closeReason: reason,
          closeCode: details?.closeCode ?? null,
          wireReason: details?.wireReason ?? null
        })
      )
    ]).pipe(Effect.asVoid),
  message: (channel: string, direction: 'in' | 'out', byteLength: number) =>
    Effect.all([
      Metric.increment(
        Metric.tagged(channelMetric(messages, channel), 'direction', direction)
      ),
      Metric.incrementBy(
        Metric.tagged(channelMetric(bytes, channel), 'direction', direction),
        byteLength
      )
    ]).pipe(Effect.asVoid),
  decodeFailure: (channel: string) =>
    Metric.increment(channelMetric(decodeFailures, channel)),
  decodeFailureNow: (channel: string) =>
    channelMetric(decodeFailures, channel).unsafeUpdate(1, []),
  reconnect: (channel: string) =>
    Metric.increment(channelMetric(reconnects, channel)),
  reconnectNow: (channel: string) =>
    channelMetric(reconnects, channel).unsafeUpdate(1, []),
  dropped: (channel: string, kind: 'dropped' | 'coalesced') =>
    Metric.increment(
      Metric.tagged(channelMetric(dropped, channel), 'kind', kind)
    ),
  droppedNow: (channel: string, kind: 'dropped' | 'coalesced') =>
    Metric.tagged(channelMetric(dropped, channel), 'kind', kind).unsafeUpdate(
      1,
      []
    ),
  interrupted: (channel: string) =>
    Metric.increment(channelMetric(interruptions, channel)),
  queueDepth: (channel: string, value: number) =>
    Metric.update(channelMetric(queueDepth, channel), value),
  queueDepthNow: (channel: string, value: number) =>
    channelMetric(queueDepth, channel).unsafeUpdate(value, []),
  duration: (channel: string, operation: string, milliseconds: number) =>
    Metric.update(
      Metric.tagged(channelMetric(duration, channel), 'operation', operation),
      milliseconds
    ),
  durationNow: (channel: string, operation: string, milliseconds: number) =>
    Metric.tagged(
      channelMetric(duration, channel),
      'operation',
      operation
    ).unsafeUpdate(milliseconds, []),
  watermarkBytesNow: (
    channel: string,
    kind: 'unacknowledged_output' | 'queued_input' | 'pending_output',
    bytes: number
  ) =>
    Metric.tagged(
      channelMetric(watermarkBytes, channel),
      'kind',
      kind
    ).unsafeUpdate(bytes, [])
}
