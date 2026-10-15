import type { BrowserFrame } from '@treeport/shared'
import { networkTelemetry } from './network-telemetry'

const FRAME_INTERVAL_MS = 1_000 / 60
const MAX_IN_FLIGHT_FRAMES = 8
const MAX_IN_FLIGHT_BYTES = 1024 * 1024
const MAX_QUEUE_DELAY_MS = 100

// JPEGs have no reference-frame dependencies. Pipeline enough images to cover
// the measured ACK round trip, but keep only the newest unsent image. Unlike a
// larger socket queue, this lets us discard stale work before it reaches TCP.
export class BrowserJpegDelivery {
  private readonly inFlight = new Map<
    number,
    { sentAt: number; bytes: number }
  >()
  private inFlightBytes = 0
  private pending: BrowserFrame | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastSentAt = -Infinity
  private minimumAckMs: number | null = null
  private lastAckAt: number | null = null
  private queuedDelaySamples = 0
  private frameCredit = 2
  private frameIntervalMs = FRAME_INTERVAL_MS

  constructor(private readonly send: (frame: BrowserFrame) => boolean) {}

  offer(frame: BrowserFrame): void {
    if (this.pending) {
      networkTelemetry.droppedNow('browsers', 'coalesced')
    }

    this.pending = frame
    this.flush()
  }

  acknowledge(sequence: number): boolean {
    const sent = this.inFlight.get(sequence)
    if (!sent) {
      return false
    }

    this.inFlight.delete(sequence)
    this.inFlightBytes -= sent.bytes
    const now = performance.now()
    const elapsed = now - sent.sentAt
    networkTelemetry.durationNow('browsers', 'ack_lag', elapsed)
    // Use the minimum rather than an average: congestion must not make us
    // grow the window and enqueue still more bytes on an already slow link.
    this.minimumAckMs = Math.min(this.minimumAckMs ?? elapsed, elapsed)
    if (this.lastAckAt !== null && sent.sentAt <= this.lastAckAt) {
      // Do not expand credit while the initial two-frame flight is already
      // queueing. A large frame's serialization time is part of the ACK RTT,
      // not evidence that the link can sustain a larger pipeline.
      if (elapsed <= this.minimumAckMs + FRAME_INTERVAL_MS / 2) {
        this.frameCredit = Math.min(MAX_IN_FLIGHT_FRAMES, this.frameCredit + 1)
      }

      // An isolated delayed ACK can be jitter or a viewer scheduling pause.
      // Require consecutive deliveries with excess delay before treating ACK
      // spacing as a throughput limit, including a persistent (not growing)
      // queue. A catch-up ACK breaks the streak.
      this.queuedDelaySamples =
        this.inFlight.size > 0 &&
        elapsed > this.minimumAckMs + FRAME_INTERVAL_MS
          ? this.queuedDelaySamples + 1
          : 0
      if (this.queuedDelaySamples >= 2) {
        this.frameIntervalMs = Math.min(
          1_000,
          Math.max(this.frameIntervalMs, now - this.lastAckAt) * 1.05
        )
        this.queuedDelaySamples = 0
      }
    } else {
      this.queuedDelaySamples = 0
    }

    // Once pacing exceeds the ACK round trip, samples no longer overlap.
    // Recovery must still run or a transient stall permanently lowers FPS.
    // An empty flight also proves that this viewer has caught up, even when
    // a larger JPEG takes longer than the minimum measured on an idle page.
    if (
      this.inFlight.size === 0 ||
      elapsed <= this.minimumAckMs + FRAME_INTERVAL_MS / 2
    ) {
      this.frameIntervalMs = Math.max(
        FRAME_INTERVAL_MS,
        this.frameIntervalMs * (this.inFlight.size === 0 ? 0.9 : 0.98)
      )
    }

    this.lastAckAt = now
    this.flush()
    return true
  }

  private flush(): void {
    const frame = this.pending
    if (!frame || this.timer) {
      return
    }

    const now = performance.now()
    const window = Math.min(
      this.frameCredit,
      Math.max(
        2,
        Math.ceil((this.minimumAckMs ?? 0) / this.frameIntervalMs) + 1
      )
    )
    const oldest = this.inFlight.values().next().value
    if (
      this.inFlight.size >= window ||
      (oldest &&
        (this.inFlightBytes + frame.data.byteLength > MAX_IN_FLIGHT_BYTES ||
          now - oldest.sentAt > (this.minimumAckMs ?? 0) + MAX_QUEUE_DELAY_MS))
    ) {
      // Resume on an ACK, not a polling timer. A frame larger than the byte
      // budget is allowed only when it is the sole image in flight.
      return
    }

    const delay = this.frameIntervalMs - (now - this.lastSentAt)
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, Math.ceil(delay))
      this.timer.unref()
      return
    }

    this.pending = null
    if (this.send(frame)) {
      this.lastSentAt = now
      this.inFlight.set(frame.sequence, {
        sentAt: now,
        bytes: frame.data.byteLength
      })
      this.inFlightBytes += frame.data.byteLength
    }
  }

  reset(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    this.pending = null
    this.inFlight.clear()
    this.inFlightBytes = 0
    this.lastSentAt = -Infinity
    this.minimumAckMs = null
    this.lastAckAt = null
    this.queuedDelaySamples = 0
    this.frameCredit = 2
    this.frameIntervalMs = FRAME_INTERVAL_MS
  }
}
