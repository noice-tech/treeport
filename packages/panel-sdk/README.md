# `@treeport/panel-sdk`

Typed browser SDK for [Treeport](https://treeport.app) web panels.

Install the SDK as a development dependency for editor and TypeScript support:

```sh
pnpm add --save-dev @treeport/panel-sdk
```

Treeport compiles panel source with its built-in Vite toolchain and resolves `@treeport/panel-sdk` to the host's runtime copy. Panel modules can therefore import the SDK directly without bundling their own copy, adding an import map, or defining a package-owned build step:

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

`treeport.shortcuts.onFind(handler)` delivers `Cmd/Ctrl+F` whether keyboard focus is inside the panel or elsewhere in the Treeport workspace. It returns an unsubscribe function. Panels own their find interface and behavior; Treeport only routes the generic shortcut.
