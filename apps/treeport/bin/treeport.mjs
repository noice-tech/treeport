#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let cliEntrypoint = new URL('../dist/node/cli/index.js', import.meta.url)
const daemonRecord = process.env.TREEPORT_DAEMON_RECORD?.trim()
if (daemonRecord) {
  const developmentRuntime = path.dirname(path.dirname(daemonRecord))
  if (path.basename(developmentRuntime) === '.treeport-dev') {
    const developmentCli = path.join(
      path.dirname(developmentRuntime),
      '.treeport-dev-dist/node/cli/index.js'
    )
    if (
      await access(developmentCli, fsConstants.X_OK).then(
        () => true,
        () => false
      )
    ) {
      cliEntrypoint = pathToFileURL(developmentCli)
    }
  }
}

process.env.TREEPORT_CLI_ENTRYPOINT ??= process.argv[1]
await import(cliEntrypoint.href)
