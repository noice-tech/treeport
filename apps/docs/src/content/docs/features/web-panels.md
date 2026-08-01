---
title: Web panels (experimental)
description: Run repository-provided, worktree-scoped web tools inside Treeport.
---

Treeport has an experimental web-panel runtime for trusted repository extensions. A web panel is persistent and worktree-bound: opening or closing it is synchronized across connected Treeport clients, while the selected panel remains local to each device.

Repository extensions live under `.treeport/extensions/<name>/` and contain a `treeport.json` manifest plus ordinary HTML, CSS, and browser JavaScript modules. Treeport serves those files from the daemon and runs the panel in an isolated frame, so remote browsers and phones do not need the extension files installed locally.

The initial versioned browser SDK exposes only panel/worktree context and a read-only unified Git diff. The included `.treeport/extensions/review` example demonstrates a refreshable review panel. Repositories should be trusted before loading their extensions.

Global and npm-installed extension discovery is not yet available.
