# Experimental web-panel vertical slice

Issue #74 is implemented as an intentionally small end-to-end slice.

## Model and lifecycle

`WorktreeRecord.panels` is the ordered discriminated union of terminal panel presentations and durable web panels. Terminals remain tmux-backed domain objects and continue to appear in `terminals`. Web panels are stored in SQLite and publish `panel.created` / `panel.removed`; reconnect event snapshots include all durable web panels. Selection and frame state are client-local.

## Local extension format

Trusted repositories may place no-build extensions at `.treeport/extensions/<directory>/treeport.json`. The implemented manifest shape is:

```json
{
  "id": "example.review",
  "name": "Review",
  "version": "0.1.0",
  "panels": [{ "id": "review", "title": "Review", "entry": "index.html" }]
}
```

Entries and their relative static assets are served by the daemon. Invalid IDs, absolute entries, and entries escaping the extension directory are ignored. This slice discovers extensions from the panel's worktree checkout and serves them to every connected client.

## Runtime boundary

Frames use `sandbox="allow-scripts"` without `allow-same-origin`. Extensions import `/api/web-panel-sdk/v1.js` and call `treeport.context()` or `treeport.diff()`. The host message bridge accepts only messages from that panel's frame and calls panel-ID-scoped daemon endpoints. The extension receives no credential and no general daemon client.

The diff is unified text plus base/head metadata. It compares `HEAD` and tracked local changes to the default branch merge base and appends untracked files as additions. Refresh is explicit.

## Deferred

Global discovery and npm package resolution are not implemented. A package may ultimately ship the same manifest/static directory; package installation, trust settings, and precedence need a focused follow-up. Reordering UI is also deferred, though the daemon supplies deterministic creation order.
