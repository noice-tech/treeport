---
title: Web panels (experimental)
description: Build worktree panels with the Treeport Vite runtime.
---

Treeport has an experimental runtime for trusted web panels that a repository supplies.

A web panel is persistent and belongs to one worktree.

Treeport synchronizes open and close operations between connected clients. The selected panel stays local to each client.

## Create a panel

Put a project panel in `.treeport/web-panels/<name>/`.

Each folder with an `index.html` file defines one panel. The folder name gives the panel its stable identity and default title.

Packages can supply the same source layout with [`treeport.webPanels`](/features/packages/).

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

Treeport controls the Vite server and compiler.

Do not commit generated assets. Do not add a panel build script.

Project panels and local packages use Vite development serving, React Fast Refresh, and same-origin HMR.

Treeport compiles installed npm panels into fixed cached assets when you first open them.

A package update makes a new build. It does not change assets that are already open in a frame.

## Use the supported source profile

Panels can use these Vite functions:

- TypeScript, TSX, and JSX;
- CSS and JSON;
- dynamic imports;
- imported static assets;
- `import.meta.glob`;
- React through the fixed Treeport React profile.

Production panel builds include source maps.

Put browser libraries, such as React, in the package `dependencies`.

Vite resolves bare imports from the installed package graph. It includes the React version that the package declares.

Treeport supplies `@treeport/panel-sdk`. Put this package in `devDependencies` to get authoring types.

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

Treeport does not load these package items:

- `vite.config.*`;
- executable Babel or PostCSS configuration;
- package Vite plug-ins;
- build scripts;
- lifecycle scripts.

A package cannot change the compiler profile. The initial profile does not include Tailwind.

Use standard CSS instead.

## Open and keep panels

Open **New panel** in a worktree. Then, select a discovered web panel.

In the macOS desktop client, `Cmd+Shift+T` opens **New panel**.

Numbered panel shortcuts also include web panels. Browser clients keep these shortcuts for browser tab operations.

See the [Shortcuts reference](/reference/shortcuts/).

After you visit a panel, Treeport keeps its frame active while you change workspaces.

This keeps in-memory state, such as scroll position and unfinished input.

Use `treeport.storage` for state that must continue after reloads or daemon restarts.

A panel definition and a panel instance are separate items.

Package definition identities do not contain npm versions. Thus, package updates keep existing panel instances and storage.

If you remove a package, its panel instances stay in storage but are not available.

Install the same definition again to make them available.

Use the CLI to open or reuse a panel instance:

```sh
treeport web-panel open --worktree . review \
  --input '{"path":"output/result.json"}'
```

The command accepts an exact definition ID or one clear short name.

By default, it uses the newest instance for the definition. It replaces the saved start input and reloads the panel frame.

It does not change durable `treeport.storage` values.

Use `--new` to make another instance.

## Use the panel SDK

Install the SDK as a development dependency:

```sh
pnpm add --save-dev @treeport/panel-sdk
```

Import the SDK in the panel:

```ts
import { treeport } from '@treeport/panel-sdk'

const context = await treeport.context()
const diff = await treeport.diff()
const input = context.launch.input

await treeport.storage.set('drafts', [{ file: 'src/app.ts', line: 12 }])
const drafts = await treeport.storage.get('drafts')

const stopFind = treeport.shortcuts.onFind(() => {
  // Open the panel find interface.
})
```

The Treeport Vite profile maps this import to the host SDK. You do not need a runtime dependency or import map.

`treeport.context()` returns panel, project, worktree, and start data.

The start input is a JSON object or `null`. The start `cwd` is relative to the worktree root.

Use `treeport.panel.setTitle(title)` to set a title on the current client.

Use `treeport.panel.setTitle(null)` to restore the configured title.

Treeport does not save runtime titles or send them to other clients.

`treeport.diff()` returns merge-base information and a read-only unified diff for the final worktree state.

It groups relative file paths into these sets:

- `changeSets.branch`: Merge base to `HEAD`.
- `changeSets.staged`: `HEAD` to the index.
- `changeSets.unstaged`: Index to the working tree.
- `changeSets.untracked`: Untracked files.

Sets can overlap. For example, a committed file with a local edit appears in the branch and unstaged sets.

Use `unified` to show the final diff. Use `changeSets` to organize the files.

`treeport.shortcuts.onFind(handler)` sends `Cmd/Ctrl+F` to the panel. It returns a function that removes the handler.

`treeport.storage` is durable JSON key-value storage for one panel instance.

Treeport deletes this storage when you close the panel. It requests approval before closing a panel that has saved data.

A key can have a maximum of 128 characters. A value can have a maximum size of 64 KiB.

Each panel can have a maximum of 256 values and 1 MiB of data.
