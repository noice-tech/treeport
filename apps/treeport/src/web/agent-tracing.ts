const terminalCorrelations = new Map<string, string>()

function browserTracingEnabled(): boolean {
  return globalThis.localStorage?.getItem('treeport.trace') === 'jsonl'
}

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

  console.info(
    JSON.stringify({
      type: 'treeport.browser.trace',
      timestamp: new Date().toISOString(),
      event,
      correlationId,
      attributes
    })
  )
}
