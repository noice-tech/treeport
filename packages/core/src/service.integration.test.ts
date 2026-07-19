import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRequest, CommandResult, CommandRunner } from "./command.js";
import { WtrDatabase } from "./database.js";
import { GhAdapter } from "./gh.js";
import { GitAdapter } from "./git.js";
import { GtrAdapter } from "./gtr.js";
import { WtrService } from "./service.js";
import { TmuxAdapter } from "./tmux.js";
import type { AppConfig } from "./config.js";

const directories: string[] = [];
const databases: WtrDatabase[] = [];
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

class SystemDouble implements CommandRunner {
  readonly calls: CommandRequest[] = [];
  readonly worktrees: Array<{ path: string; branch: string }>;
  readonly sessions = new Map<string, { alive: boolean; exitCode: number | null }>();
  dirtyPaths = new Set<string>();
  merged = false;
  gtrRemoveFails = false;
  tmuxKillFails = false;

  constructor(
    readonly main: string,
    readonly linkedBase: string,
  ) {
    this.worktrees = [{ path: main, branch: "trunk" }];
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(structuredClone(request));
    const args = [...request.args];
    const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
    const fail = (stderr: string): CommandResult => ({ stdout: "", stderr, exitCode: 1 });
    if (args[0] === "--version") return ok("git version 2.45.0\n");
    if (args[0] === "-V") return ok("tmux 3.6a\n");
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${this.main}\n`);
    if (args[0] === "worktree" && args[1] === "list") {
      return ok(
        this.worktrees
          .map(
            (worktree, index) =>
              `worktree ${worktree.path}\nHEAD ${index}\nbranch refs/heads/${worktree.branch}\n`,
          )
          .join("\n"),
      );
    }
    if (args[0] === "branch" && args[1] === "--show-current") return ok("trunk\n");
    if (args[0] === "ls-remote") return ok("ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n");
    if (args[0] === "symbolic-ref") return ok("refs/remotes/origin/trunk\n");
    if (args[0] === "check-ref-format") return args.at(-1)?.includes("..") ? fail("invalid") : ok();
    if (args[0] === "status")
      return ok(this.dirtyPaths.has(request.cwd ?? "") ? "?? dirty file.txt\0" : "");
    if (args[0] === "fetch") return ok();
    if (args[0] === "merge-base") return this.merged ? ok() : fail("not ancestor");
    if (args[0] === "rev-list") return ok("0\t1\n");
    if (args[0] === "gtr" && args[1] === "version") return ok("git gtr version 2.7.3\n");
    if (args[0] === "gtr" && args[1] === "help") {
      return ok("--from-current --force --delete-branch --merged --dry-run\n");
    }
    if (args[0] === "gtr" && args[1] === "new") {
      const branch = args[2]!;
      const linkedPath = path.join(this.linkedBase, branch.replaceAll("/", "-"));
      await fs.mkdir(linkedPath, { recursive: true });
      this.worktrees.push({ path: linkedPath, branch });
      return ok();
    }
    if (args[0] === "gtr" && args[1] === "go") {
      const worktree = this.worktrees.find((item) => item.branch === args[2]);
      return worktree ? ok(`${worktree.path}\n`) : fail("missing");
    }
    if (args[0] === "gtr" && args[1] === "rm") {
      if (this.gtrRemoveFails) return fail("gtr remove failed");
      const branch = args[2]!;
      const index = this.worktrees.findIndex((item) => item.branch === branch);
      if (index === -1) return fail("missing");
      const [removed] = this.worktrees.splice(index, 1);
      if (removed) await fs.rm(removed.path, { recursive: true, force: true });
      return ok();
    }
    if (args[0] === "auth" && args[1] === "status") return fail("not authenticated");
    if (args.includes("new-session")) {
      const session = args[args.indexOf("-s") + 1]!;
      const socket = args[args.indexOf("-L") + 1]!;
      this.sessions.set(`${socket}/${session}`, { alive: true, exitCode: null });
      return ok();
    }
    if (args.includes("set-option")) return ok();
    if (args.includes("list-panes")) {
      const session = args[args.indexOf("-t") + 1]!;
      const socket = args[args.indexOf("-L") + 1]!;
      const state = this.sessions.get(`${socket}/${session}`);
      return state ? ok(state.alive ? "0\t\n" : `1\t${state.exitCode ?? 0}\n`) : fail("missing");
    }
    if (args.includes("kill-session")) {
      const session = args[args.indexOf("-t") + 1]!;
      const socket = args[args.indexOf("-L") + 1]!;
      this.sessions.delete(`${socket}/${session}`);
      return ok();
    }
    if (args.includes("list-sessions")) {
      const socket = args[args.indexOf("-L") + 1]!;
      return [...this.sessions.keys()].some((key) => key.startsWith(`${socket}/`))
        ? ok("session\n")
        : fail("no sessions");
    }
    if (args.includes("kill-server")) {
      if (this.tmuxKillFails) return fail("tmux shutdown failed");
      const socket = args[args.indexOf("-L") + 1]!;
      for (const key of [...this.sessions.keys()])
        if (key.startsWith(`${socket}/`)) this.sessions.delete(key);
      return ok();
    }
    return fail(`Unexpected command: ${request.executable} ${args.join(" ")}`);
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtr integration with spaces "));
  directories.push(root);
  const main = path.join(root, "main checkout");
  const linked = path.join(root, "linked worktrees");
  const runtime = path.join(root, "runtime");
  await fs.mkdir(main, { recursive: true });
  await fs.mkdir(linked, { recursive: true });
  const runner = new SystemDouble(main, linked);
  const database = new WtrDatabase(path.join(root, "wtr.db"));
  databases.push(database);
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 4780,
    authToken: null,
    databasePath: database.filePath,
    dataDir: root,
    runtimeDir: runtime,
    shell: "/bin/zsh",
    tmuxPath: "tmux",
    gitPath: "git",
    ghPath: "gh",
    apiUrl: "http://127.0.0.1:4780",
  };
  const git = new GitAdapter(runner);
  const gtr = new GtrAdapter(runner);
  const tmux = new TmuxAdapter(runner, runtime, "tmux", "/launcher with spaces.js");
  const gh = new GhAdapter(runner);
  const service = new WtrService({ config, database, runner, git, gtr, tmux, gh });
  await service.initialize();
  return { root, main, runner, service };
}

async function waitForOperation(service: WtrService, operationId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const operation = service.getOperation(operationId);
    if (operation.status === "completed" || operation.status === "failed") return operation;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("operation timeout");
}

describe("WtrService with injected command adapters", () => {
  it("registers, creates through gtr, runs independent terminals, and cleans safely", async () => {
    const { main, runner, service } = await fixture();
    const project = await service.registerProject(main);
    expect(project.mainWorktreePath).toBe(await fs.realpath(main));
    expect(project.defaultBranch).toBe("trunk");
    expect(project.worktrees[0]?.kind).toBe("main");

    const created = await service.createWorktree(project.id, "feature/cache", false);
    expect(created.worktree.path).toContain("linked worktrees");
    expect(
      runner.calls.some((call) => call.args.slice(0, 3).join(" ") === "gtr new feature/cache"),
    ).toBe(true);

    const argv = ["pi", "--prompt", 'spaces "quotes" ; $dollar 世界'];
    const first = await service.createTerminal(created.worktree.id, "Pi", argv);
    const second = await service.createTerminal(created.worktree.id, "Dev server", ["pnpm", "dev"]);
    expect(first.argv).toEqual(argv);
    expect(first.tmuxSessionName).not.toBe(second.tmuxSessionName);
    expect(runner.sessions.size).toBe(2);

    await service.deleteTerminal(first.id);
    expect(runner.sessions.size).toBe(1);
    expect(service.getTerminal(second.id).status).toBe("running");

    runner.dirtyPaths.add(created.worktree.path);
    await expect(service.beginFinish(created.worktree.id)).rejects.toMatchObject({
      code: "FINISH_REFUSED",
    });
    runner.dirtyPaths.clear();
    await expect(service.beginFinish(created.worktree.id)).rejects.toMatchObject({
      code: "FINISH_REFUSED",
    });

    runner.merged = true;
    const operation = await service.beginFinish(created.worktree.id);
    const completed = await waitForOperation(service, operation.id);
    expect(completed.status).toBe("completed");
    expect(runner.sessions.size).toBe(0);
    expect(service.getProject(project.id).worktrees).toHaveLength(1);
    expect(service.getProject(project.id).worktrees[0]?.kind).toBe("main");
    await expect(
      service.beginFinish(service.getProject(project.id).worktrees[0]!.id),
    ).rejects.toMatchObject({ code: "FINISH_REFUSED" });
  });

  it("preserves cleanup_failed across refresh and reconciles terminals after external failures", async () => {
    const { main, runner, service } = await fixture();
    const project = await service.registerProject(main);
    const linked = (await service.createWorktree(project.id, "feature/failure", false)).worktree;
    const terminal = await service.createTerminal(linked.id, "Pi", ["pi"]);
    runner.merged = true;
    runner.gtrRemoveFails = true;
    const failed = await waitForOperation(service, (await service.beginFinish(linked.id)).id);
    expect(failed.status).toBe("failed");
    expect(service.getWorktree(linked.id).status).toBe("cleanup_failed");
    expect(service.getTerminal(terminal.id).status).toBe("missing");
    await service.refreshProject(project.id);
    expect(service.getWorktree(linked.id).status).toBe("cleanup_failed");

    const second = (await service.createWorktree(project.id, "feature/tmux-failure", false))
      .worktree;
    const liveTerminal = await service.createTerminal(second.id, "Dev", ["pnpm", "dev"]);
    runner.gtrRemoveFails = false;
    runner.tmuxKillFails = true;
    const tmuxFailure = await waitForOperation(service, (await service.beginFinish(second.id)).id);
    expect(tmuxFailure.status).toBe("failed");
    expect(service.getTerminal(liveTerminal.id).status).toBe("running");
  });

  it("serializes duplicate worktree creation before asynchronous validation", async () => {
    const { main, service } = await fixture();
    const project = await service.registerProject(main);
    const results = await Promise.allSettled([
      service.createWorktree(project.id, "feature/race-a", false),
      service.createWorktree(project.id, "feature/race-b", false),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "PROJECT_BUSY" } });
  });
});
