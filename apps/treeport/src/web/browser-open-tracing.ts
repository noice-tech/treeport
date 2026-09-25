import { browserTrace, browserTracingEnabled } from './agent-tracing'

// Opt in with localStorage['treeport.trace'] = 'jsonl'. Renderer correlationId
// matches the HTTP span's treeport.request.id in TREEPORT_TRACE=jsonl output.
// Lifecycle events describe the latest open for a panel, not a navigation ID.
// Only retain recent opens; a failed navigation may never report completion.
const panelOpens = new Map<string, { requestId: string; startedAt: number }>()

export function registerBrowserOpen(panelId: string, requestId: string): void {
  if (!browserTracingEnabled()) {
    return
  }

  panelOpens.delete(panelId)
  panelOpens.set(panelId, { requestId, startedAt: performance.now() })
  if (panelOpens.size > 128) {
    panelOpens.delete(panelOpens.keys().next().value!)
  }
}

export function traceBrowserOpen(
  panelId: string,
  event: string,
  attributes: Record<string, boolean | number | string | null> = {}
): void {
  const open = panelOpens.get(panelId)
  if (!open) {
    return
  }

  if (performance.now() - open.startedAt > 60_000) {
    panelOpens.delete(panelId)
    return
  }

  browserTrace(event, open.requestId, { panelId, ...attributes })
}
