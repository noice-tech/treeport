import type { PrInfo, PrState } from "@wtr/shared";
import type { CommandRunner } from "./command.js";

interface GhPrJson {
  number?: number;
  state?: string;
  url?: string;
  baseRefName?: string;
  headRefName?: string;
  mergedAt?: string | null;
}

export function mapPrState(pr: GhPrJson | null): PrState {
  if (!pr) return "no_pr";
  if (pr.mergedAt || pr.state?.toUpperCase() === "MERGED") return "merged";
  if (pr.state?.toUpperCase() === "OPEN") return "open";
  if (pr.state?.toUpperCase() === "CLOSED") return "closed";
  return "unknown";
}

export const unknownPr = (): PrInfo => ({
  state: "unknown",
  number: null,
  url: null,
  baseBranch: null,
  headBranch: null,
  mergedAt: null,
  refreshedAt: new Date().toISOString(),
});

export class GhAdapter {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable = "gh",
  ) {}

  async diagnostics(): Promise<{
    available: boolean;
    version: string | null;
    authenticated: boolean;
  }> {
    try {
      const [version, auth] = await Promise.all([
        this.runner.run({ executable: this.executable, args: ["--version"], timeoutMs: 5_000 }),
        this.runner.run({
          executable: this.executable,
          args: ["auth", "status"],
          timeoutMs: 10_000,
        }),
      ]);
      return {
        available: version.exitCode === 0,
        version: `${version.stdout}\n${version.stderr}`.trim().split("\n")[0] || null,
        authenticated: auth.exitCode === 0,
      };
    } catch {
      return { available: false, version: null, authenticated: false };
    }
  }

  async pullRequest(cwd: string, branch: string): Promise<PrInfo> {
    const checkedAt = new Date().toISOString();
    try {
      const auth = await this.runner.run({
        executable: this.executable,
        args: ["auth", "status"],
        cwd,
        timeoutMs: 10_000,
      });
      if (auth.exitCode !== 0) return unknownPr();
      const result = await this.runner.run({
        executable: this.executable,
        args: [
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "all",
          "--limit",
          "1",
          "--json",
          "number,state,url,baseRefName,headRefName,mergedAt",
        ],
        cwd,
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0) return unknownPr();
      const values = JSON.parse(result.stdout) as GhPrJson[];
      const pr = values[0] ?? null;
      return {
        state: mapPrState(pr),
        number: pr?.number ?? null,
        url: pr?.url ?? null,
        baseBranch: pr?.baseRefName ?? null,
        headBranch: pr?.headRefName ?? null,
        mergedAt: pr?.mergedAt ?? null,
        refreshedAt: checkedAt,
      };
    } catch {
      return unknownPr();
    }
  }
}
