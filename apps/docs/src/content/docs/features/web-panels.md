---
title: Web panels (experimental)
description: Open HTTP applications and build worktree-scoped web tools.
---

Treeport has experimental support for browser panels and trusted repository-provided web panels. A web panel is persistent and worktree-bound: opening or closing it is synchronized across connected Treeport clients, while the selected panel remains local to each device.

## Open an HTTP application

The `@treeport/web-panel-browser` package provides the **Browser** panel as a normal [hosted panel](#create-a-hosted-panel). Select **Browser** from **New panel** to open an empty panel. Enter an absolute HTTP or HTTPS URL in the toolbar and select **Go**. The toolbar can open another address, reload the configured address, or open it in a separate browser tab.

When a Browser package is configured, you can also open or reuse it from a worktree terminal:

```sh
treeport web-panel open --worktree . browser \
  --input '{"url":"http://127.0.0.1:5173","title":"Application"}'
```

The URL must be reachable from the computer that runs the browser. A loopback address such as `127.0.0.1` refers to that computer. It does not refer to a remote Treeport daemon. Treeport does not proxy application traffic or change the URL host. An HTTPS Treeport page can also block an HTTP application as mixed content.

The Browser package loads the target in a nested iframe and owns the complete panel layout. Its high-trust `same-origin` permission lets the target use normal browser storage. An application can refuse iframe use with `Content-Security-Policy: frame-ancestors` or `X-Frame-Options`. Treeport does not bypass these controls. Use **Open externally** when the application cannot run in the panel.

Enter an address and press Enter to navigate. The Browser panel saves the current address in its panel storage. **Reload** affects only the current client. Another client uses the saved address when it later opens or reloads the panel.

The Browser panel checks if the address is reachable before it removes the loading state. If the connection fails or takes more than 10 seconds, it shows **Load failed**. Start the application or correct the address, then select **Retry**.

Use the development tools in your current browser to inspect the application and its elements. A web page cannot open browser development tools for you.

## Create a hosted panel

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

Use `treeport.panel.updateLaunch(launch)` to replace the persistent launch input and working directory. This update does not reload open panel frames. The panel can apply the change in its current frame. A later open uses the saved launch data. An explicit `treeport web-panel open` request reloads a reused panel. Use `treeport.panel.openExternal(url)` to open an HTTP or HTTPS URL outside the panel.

A target application in Browser can use `treeport.panel.setTitle()`, but it cannot use context, diff, storage, shortcuts, or workspace navigation. Add the SDK to the target application's normal build when it uses the title method.

`treeport.diff()` returns merge-base metadata and a read-only unified diff. `treeport.shortcuts.onFind(handler)` routes `Cmd/Ctrl+F` to the panel and returns an unsubscribe function.

`treeport.storage` is durable JSON key-value storage scoped to the panel instance. It is deleted when the panel is closed, and Treeport asks for confirmation before closing a panel with stored data. Keys are limited to 128 characters, values to 64 KiB, and each panel to 256 values or 1 MiB total.
