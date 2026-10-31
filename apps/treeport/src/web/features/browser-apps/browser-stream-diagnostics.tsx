import {
  DEFAULT_BROWSER_VIDEO_SETTINGS,
  browserVideoSettingsSchema,
  type BrowserVideoSettings
} from '@treeport/browser-host/video'
import { isSchemaValue } from '#protocol/schema'
import { Input } from '../../components/ui/input'
import { FormField } from '../../components/ui/form-field'
import { Label } from '../../components/ui/label'
import { NativeSelect } from '../../components/ui/native-select'
import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { Button } from '../../components/ui/button'
import type { RemoteBrowserConnection } from '../../browser-remote-connection'

interface StreamSample {
  time: string
  settings: BrowserVideoSettings
  codec: string | null
  decoder: string | null
  resolution: string | null
  fps: number | null
  mbps: number | null
  rttMs: number | null
  jitterMs: number | null
  bufferMs: number | null
  bufferTargetMs: number | null
  decodeMs: number | null
  captureToDisplayMs: number | null
  receiveToDisplayMs: number | null
  packetsLost: number | null
  framesDropped: number | null
  freezes: number | null
}

interface ClickSample {
  totalMs: number
  inputToCaptureMs: number | null
  captureToReceiveMs: number | null
  receiveToDisplayMs: number | null
}

export function BrowserStreamDiagnostics({
  videoRef,
  receiverRef,
  settings,
  canConfigure,
  onConfigure
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  receiverRef: RefObject<RemoteBrowserConnection | null>
  settings: BrowserVideoSettings
  canConfigure: boolean
  onConfigure(settings: BrowserVideoSettings): Promise<void>
}) {
  const [sample, setSample] = useState<StreamSample | null>(null)
  const [probe, setProbe] = useState(false)
  const [clicks, setClicks] = useState<ClickSample[]>([])
  const [status, setStatus] = useState('')
  const history = useRef<StreamSample[]>([])
  const id = useId()
  const [draft, setDraft] = useState<BrowserVideoSettings | null>(null)
  const [applying, setApplying] = useState(false)
  const [settingsStatus, setSettingsStatus] = useState('')
  const selected = draft ?? settings
  const validSettings = isSchemaValue(browserVideoSettingsSchema, selected)
  const { captureScale, frameRate, maxBitrate } = settings

  const apply = async (next: BrowserVideoSettings) => {
    if (!canConfigure || applying) {
      return
    }

    setApplying(true)
    setSettingsStatus('Applying stream settings…')
    await onConfigure(next)
      .then(
        () => {
          setDraft(null)
          setSettingsStatus('Stream settings applied.')
        },
        (error: Error) => {
          setSettingsStatus(error.message)
        }
      )
      .finally(() => setApplying(false))
  }

  useEffect(() => {
    const video = videoRef.current

    if (!video) {
      return
    }

    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let frameId: number | null = null

    let previous: {
      connectionId: string
      inbound: RTCInboundRtpStreamStats
    } | null = null

    let lastCounter: number | null = null
    let nextRead = 0
    let pending: { started: number; counter: number } | null = null
    let ambiguous = false
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 1

    const context = probe
      ? canvas.getContext('2d', { willReadFrequently: true })
      : null

    const counter = () => {
      if (!context || video.readyState < 2 || !video.videoWidth) {
        return null
      }

      context.drawImage(
        video,
        0,
        video.videoHeight * 0.04,
        video.videoWidth,
        1,
        0,
        0,
        32,
        1
      )
      const pixels = context.getImageData(0, 0, 32, 1).data
      let word = 0

      for (let i = 0; i < 32; i++) {
        const luminance =
          (pixels[i * 4]! + pixels[i * 4 + 1]! + pixels[i * 4 + 2]!) / 3

        if (luminance > 70 && luminance < 185) {
          return null
        }

        word = (word << 1) | (luminance >= 185 ? 1 : 0)
      }

      const value = (word >>> 8) & 255

      return word >>> 16 === 0xa69c && (word & 255) === (value ^ 255)
        ? value
        : null
    }

    const input = (event: PointerEvent) => {
      if (!probe || event.button !== 0 || event.pointerType !== 'mouse') {
        return
      }

      const started = performance.now()

      if (pending || ambiguous) {
        pending = null
        ambiguous = true
        setStatus(
          'Ambiguous clicks discarded. Stop and restart test-click measurement, then click once and wait for the result.'
        )

        return
      }

      const value = lastCounter
      pending = value === null ? null : { started, counter: (value + 1) & 255 }
      setStatus(
        value === null
          ? 'No probe marker. Open the dedicated latency test page.'
          : 'Waiting for the changed video frame…'
      )
    }

    const frame = (now: number) => {
      if (disposed) {
        return
      }

      // EXTERNAL: Sparse generated tracks can have expectedDisplayTime far in the future.
      if (!document.hidden && !ambiguous && (pending || now >= nextRead)) {
        const value = counter()
        nextRead = now + 250

        if (!pending) {
          lastCounter = value
        } else if (value === pending.counter) {
          const elapsed = performance.now() - pending.started
          pending = null
          lastCounter = value

          if (elapsed >= 0 && elapsed <= 5_000) {
            setClicks((values) => [
              ...values.slice(-59),
              {
                totalMs: elapsed,
                inputToCaptureMs: null,
                captureToReceiveMs: null,
                receiveToDisplayMs: null
              }
            ])
            setStatus('Matched video frame. Click again for another sample.')
          } else {
            ambiguous = true
            setStatus(
              'Probe timed out. Stop and restart test-click measurement.'
            )
          }
        }
      }

      frameId = requestAnimationFrame(frame)
    }

    const reset = () => {
      previous = null
      pending = null
      ambiguous = false
      lastCounter = null
      nextRead = 0
      setSample(null)
      setClicks([])
      history.current = []
    }

    const visibility = () => {
      if (document.hidden) {
        reset()
      }
    }

    const poll = async () => {
      if (pending && performance.now() - pending.started > 5_000) {
        pending = null
        ambiguous = true
        setStatus('Probe timed out. Stop and restart test-click measurement.')
      }

      const snapshot = document.hidden
        ? null
        : await receiverRef.current?.stats()

      if (disposed) {
        return
      }

      if (!snapshot) {
        reset()
      } else {
        const current: RTCInboundRtpStreamStats | undefined = Array.from(
          snapshot.report.values()
        ).find(
          (entry) =>
            entry.type === 'inbound-rtp' &&
            entry.kind === 'video' &&
            entry.framesDecoded !== undefined
        )

        if (current) {
          if (previous && previous.connectionId !== snapshot.connectionId) {
            reset()
          }

          const old =
            previous?.connectionId === snapshot.connectionId &&
            previous.inbound.id === current.id
              ? previous.inbound
              : null

          const delta = (a: number | undefined, b: number | undefined) =>
            a !== undefined && b !== undefined && a >= b ? a - b : null

          const average = (
            a: number | undefined,
            b: number | undefined,
            count: number | null
          ) => {
            const difference = delta(a, b)

            return difference !== null && count !== null && count > 0
              ? (1000 * difference) / count
              : null
          }

          const elapsed = old ? current.timestamp - old.timestamp : 0
          const frames = delta(current.framesDecoded, old?.framesDecoded)

          const emitted = delta(
            current.jitterBufferEmittedCount,
            old?.jitterBufferEmittedCount
          )

          const bytes = delta(current.bytesReceived, old?.bytesReceived)

          const codec: { mimeType?: string } | undefined = snapshot.report.get(
            current.codecId ?? ''
          )

          const transport: RTCTransportStats | undefined = snapshot.report.get(
            current.transportId ?? ''
          )

          const pair: RTCIceCandidatePairStats | undefined =
            snapshot.report.get(transport?.selectedCandidatePairId ?? '')

          const next: StreamSample = {
            time: new Date().toISOString(),
            settings: { captureScale, frameRate, maxBitrate },
            codec: codec?.mimeType ?? null,
            decoder: current.decoderImplementation ?? null,
            resolution:
              current.frameWidth && current.frameHeight
                ? `${current.frameWidth} × ${current.frameHeight}`
                : null,
            fps:
              elapsed > 0 && frames !== null ? (frames * 1000) / elapsed : null,
            mbps:
              elapsed > 0 && bytes !== null
                ? (bytes * 8) / elapsed / 1000
                : null,
            rttMs:
              pair?.currentRoundTripTime !== undefined
                ? pair.currentRoundTripTime * 1000
                : null,
            jitterMs:
              current.jitter !== undefined ? current.jitter * 1000 : null,
            bufferMs: average(
              current.jitterBufferDelay,
              old?.jitterBufferDelay,
              emitted
            ),
            bufferTargetMs: average(
              current.jitterBufferTargetDelay,
              old?.jitterBufferTargetDelay,
              emitted
            ),
            decodeMs: average(
              current.totalDecodeTime,
              old?.totalDecodeTime,
              frames
            ),
            captureToDisplayMs: null,
            receiveToDisplayMs: null,
            packetsLost: delta(current.packetsLost, old?.packetsLost),
            framesDropped: delta(current.framesDropped, old?.framesDropped),
            freezes: delta(current.freezeCount, old?.freezeCount)
          }

          previous = { connectionId: snapshot.connectionId, inbound: current }
          history.current = [...history.current.slice(-59), next]
          setSample(next)
        }
      }

      timer = setTimeout(() => {
        void poll()
      }, 1_000)
    }

    // eslint-disable-next-line react-you-might-not-need-an-effect/no-adjust-state-on-prop-change, react-you-might-not-need-an-effect/no-external-store-subscription -- This effect owns asynchronous browser instrumentation, not a React external store.
    reset()
    void poll()

    if (probe) {
      frameId = requestAnimationFrame(frame)
    }

    video.addEventListener('pointerdown', input, true)
    video.addEventListener('emptied', reset)
    document.addEventListener('visibilitychange', visibility)

    return () => {
      disposed = true

      if (timer) {
        clearTimeout(timer)
      }

      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }

      video.removeEventListener('pointerdown', input, true)
      video.removeEventListener('emptied', reset)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [probe, receiverRef, videoRef, captureScale, frameRate, maxBitrate])

  const sorted = clicks.map((value) => value.totalMs).sort((a, b) => a - b)

  const metrics = [
    ['ICE RTT', sample?.rttMs, 'ms'],
    ['Network jitter', sample?.jitterMs, 'ms'],
    ['Receiver buffer', sample?.bufferMs, 'ms'],
    ['Buffer target', sample?.bufferTargetMs, 'ms'],
    ['Decode', sample?.decodeMs, 'ms'],
    ['Decoded rate', sample?.fps, 'fps'],
    ['Video payload', sample?.mbps, 'Mbps']
  ] as const

  return (
    <section
      aria-label="Stream diagnostics"
      className="absolute right-2 bottom-2 flex max-h-[75%] w-[min(22rem,calc(100%-1rem))] flex-col gap-2 overflow-auto rounded-md border border-sidebar-border bg-sidebar p-3 text-xs text-sidebar-foreground shadow-lg"
    >
      <strong>Stream diagnostics</strong>
      <fieldset
        disabled={!canConfigure || applying}
        className="flex flex-col gap-2"
      >
        <legend>Stream settings</legend>
        <FormField>
          <Label htmlFor={id + '-scale'}>Capture scale</Label>
          <NativeSelect
            id={id + '-scale'}
            value={selected.captureScale}
            onChange={(event) =>
              setDraft({
                ...selected,
                captureScale: Number(event.target.value)
              })
            }
          >
            {[50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100].map((scale) => (
              <option key={scale} value={scale / 100}>
                {scale}%
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField>
          <Label htmlFor={id + '-fps'}>FPS cap</Label>
          <Input
            id={id + '-fps'}
            type="number"
            min={1}
            max={60}
            step={1}
            value={selected.frameRate || ''}
            aria-invalid={
              !isSchemaValue(
                browserVideoSettingsSchema.fields.frameRate,
                selected.frameRate
              )
            }
            onChange={(event) =>
              setDraft({ ...selected, frameRate: Number(event.target.value) })
            }
          />
        </FormField>
        <FormField>
          <Label htmlFor={id + '-bitrate'}>Bitrate ceiling (Mbps)</Label>
          <Input
            id={id + '-bitrate'}
            type="number"
            min={0.25}
            max={48}
            step="any"
            value={selected.maxBitrate ? selected.maxBitrate / 1_000_000 : ''}
            aria-invalid={
              !isSchemaValue(
                browserVideoSettingsSchema.fields.maxBitrate,
                selected.maxBitrate
              )
            }
            onChange={(event) =>
              setDraft({
                ...selected,
                maxBitrate: Math.round(Number(event.target.value) * 1_000_000)
              })
            }
          />
        </FormField>
        <p>FPS: 1–60 (whole numbers). Bitrate: 0.25–48 Mbps.</p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!validSettings}
            onClick={() => void apply(selected)}
          >
            {applying ? 'Applying…' : 'Apply'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void apply(DEFAULT_BROWSER_VIDEO_SETTINGS)}
          >
            Reset to baseline
          </Button>
        </div>
      </fieldset>
      <p>
        Applied: {Math.round(captureScale * 100)}% · {frameRate} FPS cap ·{' '}
        {maxBitrate / 1_000_000} Mbps ceiling.
      </p>
      <p>
        Session only; affects all viewers of this browser. Scale and FPS changes
        may briefly interrupt video, but do not change page layout or input
        coordinates.
        {!canConfigure ? ' Take control to change settings.' : ''}
      </p>
      {settingsStatus ? <p role="status">{settingsStatus}</p> : null}
      <strong>Actual stream</strong>
      <span>
        {sample?.codec ?? 'Waiting for media'} · {sample?.resolution ?? '—'} ·{' '}
        {sample?.decoder ?? 'decoder unknown'}
      </span>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
        {metrics.map(([label, value, unit]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="text-right">
              {value == null ? '—' : `${value.toFixed(1)} ${unit}`}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-sidebar-foreground/70">
        One-second samples. Buffering and decoding intervals overlap and should
        not be added.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-pressed={probe}
        onClick={() => {
          setStatus('')
          setProbe(!probe)
        }}
      >
        {probe ? 'Stop measuring test clicks' : 'Measure test clicks'}
      </Button>
      {probe ? (
        <>
          <p>
            On the latency test page, use one controlling viewer and click once
            per second. Input → video:{' '}
            <strong>
              {clicks.length ? `${clicks.at(-1)!.totalMs.toFixed(0)} ms` : '—'}
            </strong>
          </p>
          <p>
            {clicks.length} samples · median{' '}
            {sorted.length
              ? sorted[Math.floor(sorted.length / 2)]!.toFixed(0)
              : '—'}{' '}
            ms · p95{' '}
            {sorted.length
              ? sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(0)
              : '—'}{' '}
            ms
          </p>
          <p className="text-sidebar-foreground/70">
            Viewer pointer event to first observed changed video pixels.
            Includes sampling and scheduling delay, not physical display
            scanout. No cross-device clock subtraction.
          </p>
        </>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard
            .writeText(
              JSON.stringify(
                {
                  settings,
                  samples: history.current,
                  inputToVideoMs: clicks.map((value) => value.totalMs),
                  matchedFrameTimings: clicks,
                  inputTiming:
                    'viewer-pointerdown-to-first-observed-video-pixels',
                  captureTiming: 'unavailable'
                },
                null,
                2
              )
            )
            .then(() => setStatus('Report copied.'))
            .catch(() => setStatus('Clipboard permission denied.'))
        }}
      >
        Copy timing report
      </Button>
      {status ? <p role="status">{status}</p> : null}
    </section>
  )
}
