import fs from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "./command.js";
import { runChecked } from "./command.js";

export interface GtrCapabilities {
  available: boolean;
  version: string | null;
  supportsFromCurrent: boolean;
  supportsForceRemove: boolean;
  supportsDeleteBranch: boolean;
  supportsCleanMerged: boolean;
  supportsCleanDryRun: boolean;
}

export class GtrAdapter {
  private capabilitiesPromise: Promise<GtrCapabilities> | null = null;

  constructor(
    private readonly runner: CommandRunner,
    private readonly gitExecutable = "git",
  ) {}

  capabilities(refresh = false): Promise<GtrCapabilities> {
    if (!this.capabilitiesPromise || refresh) this.capabilitiesPromise = this.inspectCapabilities();
    return this.capabilitiesPromise;
  }

  private async inspectCapabilities(): Promise<GtrCapabilities> {
    try {
      const [version, general, remove, clean] = await Promise.all([
        this.runner.run({
          executable: this.gitExecutable,
          args: ["gtr", "version"],
          timeoutMs: 5_000,
        }),
        this.runner.run({
          executable: this.gitExecutable,
          args: ["gtr", "help"],
          timeoutMs: 5_000,
        }),
        this.runner.run({
          executable: this.gitExecutable,
          args: ["gtr", "help", "rm"],
          timeoutMs: 5_000,
        }),
        this.runner.run({
          executable: this.gitExecutable,
          args: ["gtr", "help", "clean"],
          timeoutMs: 5_000,
        }),
      ]);
      const help = `${general.stdout}\n${general.stderr}`;
      const rmHelp = `${remove.stdout}\n${remove.stderr}\n${help}`;
      const cleanHelp = `${clean.stdout}\n${clean.stderr}\n${help}`;
      return {
        available: version.exitCode === 0,
        version: `${version.stdout}\n${version.stderr}`.trim().split("\n")[0] || null,
        supportsFromCurrent: help.includes("--from-current"),
        supportsForceRemove: rmHelp.includes("--force"),
        supportsDeleteBranch: rmHelp.includes("--delete-branch"),
        supportsCleanMerged: cleanHelp.includes("--merged"),
        supportsCleanDryRun: cleanHelp.includes("--dry-run") || cleanHelp.includes("-n"),
      };
    } catch {
      return {
        available: false,
        version: null,
        supportsFromCurrent: false,
        supportsForceRemove: false,
        supportsDeleteBranch: false,
        supportsCleanMerged: false,
        supportsCleanDryRun: false,
      };
    }
  }

  async create(
    repositoryPath: string,
    branch: string,
    fromCurrent: boolean,
    sourcePath?: string,
  ): Promise<string> {
    const capabilities = await this.capabilities();
    if (!capabilities.available) throw new Error("git gtr is required to create worktrees");
    if (fromCurrent && !capabilities.supportsFromCurrent)
      throw new Error("Installed git gtr does not support --from-current");
    const args = ["gtr", "new", branch, "--yes"];
    if (fromCurrent) args.push("--from-current");
    await runChecked(this.runner, {
      executable: this.gitExecutable,
      args,
      cwd: sourcePath ?? repositoryPath,
      timeoutMs: 10 * 60_000,
    });
    const go = await runChecked(this.runner, {
      executable: this.gitExecutable,
      args: ["gtr", "go", branch],
      cwd: repositoryPath,
      timeoutMs: 30_000,
    });
    const worktreePath = go.stdout.trim().split("\n").at(-1)?.trim();
    if (!worktreePath) throw new Error("git gtr created the worktree but did not report its path");
    return fs.realpath(
      path.isAbsolute(worktreePath) ? worktreePath : path.resolve(repositoryPath, worktreePath),
    );
  }

  async remove(
    repositoryPath: string,
    branch: string,
    options: { force: boolean; deleteBranch: boolean },
  ): Promise<void> {
    const capabilities = await this.capabilities();
    if (!capabilities.available) throw new Error("git gtr is required to remove worktrees");
    if (options.force && !capabilities.supportsForceRemove)
      throw new Error("Installed git gtr does not support forced removal");
    const args = ["gtr", "rm", branch, "--yes"];
    if (options.force) args.push("--force");
    if (options.deleteBranch && capabilities.supportsDeleteBranch) args.push("--delete-branch");
    await runChecked(this.runner, {
      executable: this.gitExecutable,
      args,
      cwd: repositoryPath,
      timeoutMs: 10 * 60_000,
    });
  }

  async cleanMergedPreview(repositoryPath: string): Promise<string | null> {
    const capabilities = await this.capabilities();
    if (!capabilities.supportsCleanMerged || !capabilities.supportsCleanDryRun) return null;
    const result = await runChecked(this.runner, {
      executable: this.gitExecutable,
      args: ["gtr", "clean", "--merged", "--dry-run"],
      cwd: repositoryPath,
      timeoutMs: 60_000,
    });
    return result.stdout;
  }
}
