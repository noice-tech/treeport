import {
  browserTrace,
  browserTracingEnabled,
  newBrowserCorrelationId
} from './agent-tracing'

// Request IDs join renderer milestones to treeport.request.id in server JSONL.
// Asset spans carry treeport.panel.id. Never record launch input, file paths, or URLs.
// Bound retention because failed requests/navigation may never finish.
const requests = new Map<string, number>()
const panels = new Map<string, { requestId: string; startedAt: number }>()

export function beginWebPanelOpen(): string {
  const requestId = newBrowserCorrelationId()
  if (browserTracingEnabled()) {
    requests.set(requestId, performance.now())
    if (requests.size > 128) {
      requests.delete(requests.keys().next().value!)
    }

    browserTrace('web_panel.open.requested', requestId)
  }

  return requestId
}

export function registerWebPanelOpen(panelId: string, requestId: string): void {
  if (
    !browserTracingEnabled() ||
    panels.get(panelId)?.requestId === requestId
  ) {
    return
  }

  const startedAt = requests.get(requestId) ?? performance.now()
  panels.delete(panelId)
  panels.set(panelId, { requestId, startedAt })
  if (panels.size > 128) {
    panels.delete(panels.keys().next().value!)
  }
}

export function traceWebPanelOpen(
  panelId: string,
  event: string,
  attributes: Record<string, boolean | number | string | null> = {}
): void {
  const open = panels.get(panelId)
  if (!open) {
    return
  }

  const elapsedMs = performance.now() - open.startedAt
  if (elapsedMs > 60_000) {
    panels.delete(panelId)
    requests.delete(open.requestId)
    return
  }

  browserTrace(event, open.requestId, { panelId, elapsedMs, ...attributes })
}
