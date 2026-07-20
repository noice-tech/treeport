import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRequest, CommandResult, CommandRunner } from "./command.js";
import { generateTmuxSessionName, generateTmuxSocketName, TmuxAdapter } from "./tmux.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  ),
);

class RecordingRunner implements CommandRunner {
  readonly calls: CommandRequest[] = [];
  responses: CommandResult[] = [];
  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    return this.responses.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("TmuxAdapter", () => {
  it("generates application-owned identifiers independent of branch names", () => {
    expect(generateTmuxSocketName()).toMatch(/^wtr-wt-[a-f0-9]{16}$/);
    expect(generateTmuxSessionName()).toMatch(/^wtr-term-[a-f0-9]{16}$/);
    expect(generateTmuxSocketName()).not.toBe(generateTmuxSocketName());
  });

  it("reloads the complete generated config for new and existing servers", async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "wtr-runtime-"));
    temporary.push(runtime);
    const runner = new RecordingRunner();
    const adapter = new TmuxAdapter(runner, runtime);
    await adapter.initialize();
    const config = await fs.readFile(adapter.configPath, "utf8");
    expect(config).toContain("set -g mouse on");
    expect(config).toContain("set -g extended-keys on");
    expect(config).toContain("set -s extended-keys-format csi-u");
    expect(config).toContain('set -s terminal-features[999] "xterm-256color:hyperlinks"');

    await adapter.configureServer("socket");
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["-L", "socket", "-f", adapter.configPath, "source-file", adapter.configPath],
    ]);
  });

  it("preserves hostile and Unicode argv in a JSON launch spec without a shell", async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "wtr runtime "));
    temporary.push(runtime);
    const runner = new RecordingRunner();
    const launcher = "/application owned/path with spaces/launcher.js";
    const adapter = new TmuxAdapter(runner, runtime, "/tmux path/tmux", launcher);
    const argv = [
      "tool with spaces",
      'a "quote"',
      "semi;colon",
      "$HOME",
      "snowman ☃",
      "single'quote",
    ];
    await adapter.createSession({
      socketName: "wtr-wt-safe",
      sessionName: "wtr-term-safe",
      terminalId: "term_safe",
      worktreeId: "wt_safe",
      cwd: "/repo with spaces",
      argv,
      env: { WTR_TERMINAL_ID: "term_safe" },
      setupTasks: [
        {
          label: "install ☃",
          argv: ["tool with spaces", "semi;colon", "$HOME", "single'quote"],
          cwd: "/repo with spaces/setup",
          env: { HOSTILE: 'a "quote"' },
          timeoutMs: 1234,
        },
      ],
    });
    const create = runner.calls.find((call) => call.args.includes("new-session"));
    expect(create?.executable).toBe("/tmux path/tmux");
    expect(create?.args.slice(-3, -1)).toEqual([process.execPath, launcher]);
    const specPath = create?.args.at(-1);
    expect(specPath).toBeTruthy();
    const spec = JSON.parse(await fs.readFile(specPath!, "utf8")) as {
      argv: string[];
      cwd: string;
      setupTasks: Array<{
        label: string;
        argv: string[];
        cwd: string;
        env: Record<string, string>;
        timeoutMs: number;
      }>;
    };
    expect(spec.argv).toEqual(argv);
    expect(spec.cwd).toBe("/repo with spaces");
    expect(spec.setupTasks).toEqual([
      {
        label: "install ☃",
        argv: ["tool with spaces", "semi;colon", "$HOME", "single'quote"],
        cwd: "/repo with spaces/setup",
        env: { HOSTILE: 'a "quote"' },
        timeoutMs: 1234,
      },
    ]);
    expect(create?.args).not.toContain(argv.join(" "));
    expect(create?.args).not.toContain(spec.setupTasks[0]!.argv.join(" "));
  });

  it("kills a newly created session when metadata setup fails", async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "wtr-runtime-"));
    temporary.push(runtime);
    const runner = new RecordingRunner();
    runner.responses.push(
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "metadata failed", exitCode: 1 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "no sessions", exitCode: 1 },
      { stdout: "", stderr: "no server running", exitCode: 1 },
    );
    const adapter = new TmuxAdapter(runner, runtime, "tmux", "/launcher.js");
    await expect(
      adapter.createSession({
        socketName: "socket",
        sessionName: "session",
        terminalId: "term",
        worktreeId: "wt",
        cwd: "/tmp",
        argv: ["pi"],
        env: {},
      }),
    ).rejects.toThrow(/metadata failed/);
    expect(runner.calls.some((call) => call.args.includes("kill-session"))).toBe(true);
  });

  it("reads the live pane title from tmux", async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "wtr-runtime-"));
    temporary.push(runtime);
    const runner = new RecordingRunner();
    runner.responses.push({ stdout: "zsh · /repo\n", stderr: "", exitCode: 0 });
    const adapter = new TmuxAdapter(runner, runtime);

    await expect(adapter.sessionTitle("socket", "session")).resolves.toBe("zsh · /repo");
    expect(runner.calls[0]?.args).toContain("#{pane_title}");
  });

  it("maps a live, exited, or absent pane to product terminal state", async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "wtr-runtime-"));
    temporary.push(runtime);
    const runner = new RecordingRunner();
    runner.responses.push(
      { stdout: "0\t\n", stderr: "", exitCode: 0 },
      { stdout: "1\t17\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "no server running", exitCode: 1 },
    );
    const adapter = new TmuxAdapter(runner, runtime);
    await expect(adapter.sessionState("socket", "one")).resolves.toEqual({
      status: "running",
      exitCode: null,
    });
    await expect(adapter.sessionState("socket", "two")).resolves.toEqual({
      status: "exited",
      exitCode: 17,
    });
    await expect(adapter.sessionState("socket", "three")).resolves.toEqual({
      status: "missing",
      exitCode: null,
    });
  });
});
