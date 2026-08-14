---
title: Web panels (experimental)
description: Build worktree-scoped web tools with Treeport's hosted Vite runtime.
---

Treeport has an experimental runtime for trusted repository-provided web panels. A web panel is persistent and worktree-bound: opening or closing it is synchronized across connected Treeport clients, while the selected panel remains local to each device.

Project-local panels live under `.treeport/web-panels/<name>/`. Each folder containing `index.html` defines a panel; the folder name supplies its stable identity and humanized title. Packages can contribute the same source layout through [`treeport.webPanels`](/features/packages/).

```text
.treeport/web-panels/review/
├── index.html
├── review.tsx
└── review.css
```

```html
<div id="root"></div>
<script type="module" src="./review.tsx"></script>
```

Treeport owns the Vite server and compiler. Do not commit generated assets or add a panel build script. Local project panels and local-path packages use Vite development serving, React Fast Refresh, and same-origin HMR. Treeport compiles npm-installed package panels into immutable cached assets when first opened. Updating a package produces a new build without invalidating assets already loaded by an open frame.

## Supported Vite profile

Panels can use TypeScript, TSX, JSX, CSS, JSON, dynamic imports, imported static assets, and `import.meta.glob`. React panels are supported by Treeport's fixed React plugin profile. Production builds include source maps.

Declare browser libraries such as React in the package's normal `dependencies`. Vite resolves bare imports from the package's installed dependency graph and bundles that graph, including the package's declared React version. The Treeport host provides `@treeport/panel-sdk`; declare it as a `devDependency` for authoring types rather than shipping a separate runtime copy.

```json
{
  "treeport": {
    "webPanels": ["./web-panels/review"]
  },
  "dependencies": {
    "react": "19.2.7",
    "react-dom": "19.2.7"
  },
  "devDependencies": {
    "@treeport/panel-sdk": "0.1.0"
  }
}
```

Treeport does not load package `vite.config.*`, executable Babel or PostCSS configuration, package-provided Vite plugins, build scripts, or lifecycle scripts. A package cannot customize the hosted compiler profile. Tailwind is not part of the initial hosted profile; commit ordinary CSS instead.

## Open and retain panels

Open **New panel** from a worktree or press `Cmd/Ctrl+Shift+T` to choose a discovered web panel. Web panels share numbered workspace shortcuts with terminals. After a panel is visited, Treeport keeps its frame alive while switching workspaces, preserving in-memory state such as scroll position and unfinished input. Use `treeport.storage` for state that must survive reloads or daemon restarts.

Definitions are separate from persistent panel instances. Package definition identities exclude npm versions, so package updates preserve existing instances and storage. Removing a package leaves those instances unavailable but intact; reinstalling the same definition revives them.

The CLI can open or reuse an instance and provide one inline JSON object:

```sh
treeport web-panel open --worktree . review \
  --input '{"path":"output/result.json"}'
```

The command accepts an exact definition ID or an unambiguous short name. It reuses the newest instance for the definition, replaces the stored launch input, and reloads the panel frame. Durable `treeport.storage` values remain unchanged. Use `--new` when the worktree needs another instance.

## Panel SDK

Install the SDK as a development dependency for types and import it normally. Treeport's Vite profile resolves that import to the host's SDK, so no runtime dependency or import map is needed:

```sh
pnpm add --save-dev @treeport/panel-sdk
```

```ts
import { treeport } from '@treeport/panel-sdk'

const context = await treeport.context()
const diff = await treeport.diff()
const input = context.launch.input

await treeport.storage.set('drafts', [{ file: 'src/app.ts', line: 12 }])
const drafts = await treeport.storage.get('drafts')

const stopFind = treeport.shortcuts.onFind(() => {
  // Open the panel's own find interface.
})
```

`treeport.context()` returns the panel, project, worktree, and launch data. Launch input is a JSON object or `null`. Launch `cwd` is relative to the worktree root.

Use `treeport.panel.setTitle(title)` to set a runtime title for the current client. Use `treeport.panel.setTitle(null)` to restore the configured title. Runtime titles are not saved or sent to other clients.

`treeport.diff()` returns merge-base metadata and a read-only unified diff for the combined final worktree state. Relative file paths are grouped into `changeSets.branch` (merge base to `HEAD`), `changeSets.staged` (`HEAD` to index), `changeSets.unstaged` (index to working tree), and `changeSets.untracked`. Sets can overlap; for example, a committed branch file edited locally appears in both branch and unstaged changes. Use `unified` to render the final diff and `changeSets` to organize its files.

`treeport.shortcuts.onFind(handler)` routes `Cmd/Ctrl+F` to the panel and returns an unsubscribe function.

`treeport.storage` is durable JSON key-value storage scoped to the panel instance. It is deleted when the panel is closed, and Treeport asks for confirmation before closing a panel with stored data. Keys are limited to 128 characters, values to 64 KiB, and each panel to 256 values or 1 MiB total.
