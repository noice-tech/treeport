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

const context = await treeport.context()
const diff = await treeport.diff()
const discovery = await treeport.network.listeners()

for (const listener of discovery.listeners) {
  console.log(listener.host, listener.port, listener.command)
}

await treeport.storage.set('drafts', [{ file: 'src/app.ts', line: 12 }])
const drafts = await treeport.storage.get('drafts')

const stopFind = treeport.shortcuts.onFind(() => {
  // Open the panel's own find interface.
})
```

`treeport.panel.setTitle(title)` sets a runtime title in the current Treeport client. Pass `null` to restore the configured title. Treeport does not persist or synchronize runtime titles.

`treeport.context()` includes the stored JSON launch input and worktree-relative launch directory.

`treeport.network.listeners()` returns listening TCP sockets conservatively attributed to the panel's worktree by Treeport terminal ancestry or process working directory. Each listener includes its PID, short command, host, port, and a nullable Treeport terminal ID. Processes Treeport cannot access or confidently attribute are omitted. Unsupported platforms return `supported: false` instead of failing. A listener does not guarantee HTTP and the SDK does not turn it into a routed or proxied URL.

`treeport.shortcuts.onFind(handler)` delivers `Cmd/Ctrl+F` whether keyboard focus is inside the panel or elsewhere in the Treeport workspace. It returns an unsubscribe function. Panels own their find interface and behavior; Treeport only routes the generic shortcut.

An HTTP application loaded in the Browser package's nested iframe can use `treeport.panel.setTitle()`. The Browser package relays this title message. The target must include the SDK in its own application build. Browser targets cannot use context, diff, network discovery, storage, launch, external URL, shortcuts, or workspace navigation methods.
