import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  parseTerminalProgress,
  parseTerminalServerMessage,
  TERMINAL_HEARTBEAT_TIMEOUT_MS,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalClientMessage,
  type TerminalProgress,
} from "@tasktty/shared";

export { parseTerminalProgress, type TerminalProgress } from "@tasktty/shared";

type ConnectionPhase = "connecting" | "ready" | "reconnecting" | "closed";
export type ArrowDirection = "up" | "down" | "left" | "right";

const TERMINAL_SCROLL_EXIT_SEQUENCE = "\u001b[9000~";

export function terminalProgressLabel(progress: TerminalProgress): string {
  const percentage = progress.value === null ? "" : `, ${progress.value}% complete`;
  if (progress.state === "error") return `progress error${percentage}`;
  if (progress.state === "paused") return `progress paused${percentage}`;
  return progress.value === null ? "working" : `${progress.value}% complete`;
}

type TerminalKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "isComposing" | "key" | "metaKey" | "shiftKey" | "type"
>;

export function terminalKeyboardInput(
  event: TerminalKeyboardEvent,
  applicationCursorKeysMode = false,
): string | null {
  if (event.type !== "keydown" || event.isComposing || event.altKey || event.ctrlKey) return null;
  if (event.key === "Enter" && event.shiftKey && !event.metaKey) return "\u001b[13;2u";
  if (!event.metaKey || event.shiftKey) return null;
  const prefix = applicationCursorKeysMode ? "\u001bO" : "\u001b[";
  if (event.key === "ArrowLeft") return `${prefix}H`;
  if (event.key === "ArrowRight") return `${prefix}F`;
  return null;
}

function usesMacKeyboard(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function forcePlainSelectionWhileMouseReporting(event: MouseEvent): void {
  const wrapper = event.currentTarget;
  if (
    !(wrapper instanceof Element) ||
    !wrapper.querySelector(".xterm.enable-mouse-events") ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return;
  Object.defineProperty(event, usesMacKeyboard() ? "altKey" : "shiftKey", {
    configurable: true,
    value: true,
  });
}

function trackTerminalScrolling(
  wrapper: HTMLElement,
  onScroll: () => void,
  onResumeInput: () => void,
): void {
  wrapper.addEventListener(
    "wheel",
    () => {
      wrapper.classList.add("terminal-scrolling");
      onScroll();
    },
    { capture: true, passive: true },
  );
  wrapper.addEventListener("paste", onResumeInput, true);
}

export interface TerminalSessionSnapshot {
  phase: ConnectionPhase;
  degraded: boolean;
  controller: boolean;
  title: string | null;
  bellActive: boolean;
  bellSerial: number;
  exitSerial: number;
  progress: TerminalProgress | null;
  error: string | null;
}

const DEFAULT_SNAPSHOT: TerminalSessionSnapshot = {
  phase: "closed",
  degraded: false,
  controller: false,
  title: null,
  bellActive: false,
  bellSerial: 0,
  exitSerial: 0,
  progress: null,
  error: null,
};

let fallbackClientId: string | null = null;
function getClientId(): string {
  if (fallbackClientId) return fallbackClientId;
  try {
    const stored = sessionStorage.getItem("tasktty-terminal-client-id");
    if (stored) return (fallbackClientId = stored);
    const created = crypto.randomUUID();
    sessionStorage.setItem("tasktty-terminal-client-id", created);
    return (fallbackClientId = created);
  } catch {
    return (fallbackClientId = crypto.randomUUID());
  }
}

export function terminalOptions() {
  return {
    cursorBlink: true,
    convertEol: false,
    fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace',
    fontSize: 14,
    lineHeight: 1.15,
    scrollback: 10_000,
    allowProposedApi: false,
    macOptionClickForcesSelection: true,
    linkHandler: {
      activate(event: MouseEvent, url: string) {
        if (!event.metaKey && !event.ctrlKey) return;
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
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
  } as const;
}

export class TerminalSession {
  readonly terminalId: string;
  private readonly listeners = new Set<() => void>();
  private snapshotValue: TerminalSessionSnapshot = DEFAULT_SNAPSHOT;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private wrapper: HTMLDivElement | null = null;
  private host: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private socket: WebSocket | null = null;
  private retryTimer: number | null = null;
  private degradedTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private bellTimer: number | null = null;
  private resizeFrame: number | null = null;
  private progressHandler: { dispose(): void } | null = null;
  private disposed = false;
  private opened = false;
  private ready = false;
  private retryAttempt = 0;
  private reconnectAllowed = true;
  private streamId: string | null = null;
  private expectedSequence = 1;
  private lastParsedSequence = 0;
  private readonly parsedSequences = new Set<number>();
  private scrollExitPending = false;
  private resumeOnNextInput = false;
  private lastBellAt = 0;
  private listeningForReconnect = false;
  private readonly reconnectNow = () => {
    if (this.disposed || !this.reconnectAllowed || this.ready || this.socket) return;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  };
  private readonly reconnectWhenVisible = () => {
    if (document.visibilityState === "visible") this.reconnectNow();
  };

  constructor(terminalId: string) {
    this.terminalId = terminalId;
  }

  getSnapshot = (): TerminalSessionSnapshot => this.snapshotValue;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mount(host: HTMLElement): void {
    if (this.disposed) return;
    this.host = host;
    if (!this.listeningForReconnect) {
      window.addEventListener("online", this.reconnectNow);
      document.addEventListener("visibilitychange", this.reconnectWhenVisible);
      this.listeningForReconnect = true;
    }
    if (!this.wrapper) {
      this.wrapper = document.createElement("div");
      this.wrapper.className = "terminal-session-host h-full min-h-0 min-w-0";
    }
    host.appendChild(this.wrapper);
    if (!this.opened) this.openTerminal();
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(host);
    this.scheduleFit();
    if (!this.socket && this.opened) this.connect();
  }

  unmount(host: HTMLElement): void {
    if (this.host !== host) return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.wrapper?.remove();
    this.host = null;
  }

  focus(): void {
    this.terminal?.focus();
  }

  takeControl(): void {
    this.send({ version: TERMINAL_PROTOCOL_VERSION, type: "take_control" });
  }

  retry(): void {
    if (this.disposed || this.ready) return;
    this.reconnectAllowed = true;
    this.retryAttempt = 0;
    this.update({ error: null, phase: "connecting", degraded: false });
    this.connect();
  }

  sendText(data: string): void {
    this.prepareScrollExit();
    this.terminal?.input(data, true);
    this.focus();
  }

  sendArrow(direction: ArrowDirection, alt = false): void {
    const final = { up: "A", down: "B", right: "C", left: "D" }[direction];
    const prefix = this.terminal?.modes.applicationCursorKeysMode ? "\u001bO" : "\u001b[";
    this.sendText(`${alt ? "\u001b" : ""}${prefix}${final}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reconnectAllowed = false;
    this.clearTimers();
    this.resizeObserver?.disconnect();
    if (this.listeningForReconnect) {
      window.removeEventListener("online", this.reconnectNow);
      document.removeEventListener("visibilitychange", this.reconnectWhenVisible);
      this.listeningForReconnect = false;
    }
    this.socket?.close(1000, "Session disposed");
    this.socket = null;
    this.wrapper?.remove();
    this.progressHandler?.dispose();
    this.progressHandler = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.wrapper = null;
    this.listeners.clear();
  }

  private openTerminal(): void {
    if (!this.wrapper || this.opened) return;
    const terminal = new Terminal(terminalOptions());
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(this.wrapper);
    this.wrapper.addEventListener("mousedown", forcePlainSelectionWhileMouseReporting, true);
    trackTerminalScrolling(
      this.wrapper,
      () => {
        this.scrollExitPending = true;
      },
      () => this.prepareScrollExit(),
    );
    this.terminal = terminal;
    this.fitAddon = fitAddon;
    this.opened = true;
    terminal.attachCustomKeyEventHandler((event) => {
      const input = terminalKeyboardInput(event, terminal.modes.applicationCursorKeysMode);
      if (input === null) return true;
      event.preventDefault();
      event.stopPropagation();
      this.prepareScrollExit();
      terminal.input(input, true);
      return false;
    });
    terminal.onKey(() => this.prepareScrollExit());
    terminal.onData((data) => {
      if (this.ready && this.snapshotValue.controller)
        this.send({
          version: TERMINAL_PROTOCOL_VERSION,
          type: "input",
          data: this.withScrollExit(data),
        });
    });
    terminal.onBinary((data) => {
      if (this.ready && this.snapshotValue.controller)
        this.send({
          version: TERMINAL_PROTOCOL_VERSION,
          type: "binary",
          data: this.withScrollExit(data),
        });
    });
    terminal.onTitleChange((title) => this.update({ title: title.trim().slice(0, 256) }));
    terminal.onBell(() => this.handleBell());
    this.progressHandler = terminal.parser.registerOscHandler(9, (data) => {
      const progress = parseTerminalProgress(data);
      if (progress === undefined) return false;
      this.handleProgress(progress);
      return true;
    });
  }

  private prepareScrollExit(): void {
    if (this.scrollExitPending) this.resumeOnNextInput = true;
  }

  private withScrollExit(data: string): string {
    if (!this.resumeOnNextInput) return data;
    this.scrollExitPending = false;
    this.resumeOnNextInput = false;
    this.wrapper?.classList.remove("terminal-scrolling");
    return `${TERMINAL_SCROLL_EXIT_SEQUENCE}${data}`;
  }

  private connect(): void {
    if (this.disposed || !this.reconnectAllowed || this.socket) return;
    this.ready = false;
    this.update({
      phase: this.retryAttempt ? "reconnecting" : "connecting",
      controller: false,
      error: null,
    });
    this.startDegradedTimer();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/api/terminals/${this.terminalId}/attach`,
    );
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.fit();
      this.send({
        version: TERMINAL_PROTOCOL_VERSION,
        type: "hello",
        clientId: getClientId(),
        cols: this.terminal?.cols ?? 100,
        rows: this.terminal?.rows ?? 30,
      });
      this.resetHeartbeatDeadline();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleServerMessage(String(event.data));
    };
    socket.onerror = () => {
      // close drives retry and preserves one state transition.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.streamId = null;
      this.clearHeartbeat();
      if (!this.reconnectAllowed) this.clearDegraded();
      this.update({
        phase: this.reconnectAllowed && !this.disposed ? "reconnecting" : "closed",
        controller: false,
        degraded: this.reconnectAllowed ? this.snapshotValue.degraded : false,
        progress: null,
      });
      if (this.reconnectAllowed && !this.disposed) this.scheduleReconnect();
    };
  }

  private handleServerMessage(raw: string): void {
    this.resetHeartbeatDeadline();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.failProtocol("The terminal server sent invalid JSON");
      return;
    }
    const message = parseTerminalServerMessage(value);
    if (!message) {
      this.failProtocol("The terminal server sent an invalid message");
      return;
    }
    if (message.type === "ready") {
      this.terminal?.reset();
      this.streamId = message.streamId;
      this.expectedSequence = 1;
      this.lastParsedSequence = 0;
      this.parsedSequences.clear();
      this.ready = true;
      this.retryAttempt = 0;
      this.clearDegraded();
      this.update({ phase: "ready", controller: message.controller, progress: null, error: null });
      this.scheduleFit();
      return;
    }
    if (message.type === "ping") {
      this.send({ version: TERMINAL_PROTOCOL_VERSION, type: "pong", nonce: message.nonce });
      return;
    }
    if (message.type === "output") {
      this.handleOutput(message.streamId, message.sequence, message.data);
      return;
    }
    if (message.type === "title") {
      this.update({ title: message.title.trim().slice(0, 256) });
      return;
    }
    if (message.type === "progress") {
      this.handleProgress(message.progress);
      return;
    }
    if (message.type === "control") {
      this.update({ controller: message.controller });
      if (message.controller) this.scheduleFit();
      return;
    }
    if (message.type === "exit") {
      this.update({ exitSerial: this.snapshotValue.exitSerial + 1, progress: null });
      return;
    }
    if (message.type === "error") {
      this.reconnectAllowed = message.retryable;
      this.terminal?.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
      if (message.retryable) this.update({ error: message.message });
      else this.stopWithError(message.message);
    }
  }

  private handleProgress(progress: TerminalProgress | null): void {
    const current = this.snapshotValue.progress;
    if (current?.state === progress?.state && current?.value === progress?.value) return;
    this.update({ progress });
  }

  private handleOutput(streamId: string, sequence: number, data: string): void {
    if (!this.ready || streamId !== this.streamId || sequence !== this.expectedSequence) {
      this.failProtocol("Terminal output arrived out of order");
      return;
    }
    this.expectedSequence += 1;
    this.terminal?.write(data, () => {
      if (!this.ready || streamId !== this.streamId) return;
      this.parsedSequences.add(sequence);
      while (this.parsedSequences.delete(this.lastParsedSequence + 1)) this.lastParsedSequence += 1;
      this.send({
        version: TERMINAL_PROTOCOL_VERSION,
        type: "output_ack",
        streamId,
        sequence: this.lastParsedSequence,
      });
    });
  }

  private send(message: TerminalClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private scheduleFit(): void {
    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.fit();
    });
  }

  private fit(): void {
    if (!this.host || !this.fitAddon || !this.terminal) return;
    try {
      this.fitAddon.fit();
      if (this.ready && this.snapshotValue.controller) {
        this.send({
          version: TERMINAL_PROTOCOL_VERSION,
          type: "resize",
          cols: this.terminal.cols,
          rows: this.terminal.rows,
        });
      }
    } catch {
      // Hidden/mobile transition hosts can temporarily have no dimensions.
    }
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== null) return;
    this.retryAttempt += 1;
    const cap = Math.min(10_000, 500 * 2 ** Math.min(this.retryAttempt, 5));
    const delay = cap / 2 + Math.random() * (cap / 2);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private resetHeartbeatDeadline(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = window.setTimeout(() => {
      this.heartbeatTimer = null;
      this.socket?.close(1001, "Heartbeat timed out");
    }, TERMINAL_HEARTBEAT_TIMEOUT_MS + 5_000);
  }

  private startDegradedTimer(): void {
    if (this.degradedTimer !== null) return;
    this.degradedTimer = window.setTimeout(() => {
      this.degradedTimer = null;
      if (!this.ready) this.update({ degraded: true });
    }, 500);
  }

  private clearDegraded(): void {
    if (this.degradedTimer !== null) window.clearTimeout(this.degradedTimer);
    this.degradedTimer = null;
    this.update({ degraded: false });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handleBell(): void {
    const now = Date.now();
    if (now - this.lastBellAt < 1_000) return;
    this.lastBellAt = now;
    if (this.bellTimer !== null) window.clearTimeout(this.bellTimer);
    this.update({
      bellActive: true,
      bellSerial: this.snapshotValue.bellSerial + 1,
    });
    this.bellTimer = window.setTimeout(() => {
      this.bellTimer = null;
      this.update({ bellActive: false });
    }, 180);
  }

  private failProtocol(message: string): void {
    this.reconnectAllowed = false;
    this.stopWithError(message);
    this.socket?.close(1002, message.slice(0, 123));
  }

  private stopWithError(message: string): void {
    this.ready = false;
    this.clearHeartbeat();
    this.clearDegraded();
    this.update({
      error: message,
      phase: "closed",
      degraded: false,
      controller: false,
      progress: null,
    });
  }

  private update(patch: Partial<TerminalSessionSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.degradedTimer !== null) window.clearTimeout(this.degradedTimer);
    if (this.heartbeatTimer !== null) window.clearTimeout(this.heartbeatTimer);
    if (this.bellTimer !== null) window.clearTimeout(this.bellTimer);
    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
    this.retryTimer = null;
    this.degradedTimer = null;
    this.heartbeatTimer = null;
    this.bellTimer = null;
    this.resizeFrame = null;
  }
}

interface SessionEntry {
  session: TerminalSession;
  references: number;
  lastUsed: number;
  idleTimer: number | null;
  lastBellSerial: number;
  lastTitle: string | null;
  lastProgress: TerminalProgress | null;
  unsubscribe: () => void;
}

export class TerminalSessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly listeners = new Set<() => void>();
  private attentionSnapshot: ReadonlySet<string> = new Set();
  private titleSnapshot: ReadonlyMap<string, string> = new Map();
  private progressSnapshot: ReadonlyMap<string, TerminalProgress> = new Map();

  constructor(
    private readonly maxSessions = 3,
    private readonly idleMs = 5 * 60_000,
    private readonly createSession: (terminalId: string) => TerminalSession = (terminalId) =>
      new TerminalSession(terminalId),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getAttentionSnapshot = (): ReadonlySet<string> => this.attentionSnapshot;
  getTitleSnapshot = (): ReadonlyMap<string, string> => this.titleSnapshot;
  getProgressSnapshot = (): ReadonlyMap<string, TerminalProgress> => this.progressSnapshot;

  acquire(terminalId: string): TerminalSession {
    let entry = this.entries.get(terminalId);
    if (!entry) {
      const session = this.createSession(terminalId);
      entry = {
        session,
        references: 0,
        lastUsed: Date.now(),
        idleTimer: null,
        lastBellSerial: session.getSnapshot().bellSerial,
        lastTitle: session.getSnapshot().title,
        lastProgress: session.getSnapshot().progress,
        unsubscribe: () => undefined,
      };
      const observedEntry = entry;
      entry.unsubscribe = session.subscribe(() => {
        const snapshot = session.getSnapshot();
        if (snapshot.bellSerial > observedEntry.lastBellSerial) {
          observedEntry.lastBellSerial = snapshot.bellSerial;
          if (observedEntry.references === 0) this.markAttention(terminalId);
        }
        if (snapshot.title !== observedEntry.lastTitle) {
          observedEntry.lastTitle = snapshot.title;
          this.setRuntimeTitle(terminalId, snapshot.title);
        }
        if (snapshot.progress !== observedEntry.lastProgress) {
          observedEntry.lastProgress = snapshot.progress;
          this.setProgress(terminalId, snapshot.progress);
        }
      });
      this.entries.set(terminalId, entry);
      if (entry.lastTitle) this.setRuntimeTitle(terminalId, entry.lastTitle);
      if (entry.lastProgress) this.setProgress(terminalId, entry.lastProgress);
    }
    this.clearAttention(terminalId);
    entry.references += 1;
    entry.lastUsed = Date.now();
    if (entry.idleTimer !== null) window.clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    this.evictOverCapacity(terminalId);
    return entry.session;
  }

  release(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    entry.references = Math.max(0, entry.references - 1);
    entry.lastUsed = Date.now();
    if (entry.references === 0 && entry.idleTimer === null) {
      entry.idleTimer = window.setTimeout(() => this.evictSession(terminalId), this.idleMs);
    }
  }

  forget(terminalId: string): void {
    this.disposeEntry(terminalId);
    this.clearRuntimeTitle(terminalId);
  }

  clearAttention(terminalId: string): void {
    if (!this.attentionSnapshot.has(terminalId)) return;
    const next = new Set(this.attentionSnapshot);
    next.delete(terminalId);
    this.attentionSnapshot = next;
    this.emit();
  }

  reconcile(terminals: Iterable<{ id: string }>): void {
    const valid = new Set([...terminals].map((terminal) => terminal.id));
    for (const terminalId of this.entries.keys()) {
      if (!valid.has(terminalId)) this.disposeEntry(terminalId);
    }
    let changed = false;
    const titles = new Map(this.titleSnapshot);
    for (const terminalId of titles.keys()) {
      if (!valid.has(terminalId)) {
        titles.delete(terminalId);
        changed = true;
      }
    }
    if (changed) {
      this.titleSnapshot = titles;
      this.emit();
    }
  }

  private setRuntimeTitle(terminalId: string, value: string | null): void {
    const title = value?.trim().slice(0, 256) || null;
    if (title === null) {
      this.clearRuntimeTitle(terminalId);
      return;
    }
    if (this.titleSnapshot.get(terminalId) === title) return;
    this.titleSnapshot = new Map(this.titleSnapshot).set(terminalId, title);
    this.emit();
  }

  private clearRuntimeTitle(terminalId: string): void {
    if (!this.titleSnapshot.has(terminalId)) return;
    const titles = new Map(this.titleSnapshot);
    titles.delete(terminalId);
    this.titleSnapshot = titles;
    this.emit();
  }

  private markAttention(terminalId: string): void {
    if (this.attentionSnapshot.has(terminalId)) return;
    this.attentionSnapshot = new Set([...this.attentionSnapshot, terminalId]);
    this.emit();
  }

  private setProgress(terminalId: string, progress: TerminalProgress | null): void {
    const current = this.progressSnapshot.get(terminalId);
    if (progress && current?.state === progress.state && current.value === progress.value) return;
    if (!progress && !current) return;
    const next = new Map(this.progressSnapshot);
    if (progress) next.set(terminalId, progress);
    else next.delete(terminalId);
    this.progressSnapshot = next;
    this.emit();
  }

  private evictSession(terminalId: string): void {
    this.disposeEntry(terminalId);
  }

  private disposeEntry(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    if (entry.idleTimer !== null) window.clearTimeout(entry.idleTimer);
    entry.unsubscribe();
    entry.session.dispose();
    this.entries.delete(terminalId);
    this.clearAttention(terminalId);
    this.setProgress(terminalId, null);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  private evictOverCapacity(selectedId: string): void {
    while (this.entries.size > this.maxSessions) {
      const candidate = [...this.entries.entries()]
        .filter(([id, entry]) => id !== selectedId && entry.references === 0)
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (!candidate) return;
      this.evictSession(candidate[0]);
    }
  }
}

export const terminalSessions = new TerminalSessionManager();
