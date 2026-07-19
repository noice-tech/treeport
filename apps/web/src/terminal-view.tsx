import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalRecord } from "@wtr/shared";

interface TerminalViewProps {
  terminal: TerminalRecord | null;
  onStatusChange: () => void;
}

export function TerminalView({ terminal, onStatusChange }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const controllerRef = useRef(false);
  const [controller, setController] = useState(false);
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "reconnecting" | "closed"
  >("closed");
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !terminal) return;
    let disposed = false;
    let retry = 0;
    let reconnectTimer: number | null = null;
    const xterm = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 1.15,
      scrollback: 10_000,
      allowProposedApi: false,
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#67e8f9",
        selectionBackground: "#3f3f4666",
        black: "#18181b",
        red: "#fb7185",
        green: "#86efac",
        yellow: "#fde047",
        blue: "#7dd3fc",
        magenta: "#d8b4fe",
        cyan: "#67e8f9",
        white: "#f4f4f5",
      },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host);
    terminalRef.current = xterm;

    const sendResize = () => {
      try {
        fit.fit();
        if (controllerRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(
            JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }),
          );
        }
      } catch {
        // The host can be temporarily hidden while the mobile drawer animates.
      }
    };
    const resizeObserver = new ResizeObserver(sendResize);
    resizeObserver.observe(host);
    const input = xterm.onData((data) => {
      if (controllerRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    const connect = () => {
      if (disposed) return;
      setConnection(retry ? "reconnecting" : "connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/api/terminals/${terminal.id}/attach`,
      );
      socketRef.current = socket;
      socket.onopen = () => {
        retry = 0;
        setConnection("connected");
        sendResize();
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          data?: string;
          controller?: boolean;
          exitCode?: number | null;
          message?: string;
        };
        if (message.type === "output" && message.data) xterm.write(message.data);
        if (message.type === "control") {
          const hasControl = message.controller === true;
          controllerRef.current = hasControl;
          setController(hasControl);
          if (hasControl) window.setTimeout(sendResize, 0);
        }
        if (message.type === "exit") {
          setExitCode(message.exitCode ?? null);
          onStatusChange();
        }
        if (message.type === "error")
          xterm.writeln(`\r\n\x1b[31m${message.message || "Attachment error"}\x1b[0m`);
      };
      socket.onclose = () => {
        if (disposed) return;
        controllerRef.current = false;
        setController(false);
        setConnection("reconnecting");
        retry += 1;
        reconnectTimer = window.setTimeout(
          connect,
          Math.min(10_000, 500 * 2 ** Math.min(retry, 5)),
        );
      };
    };
    connect();
    window.setTimeout(sendResize, 0);
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      input.dispose();
      controllerRef.current = false;
      socketRef.current?.close();
      socketRef.current = null;
      terminalRef.current = null;
      xterm.dispose();
    };
  }, [terminal?.id]);

  const sendInput = (value: string) => {
    let data = value;
    if (ctrl && value.length === 1)
      data = String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31);
    if (alt) data = `\u001b${data}`;
    if (socketRef.current?.readyState === WebSocket.OPEN)
      socketRef.current.send(JSON.stringify({ type: "input", data }));
    setCtrl(false);
    setAlt(false);
    terminalRef.current?.focus();
  };

  if (!terminal) {
    return (
      <main className="empty-state">
        <div>
          <p className="eyebrow">No terminal selected</p>
          <h1>Choose a terminal from the worktree drawer.</h1>
          <p>Live processes stay inside app-owned tmux servers when this browser closes.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="terminal-shell" aria-label={`${terminal.name} terminal`}>
      <header className="terminal-header">
        <div className="terminal-title">
          <strong>{terminal.name}</strong>
          <span className={`connection-dot ${connection}`} aria-hidden="true" />
          <span>{connection}</span>
          {exitCode !== undefined && <span className="exit-label">exited {exitCode ?? "—"}</span>}
        </div>
        <div className="control-state">
          <span className={controller ? "control-badge active" : "control-badge"}>
            {controller ? "Control" : "View only"}
          </span>
          {!controller && (
            <button
              type="button"
              className="button button-small"
              onClick={() => socketRef.current?.send(JSON.stringify({ type: "take_control" }))}
            >
              Take control
            </button>
          )}
        </div>
      </header>
      <div className="xterm-host" ref={hostRef} />
      <div className="accessory-row" aria-label="Terminal accessory keys">
        <button type="button" onClick={() => sendInput("\u001b")}>
          Esc
        </button>
        <button
          type="button"
          className={ctrl ? "latched" : ""}
          onClick={() => setCtrl((value) => !value)}
        >
          Ctrl
        </button>
        <button
          type="button"
          className={alt ? "latched" : ""}
          onClick={() => setAlt((value) => !value)}
        >
          Alt
        </button>
        <button type="button" onClick={() => sendInput("\t")}>
          Tab
        </button>
        <button type="button" onClick={() => sendInput("\r")}>
          Enter
        </button>
        <button type="button" aria-label="Arrow left" onClick={() => sendInput("\u001b[D")}>
          ←
        </button>
        <button type="button" aria-label="Arrow up" onClick={() => sendInput("\u001b[A")}>
          ↑
        </button>
        <button type="button" aria-label="Arrow down" onClick={() => sendInput("\u001b[B")}>
          ↓
        </button>
        <button type="button" aria-label="Arrow right" onClick={() => sendInput("\u001b[C")}>
          →
        </button>
      </div>
    </main>
  );
}
