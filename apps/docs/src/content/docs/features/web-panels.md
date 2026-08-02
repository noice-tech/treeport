---
title: Web panels (experimental)
description: Run repository-provided, worktree-scoped web tools inside Treeport.
---

Treeport has an experimental runtime for trusted repository-provided web panels. A web panel is persistent and worktree-bound: opening or closing it is synchronized across connected Treeport clients, while the selected panel remains local to each device.

Project-local web panels live under `.treeport/web-panels/<name>/`. Each folder containing `index.html` defines one web-panel definition; the folder name supplies its stable definition identity and humanized title, so project-local panels need no manifest. Treeport serves the folder's browser-native HTML, CSS, JavaScript modules, and assets from the daemon and runs the panel in an isolated frame, so remote browsers and phones do not need the panel files installed locally.

Treeport distinguishes an available web-panel definition from the persistent panel instance created when you launch it. Definitions also carry source provenance, allowing future Treeport packages to provide web panels through the same model as project-local definitions. Package installation and discovery are not implemented yet.

Open **New panel** from a worktree or press `Cmd/Ctrl+Shift+T` to choose between Shell, terminal presets, and discovered web panels. `Cmd/Ctrl+T` continues to create a Shell directly. Web panels share the numbered workspace shortcuts with terminals, so `Cmd+1` through `Cmd+9` switch to the corresponding sidebar item.

After a panel is visited, Treeport keeps its frame alive while switching among terminals and other panels. In-memory UI state such as scroll position and unfinished form input therefore behaves like a browser tab. Full-page reloads still reset that ephemeral state; use `treeport.storage` for state that must survive reloads or daemon restarts.

## Browser SDK

Optionally add the SDK package as a development dependency so editors and coding agents can inspect the panel API:

```sh
pnpm add --save-dev @treeport/panel-sdk
```

Treeport and `@treeport/panel-sdk` always use the same release version. The package supplies editor tooling and types, while Treeport serves the matching browser runtime. Treeport does not modify panel HTML, so map the package import to that runtime explicitly in `index.html`, before loading any module scripts:

```html
<script type="importmap">
  {
    "imports": {
      "@treeport/panel-sdk": "/api/web-panel-sdk.js"
    }
  }
</script>
<script type="module" src="./panel.js"></script>
```

The panel module can then use the same import understood by the installed package and the browser:

```js
import { treeport } from '@treeport/panel-sdk'

const context = await treeport.context()
const diff = await treeport.diff()

await treeport.storage.set('drafts', [{ file: 'src/app.ts', line: 12 }])
const drafts = await treeport.storage.get('drafts')

const stopFind = treeport.shortcuts.onFind(() => {
  // Open the panel's own find interface.
})
```

`treeport.context()` returns the current panel, project, and worktree identity. `treeport.diff()` returns merge-base metadata and a read-only unified diff containing committed, tracked local, and untracked changes.

`treeport.storage` is durable JSON key-value storage scoped to the current panel instance. It survives navigation and daemon restarts and is deleted when the panel is closed. Treeport asks for confirmation before closing a panel with stored data. Keys are limited to 128 characters, individual values to 64 KiB, and each panel to 256 values or 1 MiB total.

`treeport.shortcuts.onFind(handler)` delivers `Cmd/Ctrl+F` whether focus is inside the panel or elsewhere in the Treeport workspace. It returns an unsubscribe function. The panel owns its find interface and behavior; Treeport only routes the generic shortcut.

Panel source is not transpiled or bundled. Use browser-native JavaScript and direct browser ESM URLs for optional npm libraries, pinning their versions:

```js
import { FileDiff } from 'https://esm.sh/@pierre/diffs@1.3.1?bundle'
```

The package declarations and JSDoc are the authoritative editor contract. The corresponding readable browser runtime remains inspectable at `/api/web-panel-sdk.js` on a running daemon. Importing the SDK module activates iframe-local platform shortcuts, including numbered workspace switching, so panels using those facilities must include the import map and import the SDK.

The included `.treeport/web-panels/review` JavaScript example uses pinned esm.sh builds of `@pierre/diffs` and `@pierre/trees` to render a refreshable review panel with changed-file navigation. Press `Cmd/Ctrl+F` to find and navigate matching text across changed lines. Each file can be collapsed or expanded and marked as viewed; viewed files persist, collapse when marked, and expand when unmarked. Editable inline comments also persist through `treeport.storage`, include previous/next navigation, and can be copied as a `file:line` review list suitable for passing to a developer or coding agent. Repositories should be trusted before loading their web panels.

Global and package-provided web-panel discovery is not yet available. Future Treeport packages may provide `web-panels` resources with package provenance, but project-local web panels do not need a package or manifest.
