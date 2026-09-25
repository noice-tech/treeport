import fs from 'node:fs/promises'
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
import * as Runtime from 'effect/Runtime'
import * as Tracer from 'effect/Tracer'

export interface TreeportTraceContext {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}

export type TreeportSpanAttributes = ReadableSpan['attributes']

interface TraceDestination {
  readonly filePath: string | null
  readonly rotate?: boolean
}

interface TracingOptions {
  readonly serviceName:
    | 'treeport'
    | 'treeport-terminal-host'
    | 'treeport-desktop'
  readonly serviceVersion: string
  readonly destination: TraceDestination | null
}

const SAFE_ATTRIBUTE_NAMES = new Set([
  'http.request.method',
  'http.response.status_code',
  'network.protocol',
  'url.path',
  'treeport.browser.panel_reused',
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
  'treeport.worktree.id',
  'treeport.web_panel.reused',
  'treeport.web_panel.development',
  'treeport.web_panel.build_pending',
  'treeport.web_panel.resolution'
])

function tracingDestination(
  serviceName: TracingOptions['serviceName'],
  environment: NodeJS.ProcessEnv = process.env
): TraceDestination | null {
  if (environment.TREEPORT_TRACE !== 'jsonl') {
    return null
  }

  const configuredPath = environment.TREEPORT_TRACE_FILE?.trim()
  if (configuredPath && !path.isAbsolute(configuredPath)) {
    throw new Error('TREEPORT_TRACE_FILE must be an absolute path')
  }

  const directory = environment.TREEPORT_TRACE_DIR?.trim()
  if (directory && !path.isAbsolute(directory)) {
    throw new Error('TREEPORT_TRACE_DIR must be an absolute path')
  }

  return {
    filePath:
      configuredPath ||
      (directory ? path.join(directory, `${serviceName}.jsonl`) : null),
    rotate: !configuredPath && !!directory
  }
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
  private descriptor: fs.FileHandle | null = null
  private closed = false
  private pending = Promise.resolve()
  private bytes = 0
  private readonly session = `${new Date().toISOString()}-${process.pid}`

  constructor(
    private readonly serviceName: string,
    private readonly destination: TraceDestination
  ) {}

  export(
    spans: ReadableSpan[],
    resultCallback: Parameters<SpanExporter['export']>[1]
  ) {
    if (this.closed) {
      resultCallback({ code: 1 })
      return
    }

    const write = async () => {
      const lines: string[] = []
      for (const span of spans) {
        const context = span.spanContext()
        const record = {
          type: 'treeport.trace.span',
          timestamp: new Date(hrTimeMilliseconds(span.startTime)).toISOString(),
          service: this.serviceName,
          pid: process.pid,
          session: this.session,
          traceId: context.traceId,
          spanId: context.spanId,
          parentSpanId: span.parentSpanContext?.spanId ?? null,
          name: span.name,
          kind: span.kind,
          durationMs: Number(hrTimeMilliseconds(span.duration).toFixed(3)),
          status: span.status.code,
          attributes: safeAttributes(span.attributes)
        }
        lines.push(`${JSON.stringify(record)}\n`)
      }
      const data = lines.join('')
      const filePath = this.destination.filePath
      if (!filePath) {
        process.stderr.write(data)
        return
      }

      if (!this.descriptor) {
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
        this.descriptor = await fs.open(filePath, 'a', 0o600)
        await this.descriptor.chmod(0o600)
        this.bytes = (await this.descriptor.stat()).size
      }

      // Development owns one writer per service. Keep two backups across
      // restarts; never rotate a caller's explicit TREEPORT_TRACE_FILE.
      if (
        this.destination.rotate &&
        this.bytes + Buffer.byteLength(data) > 10 * 1024 * 1024
      ) {
        await this.descriptor.close()
        this.descriptor = null
        await fs.rm(`${filePath}.2`, { force: true })
        await fs
          .rename(`${filePath}.1`, `${filePath}.2`)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') {
              throw error
            }
          })
        await fs.rename(filePath, `${filePath}.1`)
        this.descriptor = await fs.open(filePath, 'a', 0o600)
        this.bytes = 0
      }

      await this.descriptor.writeFile(data)
      this.bytes += Buffer.byteLength(data)
    }
    this.pending = this.pending.then(write).then(
      () => resultCallback({ code: 0 }),
      // eslint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection boundary; normalize before passing to OpenTelemetry.
      (error: unknown) =>
        resultCallback({
          code: 1,
          error: error instanceof Error ? error : new Error(String(error))
        })
    )
  }

  async forceFlush(): Promise<void> {
    await this.pending
    await this.descriptor?.sync()
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true
    await this.forceFlush()
    await this.descriptor?.close()
    this.descriptor = null
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
    destination: tracingDestination(serviceName, environment)
  })
}

function tracingEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.TREEPORT_TRACE === 'jsonl'
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

export type PromiseSpan = <A>(
  name: string,
  evaluate: () => Promise<A>,
  attributes?: TreeportSpanAttributes
) => Promise<A>

export const untracedPromiseSpan: PromiseSpan = (_name, evaluate) => evaluate()

// Preserve the request's tracer and parent across the Promise-based Vite boundary.
// Re-throw the original error so runtime diagnostics and DomainError handling stay intact.
export const currentPromiseSpan = Effect.gen(function* () {
  if (!tracingEnabled()) {
    return untracedPromiseSpan
  }

  const runtime = yield* Effect.runtime<never>()
  const parent = yield* Effect.option(Effect.currentSpan)
  const run: PromiseSpan = async (name, evaluate, attributes = {}) => {
    const exit = await Runtime.runPromiseExit(runtime)(
      Effect.tryPromise({ try: evaluate, catch: (cause) => ({ cause }) }).pipe(
        Effect.withSpan(name, {
          parent: Option.getOrUndefined(parent),
          attributes
        })
      )
    )
    if (Exit.isSuccess(exit)) {
      return exit.value
    }

    const failure = Cause.failureOption(exit.cause)
    throw Option.isSome(failure)
      ? failure.value.cause
      : Cause.squash(exit.cause)
  }
  return run
})

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
