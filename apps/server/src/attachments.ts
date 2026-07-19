import crypto from "node:crypto";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type { WSContext } from "hono/ws";
import type { TerminalClientMessage, TerminalServerMessage } from "@wtr/shared";
import type { WtrService, TmuxAdapter } from "@wtr/core";
import { resolveExecutablePath } from "@wtr/core";

interface ClientConnection {
  id: string;
  terminalId: string;
  ws: WSContext;
  pty: IPty;
  poll: NodeJS.Timeout;
  lastExitCode: number | null | undefined;
}

export class TerminalAttachmentManager {
  private readonly clients = new Map<string, ClientConnection>();
  private readonly controllers = new Map<string, string>();

  private readonly tmuxExecutable: string;

  constructor(
    private readonly service: WtrService,
    private readonly tmux: TmuxAdapter,
    tmuxExecutable: string,
  ) {
    this.tmuxExecutable = resolveExecutablePath(tmuxExecutable);
  }

  async open(terminalId: string, ws: WSContext): Promise<string> {
    const terminal = await this.service.refreshTerminalStatus(terminalId);
    if (terminal.status === "missing")
      throw new Error("The tmux session for this terminal is missing");
    const worktree = this.service.getWorktree(terminal.worktreeId);
    const size = (await this.tmux.sessionSize(
      worktree.tmuxSocketName,
      terminal.tmuxSessionName,
    )) ?? { cols: 100, rows: 30 };
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => value !== undefined && key !== "TMUX" && key !== "TMUX_PANE",
      ),
    ) as Record<string, string>;
    env.TERM = "xterm-256color";
    const clientPty = pty.spawn(
      this.tmuxExecutable,
      this.tmux.attachArgs(worktree.tmuxSocketName, terminal.tmuxSessionName),
      {
        name: "xterm-256color",
        cols: size.cols,
        rows: size.rows,
        cwd: worktree.path,
        env,
      },
    );
    const connectionId = crypto.randomUUID();
    if (!this.controllers.has(terminalId)) this.controllers.set(terminalId, connectionId);
    const poll = setInterval(() => void this.pollTerminal(connectionId), 2_000);
    poll.unref();
    const connection: ClientConnection = {
      id: connectionId,
      terminalId,
      ws,
      pty: clientPty,
      poll,
      lastExitCode: undefined,
    };
    this.clients.set(connectionId, connection);
    clientPty.onData((data) => this.send(ws, { type: "output", data }));
    clientPty.onExit(({ exitCode }) => this.send(ws, { type: "exit", exitCode }));
    this.broadcastControl(terminalId);
    return connectionId;
  }

  message(connectionId: string, raw: unknown): void {
    const connection = this.clients.get(connectionId);
    if (!connection) return;
    let message: TerminalClientMessage;
    try {
      const serialized =
        typeof raw === "string"
          ? raw
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw).toString("utf8")
            : String(raw);
      message = JSON.parse(serialized) as TerminalClientMessage;
    } catch {
      this.send(connection.ws, { type: "error", message: "Invalid terminal message" });
      return;
    }
    if (message.type === "take_control") {
      this.controllers.set(connection.terminalId, connectionId);
      this.broadcastControl(connection.terminalId);
      this.service.events.publish("terminal.controller_changed", {
        terminalId: connection.terminalId,
        controllerId: connectionId,
      });
      return;
    }
    if (this.controllers.get(connection.terminalId) !== connectionId) return;
    if (message.type === "input" && typeof message.data === "string")
      connection.pty.write(message.data);
    if (
      message.type === "resize" &&
      Number.isInteger(message.cols) &&
      Number.isInteger(message.rows) &&
      message.cols >= 2 &&
      message.cols <= 1_000 &&
      message.rows >= 2 &&
      message.rows <= 500
    ) {
      connection.pty.resize(message.cols, message.rows);
    }
  }

  close(connectionId: string): void {
    const connection = this.clients.get(connectionId);
    if (!connection) return;
    clearInterval(connection.poll);
    connection.pty.kill();
    this.clients.delete(connectionId);
    if (this.controllers.get(connection.terminalId) === connectionId) {
      const replacement = [...this.clients.values()].find(
        (client) => client.terminalId === connection.terminalId,
      );
      if (replacement) this.controllers.set(connection.terminalId, replacement.id);
      else this.controllers.delete(connection.terminalId);
      this.broadcastControl(connection.terminalId);
      this.service.events.publish("terminal.controller_changed", {
        terminalId: connection.terminalId,
        controllerId: replacement?.id ?? null,
      });
    }
  }

  private async pollTerminal(connectionId: string): Promise<void> {
    const connection = this.clients.get(connectionId);
    if (!connection) return;
    try {
      const terminal = await this.service.refreshTerminalStatus(connection.terminalId);
      if (terminal.status === "exited" && terminal.exitCode !== connection.lastExitCode) {
        connection.lastExitCode = terminal.exitCode;
        this.send(connection.ws, { type: "exit", exitCode: terminal.exitCode });
      }
    } catch {
      // Session cleanup will close the tmux client and trigger its PTY exit.
    }
  }

  private broadcastControl(terminalId: string): void {
    const controllerId = this.controllers.get(terminalId) ?? null;
    for (const client of this.clients.values()) {
      if (client.terminalId === terminalId) {
        this.send(client.ws, {
          type: "control",
          controller: client.id === controllerId,
          controllerId,
        });
      }
    }
  }

  private send(ws: WSContext, message: TerminalServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The close callback performs final cleanup.
    }
  }
}
