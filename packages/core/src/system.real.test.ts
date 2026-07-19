import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import * as nodePty from "node-pty";
import { resolveExecutablePath, SpawnCommandRunner, runChecked } from "./command.js";
import { loadConfig } from "./config.js";
import { WtrDatabase } from "./database.js";
import { GhAdapter } from "./gh.js";
import { GitAdapter } from "./git.js";
import { GtrAdapter } from "./gtr.js";
import { WtrService } from "./service.js";
import { TmuxAdapter } from "./tmux.js";

const enabled = process.env.WTR_REAL_INTEGRATION === "1";
const root = path.join(os.tmpdir(), `wtr real integration ${process.pid}`);
afterAll(async () => fs.rm(root, { recursive: true, force: true }));

async function executable(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    const child = spawnChild(command, args, { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function waitOperation(service: WtrService, operationId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = service.getOperation(operationId);
    if (operation.status === "completed" || operation.status === "failed") return operation;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("cleanup operation timed out");
}

async function makeService(databasePath: string, runtimeDir: string) {
  const config = loadConfig({
    WTR_DATABASE_PATH: databasePath,
    WTR_RUNTIME_DIR: runtimeDir,
    WTR_DATA_DIR: root,
    WTR_SHELL: process.env.SHELL || "/bin/sh",
  });
  const runner = new SpawnCommandRunner();
  const database = new WtrDatabase(databasePath);
  const git = new GitAdapter(runner);
  const gtr = new GtrAdapter(runner);
  const launcherPath = fileURLToPath(new URL("../dist/launcher.js", import.meta.url));
  const tmux = new TmuxAdapter(runner, runtimeDir, "tmux", launcherPath);
  const gh = new GhAdapter(runner);
  const service = new WtrService({ config, database, runner, git, gtr, tmux, gh });
  await service.initialize();
  return { service, database, tmux, runner };
}

describe.skipIf(!enabled)("real Git, git gtr, and tmux lifecycle", () => {
  it("persists two sessions across attachment and daemon restart, then removes them safely", async (context) => {
    if (
      !(await executable("git", ["--version"])) ||
      !(await executable("tmux", ["-V"])) ||
      !(await executable("git", ["gtr", "version"]))
    ) {
      context.skip();
      return;
    }
    await fs.mkdir(root, { recursive: true });
    const main = path.join(root, "main checkout with spaces");
    const remote = path.join(root, "remote origin.git");
    const databasePath = path.join(root, "metadata", "wtr.db");
    const runtimeDir = path.join(root, "runtime");
    const command = new SpawnCommandRunner();
    await runChecked(command, { executable: "git", args: ["init", "--bare", remote] });
    await runChecked(command, { executable: "git", args: ["init", "-b", "trunk", main] });
    await runChecked(command, {
      executable: "git",
      args: ["config", "user.email", "wtr@example.test"],
      cwd: main,
    });
    await runChecked(command, {
      executable: "git",
      args: ["config", "user.name", "wtr test"],
      cwd: main,
    });
    await fs.writeFile(path.join(main, "README.md"), "fixture\n");
    await runChecked(command, { executable: "git", args: ["add", "README.md"], cwd: main });
    await runChecked(command, { executable: "git", args: ["commit", "-m", "initial"], cwd: main });
    await runChecked(command, {
      executable: "git",
      args: ["remote", "add", "origin", remote],
      cwd: main,
    });
    await runChecked(command, {
      executable: "git",
      args: ["push", "-u", "origin", "trunk"],
      cwd: main,
    });
    await runChecked(command, {
      executable: "git",
      args: ["symbolic-ref", "HEAD", "refs/heads/trunk"],
      cwd: remote,
    });
    await runChecked(command, {
      executable: "git",
      args: ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"],
      cwd: main,
    });

    let fixture = await makeService(databasePath, runtimeDir);
    const project = await fixture.service.registerProject(main);
    const linked = (await fixture.service.createWorktree(project.id, "real/topic", false)).worktree;
    const first = await fixture.service.createTerminal(linked.id, "Pi-like", [
      process.execPath,
      "-e",
      "console.log('PI_LIKE');setInterval(()=>{},1000)",
    ]);
    const second = await fixture.service.createTerminal(linked.id, "Dev-like", [
      process.execPath,
      "-e",
      "console.log('DEV_LIKE');setInterval(()=>{},1000)",
    ]);
    expect(
      await fixture.tmux.sessionState(linked.tmuxSocketName, first.tmuxSessionName),
    ).toMatchObject({ status: "running" });
    expect(
      await fixture.tmux.sessionState(linked.tmuxSocketName, second.tmuxSessionName),
    ).toMatchObject({ status: "running" });

    const attachmentEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => value !== undefined && key !== "TMUX" && key !== "TMUX_PANE",
      ),
    ) as Record<string, string>;
    const attachAndDetach = async (sessionName: string, expected: string) => {
      const client = nodePty.spawn(
        resolveExecutablePath("tmux"),
        fixture.tmux.attachArgs(linked.tmuxSocketName, sessionName),
        {
          cwd: linked.path,
          env: attachmentEnv,
          name: "xterm-256color",
          cols: 100,
          rows: 30,
        },
      );
      let output = "";
      client.onData((data) => {
        output += data;
      });
      for (let attempt = 0; attempt < 30 && !output.includes(expected); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      client.kill();
      expect(output).toContain(expected);
    };
    await attachAndDetach(first.tmuxSessionName, "PI_LIKE");
    await attachAndDetach(second.tmuxSessionName, "DEV_LIKE");
    expect((await fixture.service.refreshTerminalStatus(first.id)).status).toBe("running");

    fixture.database.close();
    fixture = await makeService(databasePath, runtimeDir);
    await attachAndDetach(first.tmuxSessionName, "PI_LIKE");
    expect((await fixture.service.refreshTerminalStatus(first.id)).status).toBe("running");
    expect((await fixture.service.refreshTerminalStatus(second.id)).status).toBe("running");
    await fixture.service.deleteTerminal(first.id);
    expect((await fixture.service.refreshTerminalStatus(second.id)).status).toBe("running");

    await fs.writeFile(path.join(linked.path, "dirty file.txt"), "dirty");
    await expect(fixture.service.beginFinish(linked.id)).rejects.toMatchObject({
      code: "FINISH_REFUSED",
    });
    await fs.rm(path.join(linked.path, "dirty file.txt"));
    await fs.writeFile(path.join(linked.path, "change.txt"), "unmerged\n");
    await runChecked(command, { executable: "git", args: ["add", "change.txt"], cwd: linked.path });
    await runChecked(command, {
      executable: "git",
      args: ["config", "user.email", "wtr@example.test"],
      cwd: linked.path,
    });
    await runChecked(command, {
      executable: "git",
      args: ["config", "user.name", "wtr test"],
      cwd: linked.path,
    });
    await runChecked(command, {
      executable: "git",
      args: ["commit", "-m", "topic"],
      cwd: linked.path,
    });
    await expect(fixture.service.beginFinish(linked.id)).rejects.toMatchObject({
      code: "FINISH_REFUSED",
    });

    await runChecked(command, {
      executable: "git",
      args: ["merge", "--no-ff", "real/topic", "-m", "merge topic"],
      cwd: main,
    });
    await runChecked(command, { executable: "git", args: ["push", "origin", "trunk"], cwd: main });
    const accepted = await fixture.service.beginFinish(linked.id);
    const completed = await waitOperation(fixture.service, accepted.id);
    expect(completed.status).toBe("completed");
    expect(
      (await fixture.tmux.sessionState(linked.tmuxSocketName, second.tmuxSessionName)).status,
    ).toBe("missing");
    expect(fixture.service.getProject(project.id).worktrees).toHaveLength(1);
    await expect(
      fixture.service.beginFinish(fixture.service.getProject(project.id).worktrees[0]!.id),
    ).rejects.toMatchObject({ code: "FINISH_REFUSED" });
    fixture.database.close();
  });
});
