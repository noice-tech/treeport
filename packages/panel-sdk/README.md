# `@treeport/panel-sdk`

Typed browser SDK for repository-local [Treeport](https://treeport.app) web panels.

```ts
import { treeport } from '@treeport/panel-sdk'

const context = await treeport.context()
const diff = await treeport.diff()
```

Treeport provides the runtime module inside its sandboxed panel frame. Add this package as a development dependency to make the same API contract available to TypeScript editors and coding agents.
