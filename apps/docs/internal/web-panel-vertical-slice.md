# Experimental web-panel vertical slice

Issue #74 is implemented as an intentionally small end-to-end slice.

## Model and lifecycle

`WorktreeRecord.panels` is the ordered discriminated union of terminal panel presentations and durable web panels. Terminals remain tmux-backed domain objects and continue to appear in `terminals`. Web panels are stored in SQLite and publish `panel.created` / `panel.removed`; reconnect event snapshots include all durable web panels. Selection and frame state are client-local.

## Project-local web-panel format

Trusted repositories may place no-build web panels at `.treeport/web-panels/<directory>/`. Each direct child directory containing `index.html` defines one project-local web-panel resource. Its stable definition ID is the `project:` prefix plus the encoded directory name, and the directory name is humanized for the title; project-local panels need no manifest. Definitions expose their project provenance separately from their identity. Panel source is browser-native HTML, CSS, and JavaScript; optional npm libraries may be loaded from pinned browser ESM URLs.

The fixed entry and its relative static assets are served by the daemon. Absolute paths, traversal, and symlinks escaping the web-panel directory are rejected. This slice discovers definitions from the panel's worktree checkout and serves them to every connected client. A durable web panel stores the definition ID from which it was created, allowing the daemon to resolve its assets after restart.

## Runtime boundary

Frames use `sandbox="allow-scripts"` without `allow-same-origin`. Web panels explicitly map `@treeport/panel-sdk` to `/api/web-panel-sdk.js` in their HTML import map, then call `treeport.context()`, `treeport.diff()`, or the panel-scoped `treeport.storage` JSON key-value API. Treeport serves panel HTML unchanged. The published SDK package supplies the same-version TypeScript declarations while the daemon serves its browser runtime. The host message bridge accepts only messages from that panel's frame and calls panel-ID-scoped daemon endpoints. The panel receives no credential and no general daemon client. Storage survives navigation and daemon restarts, has bounded key/value/panel quotas, and cascades away with its panel instance. Before deleting a panel with stored data, clients preflight its storage status and require explicit confirmation; the daemon also rejects unconfirmed deletion so a preflight race cannot discard newly saved data.

The diff is unified text plus base/head metadata. It compares `HEAD` and tracked local changes to the default branch merge base and appends untracked files as additions. Refresh is explicit.

## Deferred

Global discovery and package resolution are not implemented. A future Treeport package may provide web-panel definitions through the same definition and source-provenance boundary used for project-local panels. Package installation, trust settings, and precedence need a focused follow-up. Reordering UI is also deferred, though the daemon supplies deterministic creation order.
