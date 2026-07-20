import { serve, type WebSocketServerLike } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  GhAdapter,
  GitAdapter,
  loadConfig,
  SpawnCommandRunner,
  TmuxAdapter,
  TaskTTYDatabase,
  TaskTTYService,
} from "@tasktty/core";
import { TERMINAL_MAX_CLIENT_MESSAGE_BYTES } from "@tasktty/shared";
import { createApp } from "./app.js";

const config = loadConfig();
const runner = new SpawnCommandRunner();
const database = new TaskTTYDatabase(config.databasePath);
const git = new GitAdapter(runner, config.gitPath);
const tmux = new TmuxAdapter(runner, config.runtimeDir, config.tmuxPath);
const gh = new GhAdapter(runner, config.ghPath);
const service = new TaskTTYService({ config, database, runner, git, tmux, gh });
await service.initialize();

const app = createApp({ service, config, tmux });
const webSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
});
const server = serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.host,
  websocket: { server: webSocketServer as unknown as WebSocketServerLike },
});

console.log(`TaskTTY listening on ${config.apiUrl}`);
console.log(`database: ${config.databasePath}`);

function shutdown(): void {
  server.close(() => {
    webSocketServer.close();
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
