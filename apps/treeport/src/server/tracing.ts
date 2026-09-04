import fs from 'node:fs'
import path from 'node:path'
import { NodeSdk } from '@effect/opentelemetry'
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter
} from '@opentelemetry/sdk-trace-base'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Tracer from 'effect/Tracer'

export interface TreeportTraceContext {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}

export type TreeportSpanAttributes = ReadableSpan['attributes']

interface TraceDestination {
  readonly filePath: string | null
}

interface TracingOptions {
  readonly serviceName: 'treeport' | 'treeport-terminal-host'
  readonly serviceVersion: string
  readonly destination: TraceDestination | null
}

const SAFE_ATTRIBUTE_NAMES = new Set([
  'http.request.method',
  'http.response.status_code',
  'network.protocol',
  'url.path',
  'treeport.channel',
  'treeport.client.id',
  'treeport.connection.id',
  'treeport.mutation.coordinator',
  'treeport.mutation.queue_wait_ms',
  'treeport.mutation.queued_ahead',
  'treeport.panel.id',
  'treeport.request.id',
  'treeport.terminal.id',
  'treeport.terminal.launch_kind',
  'treeport.terminal.pending_output_bytes',
  'treeport.terminal.snapshot_bytes',
  'treeport.terminal_host.method',
  'treeport.terminal_host.queue_wait_ms',
  'treeport.worktree.id'
])

function tracingDestination(
  environment: NodeJS.ProcessEnv = process.env
): TraceDestination | null {
  if (environment.TREEPORT_TRACE !== 'jsonl') {
    return null
  }

  const configuredPath = environment.TREEPORT_TRACE_FILE?.trim()
  if (configuredPath && !path.isAbsolute(configuredPath)) {
    throw new Error('TREEPORT_TRACE_FILE must be an absolute path')
  }

  return { filePath: configuredPath || null }
}

function safeAttributes(attributes: TreeportSpanAttributes) {
  const result: TreeportSpanAttributes = {}
  for (const [name, value] of Object.entries(attributes)) {
    if (!SAFE_ATTRIBUTE_NAMES.has(name)) {
      continue
    }

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- OpenTelemetry supplies a validated AttributeValue union at this SDK boundary.
    if (typeof value === 'string') {
      result[name] = value.slice(0, 512)
    } else if (
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- OpenTelemetry supplies a validated AttributeValue union at this SDK boundary.
      typeof value === 'number' ||
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- OpenTelemetry supplies a validated AttributeValue union at this SDK boundary.
      typeof value === 'boolean'
    ) {
      result[name] = value
    }
  }
  return result
}

function hrTimeMilliseconds(value: readonly [number, number]): number {
  return value[0] * 1_000 + value[1] / 1_000_000
}

class JsonLinesSpanExporter implements SpanExporter {
  private readonly descriptor: number | null
  private closed = false

  constructor(
    private readonly serviceName: string,
    destination: TraceDestination
  ) {
    if (destination.filePath) {
      fs.mkdirSync(path.dirname(destination.filePath), {
        recursive: true,
        mode: 0o700
      })
      this.descriptor = fs.openSync(destination.filePath, 'a', 0o600)
      fs.chmodSync(destination.filePath, 0o600)
    } else {
      this.descriptor = null
    }
  }

  export(
    spans: ReadableSpan[],
    resultCallback: Parameters<SpanExporter['export']>[1]
  ) {
    if (this.closed) {
      resultCallback({ code: 1 })
      return
    }

    try {
      for (const span of spans) {
        const context = span.spanContext()
        const record = {
          type: 'treeport.trace.span',
          timestamp: new Date(hrTimeMilliseconds(span.startTime)).toISOString(),
          service: this.serviceName,
          traceId: context.traceId,
          spanId: context.spanId,
          parentSpanId: span.parentSpanContext?.spanId ?? null,
          name: span.name,
          kind: span.kind,
          durationMs: Number(hrTimeMilliseconds(span.duration).toFixed(3)),
          status: span.status.code,
          attributes: safeAttributes(span.attributes)
        }
        const line = `${JSON.stringify(record)}\n`
        if (this.descriptor === null) {
          process.stderr.write(line)
        } else {
          fs.writeSync(this.descriptor, line)
        }
      }
      resultCallback({ code: 0 })
    } catch (error) {
      resultCallback({
        code: 1,
        error: error instanceof Error ? error : new Error(String(error))
      })
    }
  }

  async forceFlush(): Promise<void> {
    if (this.descriptor !== null && !this.closed) {
      fs.fsyncSync(this.descriptor)
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return
    }

    await this.forceFlush()
    this.closed = true
    if (this.descriptor !== null) {
      fs.closeSync(this.descriptor)
    }
  }
}

export function makeTracingLayer(options: TracingOptions) {
  if (!options.destination) {
    return Layer.empty
  }

  const exporter = new JsonLinesSpanExporter(
    options.serviceName,
    options.destination
  )
  return NodeSdk.layer(() => ({
    resource: {
      serviceName: options.serviceName,
      serviceVersion: options.serviceVersion
    },
    spanProcessor: new BatchSpanProcessor(exporter, {
      maxQueueSize: 2_048,
      maxExportBatchSize: 256,
      scheduledDelayMillis: 250
    }),
    shutdownTimeout: '5 seconds'
  }))
}

export function tracingLayerFromEnvironment(
  serviceName: TracingOptions['serviceName'],
  serviceVersion: string,
  environment: NodeJS.ProcessEnv = process.env
) {
  return makeTracingLayer({
    serviceName,
    serviceVersion,
    destination: tracingDestination(environment)
  })
}

function tracingEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return tracingDestination(environment) !== null
}

export const currentTraceContext: Effect.Effect<
  TreeportTraceContext | null,
  never
> = tracingEnabled()
  ? Effect.option(Effect.currentSpan).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            sampled: span.sampled
          })
        })
      )
    )
  : Effect.succeed(null)

export function makeHostTraceRuntime(serviceVersion: string) {
  if (!tracingEnabled()) {
    return null
  }

  const runtime = ManagedRuntime.make(
    tracingLayerFromEnvironment('treeport-terminal-host', serviceVersion)
  )
  return {
    async run<A>(
      name: string,
      parent: TreeportTraceContext,
      attributes: TreeportSpanAttributes,
      evaluate: () => Promise<A>
    ): Promise<A> {
      const exit = await runtime.runPromiseExit(
        Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(
          Effect.withSpan(name, {
            parent: Tracer.externalSpan({
              traceId: parent.traceId,
              spanId: parent.spanId,
              sampled: parent.sampled
            }),
            attributes
          })
        )
      )
      if (Exit.isSuccess(exit)) {
        return exit.value
      }

      const failure = Cause.failureOption(exit.cause)
      if (Option.isSome(failure)) {
        throw failure.value
      }

      throw Cause.squash(exit.cause)
    },
    dispose(): Promise<void> {
      return runtime.dispose()
    }
  }
}
