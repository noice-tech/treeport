const terminalCorrelations = new Map<string, string>()
const session = crypto.randomUUID()

let pending: {
  timestamp: string
  monotonicMs: number
  event: string
  correlationId: string
  attributes: Record<string, boolean | number | string | null>
}[] = []

let flushTimer: ReturnType<typeof setTimeout> | null = null

export function browserTracingEnabled(): boolean {
  return globalThis.localStorage?.getItem('treeport.trace') !== 'off'
}

function flushBrowserTraces(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  if (!pending.length) {
    return
  }

  const events = pending
  pending = []

  void fetch('/api/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, events }),
    keepalive: true
  }).catch(() => undefined)
}

globalThis.addEventListener?.('pagehide', flushBrowserTraces)

export function newBrowserCorrelationId(): string {
  return crypto.randomUUID()
}

export function registerTerminalCorrelation(
  terminalId: string,
  correlationId: string
): void {
  if (browserTracingEnabled()) {
    terminalCorrelations.set(terminalId, correlationId)
  }
}

export function forgetTerminalCorrelation(terminalId: string): void {
  terminalCorrelations.delete(terminalId)
}

export function terminalCorrelation(terminalId: string): string | null {
  return terminalCorrelations.get(terminalId) ?? null
}

export function browserTrace(
  event: string,
  correlationId: string,
  attributes: Record<string, boolean | number | string | null> = {}
): void {
  if (!browserTracingEnabled()) {
    return
  }

  const truncated: Record<string, boolean | number | string | null> = {}

  for (const [name, value] of Object.entries(attributes)) {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- Attribute values are a typed primitive union.
    truncated[name] = typeof value === 'string' ? value.slice(0, 512) : value
  }

  pending.push({
    timestamp: new Date().toISOString(),
    monotonicMs: performance.now(),
    event,
    correlationId,
    attributes: truncated
  })

  if (pending.length >= 100) {
    flushBrowserTraces()
  } else {
    flushTimer ??= setTimeout(flushBrowserTraces, 1_000)
  }
}
