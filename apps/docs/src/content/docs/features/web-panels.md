---
title: Web panels (experimental)
description: Run repository-provided, worktree-scoped web tools inside Treeport.
---

Treeport has an experimental web-panel runtime for trusted repository extensions. A web panel is persistent and worktree-bound: opening or closing it is synchronized across connected Treeport clients, while the selected panel remains local to each device.

Repository extensions live under `.treeport/extensions/<name>/`. Each folder contributes one panel whose entry point is `index.html`; the folder name supplies the panel identity and title, so local extensions need no manifest. Treeport serves the folder's HTML, CSS, and browser JavaScript modules from the daemon and runs the panel in an isolated frame, so remote browsers and phones do not need the extension files installed locally.

Open **New panel** from a worktree or press `Cmd/Ctrl+Shift+T` to choose between Shell, terminal presets, and discovered web panels. `Cmd/Ctrl+T` continues to create a Shell directly.

The initial versioned browser SDK exposes only panel/worktree context and a read-only unified Git diff. The included `.treeport/extensions/review` example demonstrates a refreshable review panel. Repositories should be trusted before loading their extensions.

Global and npm-installed extension discovery is not yet available. npm extensions will use their required `package.json` for package identity, but repository-local extensions do not need one.
