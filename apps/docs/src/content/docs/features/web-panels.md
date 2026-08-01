---
title: Web panels (experimental)
description: Run repository-provided, worktree-scoped web tools inside Treeport.
---

Treeport has an experimental web-panel runtime for trusted repository extensions. A web panel is persistent and worktree-bound: opening or closing it is synchronized across connected Treeport clients, while the selected panel remains local to each device.

Repository extensions live under `.treeport/extensions/<name>/`. Each folder contributes one panel whose entry point is `index.html`; the folder name supplies the panel identity and title, so local extensions need no manifest. Treeport serves the folder's browser-native HTML, CSS, JavaScript modules, and assets from the daemon and runs the panel in an isolated frame, so remote browsers and phones do not need the extension files installed locally.

Open **New panel** from a worktree or press `Cmd/Ctrl+Shift+T` to choose between Shell, terminal presets, and discovered web panels. `Cmd/Ctrl+T` continues to create a Shell directly.

## Browser SDK

Optionally add the SDK package as a development dependency so editors and coding agents can inspect the panel API:

```sh
pnpm add --save-dev @treeport/panel-sdk
```

Treeport and `@treeport/panel-sdk` always use the same release version. The package is needed only for editor tooling; Treeport provides the browser runtime. Import it from a JavaScript module:

```js
import { treeport } from '@treeport/panel-sdk'

const context = await treeport.context()
const diff = await treeport.diff()
```

`treeport.context()` returns the current panel, project, and worktree identity. `treeport.diff()` returns merge-base metadata and a read-only unified diff containing committed, tracked local, and untracked changes.

Panel source is not transpiled or bundled. Use browser-native JavaScript and direct browser ESM URLs for optional npm libraries, pinning their versions:

```js
import { FileDiff } from 'https://esm.sh/@pierre/diffs@1.3.1?bundle'
```

The package declarations and JSDoc are the authoritative editor contract. The corresponding readable browser runtime remains inspectable at `/api/web-panel-sdk.js` on a running daemon.

The included `.treeport/extensions/review` JavaScript example uses pinned esm.sh builds of `@pierre/diffs` and `@pierre/trees` to render a refreshable review panel with changed-file navigation. Repositories should be trusted before loading their extensions.

Global and npm-installed extension discovery is not yet available. npm extensions will use their required `package.json` for package identity, but repository-local extensions do not need one.
