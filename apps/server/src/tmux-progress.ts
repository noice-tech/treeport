import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseTerminalProgress, type TerminalProgress } from "@tasktty/shared";
import { TmuxControlParser } from "./tmux-control.js";

const ESC = 0x1b;
const BEL = 0x07;
const OSC = 0x9d;
const ST = 0x9c;
const MAX_OSC_BYTES = 1024;

type ParserState = "ground" | "escape" | "osc" | "osc_escape";
export type TerminalMetadataUpdate =
  | { type: "title"; title: string }
  | { type: "progress"; progress: TerminalProgress | null };

/** Extracts title and OSC 9;4 progress metadata from arbitrary terminal bytes. */
export class TerminalMetadataParser {
  private state: ParserState = "ground";
  private osc: number[] = [];

  push(data: Uint8Array): TerminalMetadataUpdate[] {
    const updates: TerminalMetadataUpdate[] = [];
    for (const byte of data) {
      if (this.state === "ground") {
        if (byte === ESC) this.state = "escape";
        else if (byte === OSC) this.startOsc();
        continue;
      }

      if (this.state === "escape") {
        if (byte === 0x5d) this.startOsc();
        else this.state = byte === ESC ? "escape" : "ground";
        continue;
      }

      if (this.state === "osc") {
        if (byte === BEL || byte === ST) this.finishOsc(updates);
        else if (byte === ESC) this.state = "osc_escape";
        else this.appendOsc(byte);
        continue;
      }

      if (byte === 0x5c || byte === ST || byte === BEL) {
        this.finishOsc(updates);
      } else if (byte === 0x5d) {
        this.startOsc();
      } else if (byte === ESC) {
        this.appendOsc(ESC);
      } else if (this.appendOsc(ESC) && this.appendOsc(byte)) {
        this.state = "osc";
      }
    }
    return updates;
  }

  private startOsc(): void {
    this.state = "osc";
    this.osc = [];
  }

  private appendOsc(byte: number): boolean {
    this.osc.push(byte);
    if (this.osc.length <= MAX_OSC_BYTES) return true;
    this.osc = [];
    this.state = "ground";
    return false;
  }

  private finishOsc(updates: TerminalMetadataUpdate[]): void {
    const separator = this.osc.indexOf(0x3b);
    if (separator > 0) {
      const command = Buffer.from(this.osc.slice(0, separator)).toString("ascii");
      const payload = this.osc.slice(separator + 1);
      if (command === "9") {
        const parsed = parseTerminalProgress(Buffer.from(payload).toString("ascii"));
        if (parsed !== undefined) updates.push({ type: "progress", progress: parsed });
      } else if (command === "0" || command === "2") {
        updates.push({ type: "title", title: Buffer.from(payload).toString("utf8") });
      }
    }
    this.osc = [];
    this.state = "ground";
  }
}

/** Backwards-compatible progress-only parser used by focused protocol tests. */
export class TerminalProgressParser {
  private readonly parser = new TerminalMetadataParser();

  push(data: Uint8Array): Array<TerminalProgress | null> {
    return this.parser
      .push(data)
      .filter(
        (update): update is Extract<TerminalMetadataUpdate, { type: "progress" }> =>
          update.type === "progress",
      )
      .map((update) => update.progress);
  }
}

export interface TmuxProgressObserverOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onTitle?: (title: string) => void;
  onProgress: (progress: TerminalProgress | null) => void;
  onExit: () => void;
}

export interface TerminalProgressObserver {
  dispose(): void;
}

export type TerminalProgressObserverFactory = (
  options: TmuxProgressObserverOptions,
) => TerminalProgressObserver;

type ProcessSpawner = typeof spawn;

export class TmuxProgressObserver implements TerminalProgressObserver {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly controlParser = new TmuxControlParser();
  private readonly metadataParser = new TerminalMetadataParser();
  private disposed = false;

  constructor(
    private readonly options: TmuxProgressObserverOptions,
    spawnProcess: ProcessSpawner = spawn,
  ) {
    this.process = spawnProcess(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.process.stderr.resume();
    this.process.once("error", () => this.stop(true));
    this.process.once("exit", () => this.stop(true));
  }

  dispose(): void {
    this.stop(false);
  }

  private handleData(chunk: Buffer): void {
    if (this.disposed) return;
    try {
      for (const event of this.controlParser.push(chunk)) {
        if (event.type !== "output") continue;
        for (const update of this.metadataParser.push(event.data)) {
          if (update.type === "title") this.options.onTitle?.(update.title);
          else this.options.onProgress(update.progress);
        }
      }
    } catch {
      this.stop(true);
    }
  }

  private stop(notify: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.process.kill();
    } catch {
      // The control client may already have exited.
    }
    if (notify) this.options.onExit();
  }
}

export const createTmuxProgressObserver: TerminalProgressObserverFactory = (options) =>
  new TmuxProgressObserver(options);
