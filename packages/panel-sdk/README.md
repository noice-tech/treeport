# `@treeport/panel-sdk`

Typed browser SDK for [Treeport](https://treeport.app) web panels.

Install the SDK as a development dependency for editor and TypeScript support:

```sh
pnpm add --save-dev @treeport/panel-sdk
```

Treeport compiles panel source with its built-in Vite toolchain and resolves `@treeport/panel-sdk` to the host's runtime copy. Panel modules can therefore import the SDK directly without bundling their own copy, adding an import map, or defining a package-owned build step:

```ts
import { treeport } from '@treeport/panel-sdk'

treeport.panel.setTitle('Review route')
treeport.panel.setDirty(true)

const context = await treeport.context()
const diff = await treeport.diff()
const discovery = await treeport.network.listeners()

for (const listener of discovery.listeners) {
  console.log(listener.host, listener.port, listener.command)
}

// The unified patch is the final combined tree result. Paths can occur in
// more than one set, such as a branch file that was also edited locally.
console.log(diff.unified)
console.log(diff.changeSets.branch)
console.log(diff.changeSets.staged)
console.log(diff.changeSets.unstaged)
console.log(diff.changeSets.untracked)

await treeport.storage.set('drafts', [{ file: 'src/app.ts', line: 12 }])
const drafts = await treeport.storage.get('drafts')

const files = await treeport.files.list()
const file = await treeport.files.read(files.paths[0])
await treeport.files.write({
  path: file.path,
  content: file.content.replace('before', 'after'),
  expectedRevision: file.revision
})

const stopFind = treeport.shortcuts.onFind(() => {
  // Open the panel's own find interface.
})
```

`treeport.panel.setTitle(title)` sets a runtime title in the current Treeport client. Pass `null` to restore the configured title. Treeport does not persist or synchronize runtime titles.

`treeport.panel.setDirty(dirty)` reports local unsaved changes. Treeport warns before local panel closure while this value is `true`.

`treeport.files` requires the `tree-files` package permission. It can list, read, and change existing regular files in the current tree.

Paths are tree-relative. The API does not create, rename, or delete files. It supports UTF-8 files with a maximum size of 2 MiB.

`treeport.files.list()` returns a maximum of 50,000 paths. Its `truncated` value reports if more paths exist.

A read returns an opaque revision. Supply that revision as `expectedRevision` when you write the file.

Treeport rejects the write if the file changed after the read. Read the file again before you retry the write.

`treeport.context()` includes the stored JSON launch input and tree-relative launch directory.

`treeport.network.listeners()` returns listening TCP sockets conservatively attributed to the panel's tree by Treeport terminal ancestry or process working directory. Each listener includes its PID, short command, host, port, and a nullable Treeport terminal ID. Processes Treeport cannot access or confidently attribute are omitted. Unsupported platforms return `supported: false` instead of failing. A listener does not guarantee HTTP and the SDK does not turn it into a routed or proxied URL.

`treeport.diff()` returns a combined unified patch from the default-branch merge base through the final working-tree state. Its relative file paths are also grouped into `changeSets.branch` (merge base to `HEAD`), `changeSets.staged` (`HEAD` to index), `changeSets.unstaged` (index to working tree), and `changeSets.untracked`. A path can occur in more than one group.

`treeport.shortcuts.onFind(handler)` delivers `Cmd/Ctrl+F` whether keyboard focus is inside the panel or elsewhere in the Treeport workspace. It returns an unsubscribe function. Panels own their find interface and behavior; Treeport only routes the generic shortcut.
