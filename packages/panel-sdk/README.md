# `@treeport/panel-sdk`

Typed browser SDK for repository-local [Treeport](https://treeport.app) web panels.

Add the package as a development dependency for editor and TypeScript support. Repository-local panels run without a build step, so declare Treeport's browser runtime explicitly in `index.html`:

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

The panel module can then use the same package import understood by the editor and browser:

```ts
import { treeport } from '@treeport/panel-sdk'

const context = await treeport.context()
const diff = await treeport.diff()

await treeport.storage.set('drafts', [{ file: 'src/app.ts', line: 12 }])
const drafts = await treeport.storage.get('drafts')

const stopFind = treeport.shortcuts.onFind(() => {
  // Open the panel's own find interface.
})
```

Treeport serves the runtime module from `/api/web-panel-sdk.js` inside its sandboxed panel frame, but does not modify panel HTML. The panel-owned import map makes runtime resolution explicit while this package provides the matching API contract to TypeScript editors and coding agents.

`treeport.shortcuts.onFind(handler)` delivers `Cmd/Ctrl+F` whether keyboard focus is inside the panel or elsewhere in the Treeport workspace. It returns an unsubscribe function. Panels own their find interface and behavior; Treeport only routes the generic shortcut.
