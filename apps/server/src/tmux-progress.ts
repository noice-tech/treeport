import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseTerminalProgress, type TerminalProgress } from "@tasktty/shared";
import { TmuxControlParser } from "./tmux-control.js";

const ESC = 0x1b;
const BEL = 0x07;
const OSC = 0x9d;
const ST = 0x9c;
const MAX_OSC_BYTES = 64;

type ParserState = "ground" | "escape" | "osc" | "osc_escape";

/** Extracts OSC 9;4 progress updates from an arbitrary stream of terminal bytes. */
export class TerminalProgressParser {
  private state: ParserState = "ground";
  private osc: number[] = [];

  push(data: Uint8Array): Array<TerminalProgress | null> {
    const progress: Array<TerminalProgress | null> = [];
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
        if (byte === BEL || byte === ST) this.finishOsc(progress);
        else if (byte === ESC) this.state = "osc_escape";
        else this.appendOsc(byte);
        continue;
      }

      if (byte === 0x5c || byte === ST || byte === BEL) {
        this.finishOsc(progress);
      } else if (byte === ESC) {
        this.appendOsc(ESC);
      } else if (this.appendOsc(ESC) && this.appendOsc(byte)) {
        this.state = "osc";
      }
    }
    return progress;
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

  private finishOsc(progress: Array<TerminalProgress | null>): void {
    if (this.osc[0] === 0x39 && this.osc[1] === 0x3b) {
      const data = Buffer.from(this.osc.slice(2)).toString("ascii");
      const parsed = parseTerminalProgress(data);
      if (parsed !== undefined) progress.push(parsed);
    }
    this.osc = [];
    this.state = "ground";
  }
}

export interface TmuxProgressObserverOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
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
  private readonly progressParser = new TerminalProgressParser();
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
        for (const progress of this.progressParser.push(event.data))
          this.options.onProgress(progress);
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
