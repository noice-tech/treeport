import type { Server as HttpServer } from 'node:http'
import { serve } from '@hono/node-server'
import {
  GhAdapter,
  GitAdapter,
  loadConfig,
  SpawnCommandRunner,
  TmuxAdapter,
  TaskTTYDatabase,
  TaskTTYService
} from '@tasktty/core'
import { createApp } from './app.js'
import { createSocketServer } from './socket-server.js'
import { TerminalMetadataManager } from './terminal-metadata.js'

const config = loadConfig()
const runner = new SpawnCommandRunner()
const database = new TaskTTYDatabase(config.databasePath)
const git = new GitAdapter(runner, config.gitPath)
const tmux = new TmuxAdapter(runner, config.runtimeDir, config.tmuxPath)
const gh = new GhAdapter(runner, config.ghPath)
const service = new TaskTTYService({ config, database, runner, git, tmux, gh })
await service.initialize()
const terminalMetadata = new TerminalMetadataManager(
  service,
  tmux,
  config.tmuxPath
)
await terminalMetadata.initialize()

const app = createApp({ service, config, tmux, terminalMetadata })
const server = serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.host
})
const { io, attachments } = createSocketServer(server as HttpServer, {
  service,
  config,
  tmux,
  terminalMetadata
})

console.log(`TaskTTY listening on ${config.apiUrl}`)
console.log(`database: ${config.databasePath}`)

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  attachments.dispose()
  terminalMetadata.dispose()
  io.close(() => {
    database.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
