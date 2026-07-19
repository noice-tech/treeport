import fs from "node:fs/promises";
import path from "node:path";
import type { DirtyState } from "@wtr/shared";
import type { CommandRunner } from "./command.js";
import { runChecked } from "./command.js";

export interface GitWorktreeInfo {
  path: string;
  head: string | null;
  branch: string;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

export function parseWorktreePorcelain(output: string): GitWorktreeInfo[] {
  const records = output
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean);
  return records.map((record) => {
    const values = new Map<string, string>();
    const flags = new Set<string>();
    for (const line of record.split("\n")) {
      const separator = line.indexOf(" ");
      if (separator === -1) flags.add(line);
      else values.set(line.slice(0, separator), line.slice(separator + 1));
    }
    const worktreePath = values.get("worktree");
    if (!worktreePath)
      throw new Error("Invalid git worktree porcelain output: missing worktree path");
    const ref = values.get("branch");
    return {
      path: worktreePath,
      head: values.get("HEAD") ?? null,
      branch: ref?.replace(/^refs\/heads\//, "") ?? "(detached)",
      bare: flags.has("bare"),
      detached: flags.has("detached"),
      prunable: values.has("prunable") || flags.has("prunable"),
    };
  });
}

export function detectDefaultBranch(symbolicRef: string, fallback: string): string {
  const value = symbolicRef.trim();
  const match = /refs\/remotes\/[^/]+\/(.+)$/.exec(value);
  return match?.[1] || fallback;
}

export function parseDirtyStatus(output: string): DirtyState {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const entry of output.split("\0").filter(Boolean)) {
    const x = entry[0];
    const y = entry[1];
    if (x === "?" && y === "?") {
      untracked += 1;
      continue;
    }
    if (x && x !== " " && x !== "?") staged += 1;
    if (y && y !== " " && y !== "?") unstaged += 1;
  }
  return {
    dirty: staged + unstaged + untracked > 0,
    staged,
    unstaged,
    untracked,
    total: staged + unstaged + untracked,
  };
}

export class GitAdapter {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable = "git",
  ) {}

  private async checked(cwd: string, args: string[]) {
    return runChecked(this.runner, { executable: this.executable, args, cwd, timeoutMs: 30_000 });
  }

  async canonicalizeRepositoryPath(inputPath: string): Promise<string> {
    const canonicalInput = await fs.realpath(path.resolve(inputPath));
    const result = await this.checked(canonicalInput, ["rev-parse", "--show-toplevel"]);
    return fs.realpath(result.stdout.trim());
  }

  async listWorktrees(cwd: string): Promise<GitWorktreeInfo[]> {
    const result = await this.checked(cwd, ["worktree", "list", "--porcelain"]);
    const parsed = parseWorktreePorcelain(result.stdout);
    return Promise.all(
      parsed.map(async (item) => ({
        ...item,
        path: await fs.realpath(item.path).catch(() => path.resolve(item.path)),
      })),
    );
  }

  async resolveMainCheckout(cwd: string): Promise<string> {
    const worktrees = await this.listWorktrees(cwd);
    const main = worktrees[0];
    if (!main || main.bare) throw new Error("A non-bare main Git checkout is required");
    return main.path;
  }

  async currentBranch(cwd: string): Promise<string> {
    const result = await this.checked(cwd, ["branch", "--show-current"]);
    return result.stdout.trim() || "(detached)";
  }

  async remoteDefaultBranch(cwd: string): Promise<string | null> {
    const remote = await this.runner.run({
      executable: this.executable,
      args: ["ls-remote", "--symref", "origin", "HEAD"],
      cwd,
      timeoutMs: 30_000,
    });
    if (remote.exitCode !== 0) return null;
    const match = /^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m.exec(remote.stdout);
    return match?.[1] ?? null;
  }

  async defaultBranch(cwd: string): Promise<string> {
    const remote = await this.remoteDefaultBranch(cwd);
    if (remote) return remote;
    const symbolic = await this.runner.run({
      executable: this.executable,
      args: ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      cwd,
      timeoutMs: 10_000,
    });
    if (symbolic.exitCode === 0) return detectDefaultBranch(symbolic.stdout, "");
    const configured = await this.runner.run({
      executable: this.executable,
      args: ["config", "--get", "init.defaultBranch"],
      cwd,
      timeoutMs: 10_000,
    });
    if (configured.exitCode === 0 && configured.stdout.trim()) return configured.stdout.trim();
    return this.currentBranch(cwd);
  }

  async validateBranch(cwd: string, branch: string): Promise<boolean> {
    const result = await this.runner.run({
      executable: this.executable,
      args: ["check-ref-format", "--branch", branch],
      cwd,
      timeoutMs: 10_000,
    });
    return result.exitCode === 0;
  }

  async dirtyState(cwd: string): Promise<DirtyState> {
    const result = await this.checked(cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    return parseDirtyStatus(result.stdout);
  }

  async isMerged(cwd: string, branch: string): Promise<boolean> {
    const remoteDefaultBranch = await this.remoteDefaultBranch(cwd);
    if (!remoteDefaultBranch) return false;
    const fetch = await this.runner.run({
      executable: this.executable,
      args: ["fetch", "--quiet", "origin", remoteDefaultBranch],
      cwd,
      timeoutMs: 60_000,
    });
    if (fetch.exitCode !== 0) return false;
    const merged = await this.runner.run({
      executable: this.executable,
      args: ["merge-base", "--is-ancestor", branch, `origin/${remoteDefaultBranch}`],
      cwd,
      timeoutMs: 15_000,
    });
    return merged.exitCode === 0;
  }

  async commitSummary(
    cwd: string,
    branch: string,
    defaultBranch: string,
  ): Promise<{ ahead: number; behind: number } | null> {
    const result = await this.runner.run({
      executable: this.executable,
      args: ["rev-list", "--left-right", "--count", `${defaultBranch}...${branch}`],
      cwd,
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) return null;
    const [behind = "0", ahead = "0"] = result.stdout.trim().split(/\s+/);
    return { ahead: Number.parseInt(ahead, 10), behind: Number.parseInt(behind, 10) };
  }
}
