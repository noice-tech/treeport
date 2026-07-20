import crypto from "node:crypto";
import type { IDisposable, IPty } from "node-pty";
import * as pty from "node-pty";
import type { WSContext } from "hono/ws";
import {
  parseTerminalClientMessage,
  TERMINAL_CONTROLLER_GRACE_MS,
  TERMINAL_HEARTBEAT_MS,
  TERMINAL_HEARTBEAT_TIMEOUT_MS,
  TERMINAL_HELLO_TIMEOUT_MS,
  TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
  TERMINAL_OUTPUT_HIGH_WATERMARK,
  TERMINAL_OUTPUT_LOW_WATERMARK,
  TERMINAL_OUTPUT_STALL_TIMEOUT_MS,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalClientMessage,
  type TerminalRuntimeMetadata,
  type TerminalServerMessage,
} from "@tasktty/shared";
import type { TaskTTYService, TmuxAdapter } from "@tasktty/core";
import { resolveExecutablePath } from "@tasktty/core";
import type { TerminalMetadataManager } from "./terminal-metadata.js";

type PtySpawner = typeof pty.spawn;
type ConnectionState = "awaiting_hello" | "initializing" | "ready" | "closed";

interface ClientConnection {
  id: string;
  terminalId: string;
  ws: WSContext;
  state: ConnectionState;
  clientId: string | null;
  pty: IPty | null;
  streamId: string | null;
  heartbeat: NodeJS.Timeout | null;
  helloTimeout: NodeJS.Timeout | null;
  stallTimeout: NodeJS.Timeout | null;
  dataDisposable: IDisposable | null;
  exitDisposable: IDisposable | null;
  lastPongAt: number;
  lastPingNonce: string | null;
  nextSequence: number;
  lastAckSequence: number;
  unacknowledgedBytes: number;
  outputBytes: Map<number, number>;
  paused: boolean;
  announcedReady: boolean;
  metadataUnsubscribe: (() => void) | null;
}

interface ControllerLease {
  clientId: string;
  connectionId: string | null;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
}

function clientMessageByteLength(raw: unknown): number {
  if (typeof raw === "string") return Buffer.byteLength(raw);
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return Buffer.byteLength(String(raw));
}

function errorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  return (message || "Terminal attachment failed").slice(0, 1_000);
}

function tmuxEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && key !== "TMUX" && key !== "TMUX_PANE",
    ),
  ) as NodeJS.ProcessEnv;
}

export class TerminalAttachmentManager {
  private readonly clients = new Map<string, ClientConnection>();
  private readonly controllers = new Map<string, ControllerLease>();
  private readonly tmuxExecutable: string;

  constructor(
    private readonly service: TaskTTYService,
    private readonly tmux: TmuxAdapter,
    tmuxExecutable: string,
    private readonly metadata: TerminalMetadataManager,
    private readonly spawnPty: PtySpawner = pty.spawn,
  ) {
    this.tmuxExecutable = resolveExecutablePath(tmuxExecutable);
  }

  accept(terminalId: string, ws: WSContext): string {
    const id = crypto.randomUUID();
    const connection: ClientConnection = {
      id,
      terminalId,
      ws,
      state: "awaiting_hello",
      clientId: null,
      pty: null,
      streamId: null,
      heartbeat: null,
      helloTimeout: null,
      stallTimeout: null,
      dataDisposable: null,
      exitDisposable: null,
      lastPongAt: Date.now(),
      lastPingNonce: null,
      nextSequence: 1,
      lastAckSequence: 0,
      unacknowledgedBytes: 0,
      outputBytes: new Map(),
      paused: false,
      announcedReady: false,
      metadataUnsubscribe: null,
    };
    connection.helloTimeout = setTimeout(
      () => this.protocolError(connection, "HELLO_TIMEOUT", "Terminal handshake timed out", 1008),
      TERMINAL_HELLO_TIMEOUT_MS,
    );
    connection.helloTimeout.unref();
    this.clients.set(id, connection);
    return id;
  }

  message(connectionId: string, raw: unknown): void {
    const connection = this.clients.get(connectionId);
    if (!connection || connection.state === "closed") return;
    if (clientMessageByteLength(raw) > TERMINAL_MAX_CLIENT_MESSAGE_BYTES) {
      this.protocolError(connection, "MESSAGE_TOO_LARGE", "Terminal message is too large", 1009);
      return;
    }
    let value: unknown;
    try {
      const serialized =
        typeof raw === "string"
          ? raw
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw).toString("utf8")
            : ArrayBuffer.isView(raw)
              ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8")
              : String(raw);
      value = JSON.parse(serialized);
    } catch {
      this.protocolError(connection, "INVALID_JSON", "Invalid terminal message", 1008);
      return;
    }
    const message = parseTerminalClientMessage(value);
    if (!message) {
      this.protocolError(connection, "INVALID_MESSAGE", "Invalid terminal message", 1008);
      return;
    }
    if (connection.state === "awaiting_hello") {
      if (message.type !== "hello") {
        this.protocolError(connection, "HELLO_REQUIRED", "hello must be the first message", 1002);
        return;
      }
      connection.state = "initializing";
      connection.clientId = message.clientId;
      if (connection.helloTimeout) clearTimeout(connection.helloTimeout);
      connection.helloTimeout = null;
      void this.initialize(connection, message.cols, message.rows);
      return;
    }
    if (connection.state !== "ready") {
      this.protocolError(connection, "NOT_READY", "Terminal attachment is not ready", 1008);
      return;
    }
    if (message.type === "hello") {
      this.protocolError(connection, "DUPLICATE_HELLO", "hello has already been received", 1002);
      return;
    }
    this.handleReadyMessage(connection, message);
  }

  close(connectionId: string): void {
    const connection = this.clients.get(connectionId);
    if (!connection || connection.state === "closed") return;
    connection.state = "closed";
    this.clients.delete(connectionId);
    if (connection.helloTimeout) clearTimeout(connection.helloTimeout);
    if (connection.heartbeat) clearInterval(connection.heartbeat);
    if (connection.stallTimeout) clearTimeout(connection.stallTimeout);
    connection.dataDisposable?.dispose();
    connection.exitDisposable?.dispose();
    connection.metadataUnsubscribe?.();
    connection.metadataUnsubscribe = null;
    try {
      connection.pty?.kill();
    } catch {
      // The tmux client may already have exited.
    }

    const lease = this.controllers.get(connection.terminalId);
    if (lease?.connectionId === connection.id) {
      if (!connection.announcedReady) {
        if (lease.timer) clearTimeout(lease.timer);
        this.controllers.delete(connection.terminalId);
      } else {
        lease.connectionId = null;
        lease.expiresAt = Date.now() + TERMINAL_CONTROLLER_GRACE_MS;
        if (lease.timer) clearTimeout(lease.timer);
        lease.timer = setTimeout(
          () => this.expireControllerLease(connection.terminalId, lease.clientId),
          TERMINAL_CONTROLLER_GRACE_MS,
        );
        lease.timer.unref();
      }
      this.broadcastControl(connection.terminalId);
      this.publishControllerChanged(connection.terminalId, null);
    }
  }

  private async initialize(
    connection: ClientConnection,
    cols: number,
    rows: number,
  ): Promise<void> {
    try {
      const terminal = await this.service.refreshTerminalStatus(connection.terminalId);
      if (terminal.status === "missing")
        throw new Error("The tmux session for this terminal is missing");
      const worktree = this.service.getWorktree(terminal.worktreeId);
      await this.tmux.configureServer(worktree.tmuxSocketName);
      const [sessionSize] = await Promise.all([
        this.tmux.sessionSize(worktree.tmuxSocketName, terminal.tmuxSessionName),
        this.metadata.trackTerminal(terminal, worktree),
      ]);
      if (connection.state === "closed") return;
      const size = sessionSize ?? { cols, rows };
      const env = tmuxEnvironment();
      env.TERM = "xterm-256color";
      const clientPty = this.spawnPty(
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
      connection.pty = clientPty;
      connection.streamId = crypto.randomUUID();
      connection.metadataUnsubscribe = this.metadata.subscribe(
        connection.terminalId,
        (metadata) => {
          if (connection.announcedReady && this.isActive(connection))
            this.sendRuntimeMetadata(connection, metadata);
        },
      );
      clientPty.pause();
      connection.dataDisposable = clientPty.onData((data) => this.sendOutput(connection, data));
      connection.exitDisposable = clientPty.onExit(({ exitCode }) =>
        this.send(connection, {
          version: TERMINAL_PROTOCOL_VERSION,
          type: "exit",
          exitCode,
        }),
      );
      this.claimController(connection);
      connection.state = "ready";
      const controller = this.isController(connection);
      if (
        !this.send(connection, {
          version: TERMINAL_PROTOCOL_VERSION,
          type: "ready",
          connectionId: connection.id,
          streamId: connection.streamId,
          controller,
          reset: "full",
          heartbeatMs: TERMINAL_HEARTBEAT_MS,
        })
      )
        return;
      connection.announcedReady = true;
      if (!this.sendRuntimeMetadata(connection, this.metadata.get(connection.terminalId))) return;
      if (!this.isActive(connection)) return;
      connection.lastPongAt = Date.now();
      connection.heartbeat = setInterval(
        () => this.heartbeat(connection.id),
        TERMINAL_HEARTBEAT_MS,
      );
      connection.heartbeat.unref();
      if (!this.isActive(connection)) return;
      clientPty.resume();
      this.broadcastControl(connection.terminalId);
    } catch (error) {
      if (connection.state === "closed") return;
      this.send(connection, {
        version: TERMINAL_PROTOCOL_VERSION,
        type: "error",
        code: "ATTACH_FAILED",
        message: errorMessage(error),
        retryable: false,
      });
      this.disconnect(connection, 1011, "Terminal attachment failed");
    }
  }

  private handleReadyMessage(connection: ClientConnection, message: TerminalClientMessage): void {
    if (message.type === "pong") {
      if (message.nonce === connection.lastPingNonce) connection.lastPongAt = Date.now();
      return;
    }
    if (message.type === "output_ack") {
      this.acknowledgeOutput(connection, message.streamId, message.sequence);
      return;
    }
    if (message.type === "take_control") {
      this.takeControl(connection);
      return;
    }
    if (!this.isController(connection)) return;
    if (message.type === "input") connection.pty?.write(message.data);
    if (message.type === "binary") connection.pty?.write(Buffer.from(message.data, "binary"));
    if (message.type === "resize") connection.pty?.resize(message.cols, message.rows);
  }

  private sendRuntimeMetadata(
    connection: ClientConnection,
    metadata: TerminalRuntimeMetadata,
  ): boolean {
    return (
      this.send(connection, {
        version: TERMINAL_PROTOCOL_VERSION,
        type: "title",
        title: metadata.title ?? "",
      }) &&
      this.send(connection, {
        version: TERMINAL_PROTOCOL_VERSION,
        type: "progress",
        progress: metadata.progress,
      })
    );
  }

  private sendOutput(connection: ClientConnection, data: string): void {
    if (connection.state !== "ready" || !connection.streamId || !data) return;
    const sequence = connection.nextSequence++;
    const bytes = Buffer.byteLength(data);
    connection.outputBytes.set(sequence, bytes);
    connection.unacknowledgedBytes += bytes;
    if (
      !this.send(connection, {
        version: TERMINAL_PROTOCOL_VERSION,
        type: "output",
        streamId: connection.streamId,
        sequence,
        data,
      })
    )
      return;
    if (!connection.paused && connection.unacknowledgedBytes >= TERMINAL_OUTPUT_HIGH_WATERMARK) {
      connection.paused = true;
      connection.pty?.pause();
      this.restartStallTimeout(connection);
    }
  }

  private acknowledgeOutput(
    connection: ClientConnection,
    streamId: string,
    sequence: number,
  ): void {
    if (streamId !== connection.streamId || sequence >= connection.nextSequence) {
      this.protocolError(
        connection,
        "INVALID_ACK",
        "Invalid terminal output acknowledgement",
        1008,
      );
      return;
    }
    if (sequence <= connection.lastAckSequence) return;
    for (let current = connection.lastAckSequence + 1; current <= sequence; current += 1) {
      const bytes = connection.outputBytes.get(current);
      if (bytes !== undefined) {
        connection.unacknowledgedBytes = Math.max(0, connection.unacknowledgedBytes - bytes);
        connection.outputBytes.delete(current);
      }
    }
    connection.lastAckSequence = sequence;
    if (connection.paused && connection.unacknowledgedBytes <= TERMINAL_OUTPUT_LOW_WATERMARK) {
      connection.paused = false;
      if (connection.stallTimeout) clearTimeout(connection.stallTimeout);
      connection.stallTimeout = null;
      connection.pty?.resume();
    } else if (connection.paused) {
      this.restartStallTimeout(connection);
    }
  }

  private restartStallTimeout(connection: ClientConnection): void {
    if (connection.stallTimeout) clearTimeout(connection.stallTimeout);
    connection.stallTimeout = setTimeout(
      () => this.disconnect(connection, 1011, "Terminal output stalled"),
      TERMINAL_OUTPUT_STALL_TIMEOUT_MS,
    );
    connection.stallTimeout.unref();
  }

  private claimController(connection: ClientConnection): void {
    const clientId = connection.clientId!;
    const existing = this.controllers.get(connection.terminalId);
    if (existing && existing.expiresAt <= Date.now()) {
      if (existing.timer) clearTimeout(existing.timer);
      this.controllers.delete(connection.terminalId);
    }
    const lease = this.controllers.get(connection.terminalId);
    if (!lease) {
      this.controllers.set(connection.terminalId, {
        clientId,
        connectionId: connection.id,
        expiresAt: Number.POSITIVE_INFINITY,
        timer: null,
      });
      return;
    }
    if (lease.clientId !== clientId) return;
    const replaced = lease.connectionId;
    lease.connectionId = connection.id;
    lease.expiresAt = Number.POSITIVE_INFINITY;
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = null;
    if (replaced && replaced !== connection.id) {
      const old = this.clients.get(replaced);
      if (old) this.disconnect(old, 4001, "Replaced by reconnect");
    }
  }

  private takeControl(connection: ClientConnection): void {
    const previous = this.controllers.get(connection.terminalId);
    if (previous?.timer) clearTimeout(previous.timer);
    this.controllers.set(connection.terminalId, {
      clientId: connection.clientId!,
      connectionId: connection.id,
      expiresAt: Number.POSITIVE_INFINITY,
      timer: null,
    });
    this.broadcastControl(connection.terminalId);
    if (previous?.clientId !== connection.clientId)
      this.publishControllerChanged(connection.terminalId, connection.clientId);
  }

  private expireControllerLease(terminalId: string, clientId: string): void {
    const lease = this.controllers.get(terminalId);
    if (!lease || lease.clientId !== clientId || lease.connectionId) return;
    const replacement = [...this.clients.values()].find(
      (client) => client.terminalId === terminalId && client.state === "ready",
    );
    if (replacement) {
      lease.clientId = replacement.clientId!;
      lease.connectionId = replacement.id;
      lease.expiresAt = Number.POSITIVE_INFINITY;
      lease.timer = null;
    } else {
      this.controllers.delete(terminalId);
    }
    this.broadcastControl(terminalId);
    this.publishControllerChanged(terminalId, replacement?.clientId ?? null);
  }

  private isController(connection: ClientConnection): boolean {
    return this.controllers.get(connection.terminalId)?.connectionId === connection.id;
  }

  private heartbeat(connectionId: string): void {
    const connection = this.clients.get(connectionId);
    if (!connection || connection.state !== "ready") return;
    if (Date.now() - connection.lastPongAt >= TERMINAL_HEARTBEAT_TIMEOUT_MS) {
      this.disconnect(connection, 1001, "Heartbeat timed out");
      return;
    }
    const nonce = crypto.randomUUID();
    connection.lastPingNonce = nonce;
    this.send(connection, {
      version: TERMINAL_PROTOCOL_VERSION,
      type: "ping",
      nonce,
    });
  }

  private broadcastControl(terminalId: string): void {
    const lease = this.controllers.get(terminalId);
    for (const client of this.clients.values()) {
      if (client.terminalId === terminalId && client.state === "ready") {
        this.send(client, {
          version: TERMINAL_PROTOCOL_VERSION,
          type: "control",
          controller: lease?.connectionId === client.id,
        });
      }
    }
  }

  private isActive(connection: ClientConnection): boolean {
    return this.clients.get(connection.id) === connection && connection.state === "ready";
  }

  private publishControllerChanged(terminalId: string, controllerId: string | null): void {
    this.service.events.publish("terminal.controller_changed", {
      terminalId,
      controlled: controllerId !== null,
    });
  }

  private protocolError(
    connection: ClientConnection,
    code: string,
    message: string,
    closeCode: number,
  ): void {
    this.send(connection, {
      version: TERMINAL_PROTOCOL_VERSION,
      type: "error",
      code,
      message,
      retryable: false,
    });
    this.disconnect(connection, closeCode, message);
  }

  private send(connection: ClientConnection, message: TerminalServerMessage): boolean {
    if (connection.ws.readyState !== 1) {
      this.close(connection.id);
      return false;
    }
    try {
      connection.ws.send(JSON.stringify(message));
      return true;
    } catch {
      this.close(connection.id);
      return false;
    }
  }

  private disconnect(connection: ClientConnection, code: number, reason: string): void {
    try {
      connection.ws.close(code, reason.slice(0, 123));
    } catch {
      // Cleanup below is authoritative.
    }
    this.close(connection.id);
  }
}
