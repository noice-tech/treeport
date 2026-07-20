import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  controlAttachArgs,
  encodeControlInput,
  resizeControlClient,
  TmuxControlParser,
  type TmuxControlEvent,
} from "./tmux-control.js";

const enabled = process.env.WTR_REAL_INTEGRATION === "1";
const root = path.join(os.tmpdir(), `wtr control characterization ${process.pid}`);
const execute = promisify(execFile);
afterAll(async () => fs.rm(root, { recursive: true, force: true }));

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

describe.skipIf(!enabled)("real tmux control-mode characterization", () => {
  it("streams pane bytes, forwards input, resizes, and leaves the session alive", async (context) => {
    try {
      await execute("tmux", ["-V"]);
    } catch {
      context.skip();
      return;
    }

    await fs.mkdir(root, { recursive: true });
    const socket = `wtr-control-${process.pid}`;
    const session = "control-characterization";
    const configPath = path.join(root, "tmux.conf");
    await fs.writeFile(
      configPath,
      [
        'set -g default-terminal "tmux-256color"',
        'set -s terminal-features[999] "xterm-256color:hyperlinks"',
        "set -g extended-keys on",
        "set -s extended-keys-format csi-u",
        "set -g window-size latest",
        "set -g exit-empty off",
        "set -g remain-on-exit on",
        "",
      ].join("\n"),
    );
    const base = ["-L", socket, "-f", configPath];
    const program = [
      "process.stdin.setRawMode?.(true);",
      "process.stdin.resume();",
      "let pending = Buffer.alloc(0);",
      "process.stdin.on('data', data => {",
      "  pending = Buffer.concat([pending, data]);",
      "  if (pending.length < 13) return;",
      "  process.stdout.write(Buffer.from('\\x1b]8;;https://example.test\\x07LINK\\x1b]8;;\\x07|'));",
      "  process.stdout.write(pending);",
      "  process.stdout.write(Buffer.from('|END'));",
      "  pending = Buffer.alloc(0);",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("");

    await execute("tmux", [
      ...base,
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "80",
      "-y",
      "24",
      "--",
      process.execPath,
      "-e",
      program,
    ]);

    try {
      const paneId = (
        await execute("tmux", [...base, "display-message", "-p", "-t", session, "#{pane_id}"])
      ).stdout.trim();
      expect(paneId).toMatch(/^%\d+$/);

      const control = spawn("tmux", controlAttachArgs(socket, configPath, session), {
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key, value]) => value !== undefined && key !== "TMUX" && key !== "TMUX_PANE",
          ),
        ) as NodeJS.ProcessEnv,
      });
      const parser = new TmuxControlParser();
      const events: TmuxControlEvent[] = [];
      let parserError: Error | null = null;
      let stderr = "";
      control.stdout.on("data", (chunk: Buffer) => {
        try {
          events.push(...parser.push(chunk));
        } catch (error) {
          parserError = error as Error;
        }
      });
      control.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

      await waitFor(
        () =>
          events.some((event) => event.type === "notification" && event.name === "session-changed"),
        "control client did not attach",
      );

      const sent = Buffer.concat([
        Buffer.from([0x1b, 0x00]),
        Buffer.from("☃", "utf8"),
        Buffer.from([0x7f]),
        Buffer.from("\x1b[65;5u"),
      ]);
      for (const command of encodeControlInput(paneId, sent, 3)) control.stdin.write(command);

      const outputBytes = () =>
        Buffer.concat(
          events
            .filter(
              (event): event is Extract<TmuxControlEvent, { type: "output" }> =>
                event.type === "output" && event.paneId === paneId,
            )
            .map((event) => Buffer.from(event.data)),
        );
      await waitFor(
        () => outputBytes().includes(Buffer.from("|END")),
        "pane output did not arrive",
      );
      const output = outputBytes();
      expect(
        output.indexOf(Buffer.from("\x1b]8;;https://example.test\x07LINK\x1b]8;;\x07|")),
      ).toBeGreaterThanOrEqual(0);
      const start = output.indexOf(Buffer.from("LINK\x1b]8;;\x07|"));
      const echoed = output.subarray(start + Buffer.byteLength("LINK\x1b]8;;\x07|"));
      expect(echoed.subarray(0, sent.length)).toEqual(sent);

      control.stdin.write(resizeControlClient(91, 27));
      await waitFor(async () => {
        const size = (
          await execute("tmux", [
            ...base,
            "display-message",
            "-p",
            "-t",
            session,
            "#{window_width}x#{window_height}",
          ])
        ).stdout.trim();
        return size === "91x27";
      }, "control client resize was not applied");

      control.stdin.write("detach-client\n");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("control client did not exit")), 5_000);
        control.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(parserError).toBeNull();
      expect(stderr).toBe("");
      await expect(execute("tmux", [...base, "has-session", "-t", session])).resolves.toBeTruthy();
    } finally {
      await execute("tmux", [...base, "kill-server"]).catch(() => undefined);
    }
  });
});
