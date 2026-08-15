#!/usr/bin/env node

process.env.TREEPORT_CLI_ENTRYPOINT ??= process.argv[1]
await import('../dist/node/cli/index.js')
