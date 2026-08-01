# Experimental web-panel vertical slice

Issue #74 is implemented as an intentionally small end-to-end slice.

## Model and lifecycle

`WorktreeRecord.panels` is the ordered discriminated union of terminal panel presentations and durable web panels. Terminals remain tmux-backed domain objects and continue to appear in `terminals`. Web panels are stored in SQLite and publish `panel.created` / `panel.removed`; reconnect event snapshots include all durable web panels. Selection and frame state are client-local.

## Local extension format

Trusted repositories may place no-build extensions at `.treeport/extensions/<directory>/`. Each direct child directory containing `index.html` contributes one web panel. The directory name is used as the extension and contribution identity and is humanized for the panel title; local extensions need no manifest.

The fixed entry and its relative static assets are served by the daemon. Absolute paths, traversal, and symlinks escaping the extension directory are rejected. This slice discovers extensions from the panel's worktree checkout and serves them to every connected client. Existing experimental panel rows created with manifest-provided IDs may become unavailable after this convention change; they remain closable and can be recreated from the launcher.

## Runtime boundary

Frames use `sandbox="allow-scripts"` without `allow-same-origin`. Extensions import `/api/web-panel-sdk/v1.js` and call `treeport.context()` or `treeport.diff()`. The host message bridge accepts only messages from that panel's frame and calls panel-ID-scoped daemon endpoints. The extension receives no credential and no general daemon client.

The diff is unified text plus base/head metadata. It compares `HEAD` and tracked local changes to the default branch merge base and appends untracked files as additions. Refresh is explicit.

## Deferred

Global discovery and npm package resolution are not implemented. npm extensions will use their required `package.json` for package identity and may eventually contribute terminal presets, while their web entry remains `index.html`. Package installation, contribution metadata, trust settings, and precedence need a focused follow-up. Reordering UI is also deferred, though the daemon supplies deterministic creation order.
