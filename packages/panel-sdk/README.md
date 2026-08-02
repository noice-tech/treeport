# `@treeport/panel-sdk`

Typed browser SDK for repository-local [Treeport](https://treeport.app) web panels.

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

Treeport provides the runtime module inside its sandboxed panel frame. Add this package as a development dependency to make the same API contract available to TypeScript editors and coding agents.

`treeport.shortcuts.onFind(handler)` delivers `Cmd/Ctrl+F` whether keyboard focus is inside the panel or elsewhere in the Treeport workspace. It returns an unsubscribe function. Panels own their find interface and behavior; Treeport only routes the generic shortcut.
