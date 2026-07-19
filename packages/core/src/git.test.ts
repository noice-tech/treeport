import { describe, expect, it } from "vitest";
import { detectDefaultBranch, parseDirtyStatus, parseWorktreePorcelain } from "./git.js";

describe("git parsing", () => {
  it("parses main and linked worktrees with paths containing spaces", () => {
    const result = parseWorktreePorcelain(`worktree /tmp/main repo
HEAD abc123
branch refs/heads/trunk

worktree /tmp/worktrees/feature cache
HEAD def456
branch refs/heads/feature/cache
`);
    expect(result).toEqual([
      {
        path: "/tmp/main repo",
        head: "abc123",
        branch: "trunk",
        bare: false,
        detached: false,
        prunable: false,
      },
      {
        path: "/tmp/worktrees/feature cache",
        head: "def456",
        branch: "feature/cache",
        bare: false,
        detached: false,
        prunable: false,
      },
    ]);
    expect(result[0]?.path).toBe("/tmp/main repo");
  });

  it("detects a remote default branch without assuming main", () => {
    expect(detectDefaultBranch("refs/remotes/origin/trunk\n", "fallback")).toBe("trunk");
    expect(detectDefaultBranch("", "develop")).toBe("develop");
  });

  it("counts staged, unstaged, and untracked changes", () => {
    const dirty = parseDirtyStatus(
      "M  staged.ts\0 M unstaged.ts\0MM both.ts\0?? untracked file.txt\0",
    );
    expect(dirty).toEqual({ dirty: true, staged: 2, unstaged: 2, untracked: 1, total: 5 });
    expect(parseDirtyStatus("")).toEqual({
      dirty: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      total: 0,
    });
  });
});
