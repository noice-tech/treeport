import { describe, expect, it } from "vitest";
import type { DirtyState, PrInfo } from "@wtr/shared";
import { assertCleanupTransition, assertDiscardConfirmation, finishEligibility } from "./domain.js";

const clean: DirtyState = { dirty: false, staged: 0, unstaged: 0, untracked: 0, total: 0 };
const pr = (state: PrInfo["state"]): PrInfo => ({
  state,
  number: state === "no_pr" || state === "unknown" ? null : 42,
  url: null,
  baseBranch: "trunk",
  headBranch: "topic",
  mergedAt: state === "merged" ? "2026-01-01T00:00:00Z" : null,
  refreshedAt: "2026-01-01T00:00:00Z",
});

describe("cleanup safety", () => {
  it("allows a clean linked worktree with a merged PR", () => {
    expect(
      finishEligibility({ kind: "linked", dirty: clean, pr: pr("merged"), gitMerged: false }),
    ).toEqual({ eligible: true, reasons: [] });
  });

  it("allows Git ancestry as a fallback and distinguishes it from PR state", () => {
    expect(
      finishEligibility({ kind: "linked", dirty: clean, pr: pr("unknown"), gitMerged: true })
        .eligible,
    ).toBe(true);
  });

  it("refuses main, staged, unstaged, untracked, and unmerged worktrees", () => {
    const result = finishEligibility({
      kind: "main",
      dirty: { dirty: true, staged: 1, unstaged: 2, untracked: 3, total: 6 },
      pr: pr("open"),
      gitMerged: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toHaveLength(5);
  });

  it("requires an exact branch-name confirmation for discard", () => {
    expect(() =>
      assertDiscardConfirmation("linked", "feature/$cash; echo no", "feature/$cash; echo no"),
    ).not.toThrow();
    expect(() => assertDiscardConfirmation("linked", "feature/a", "feature/b")).toThrow(
      /exact branch name/i,
    );
    expect(() => assertDiscardConfirmation("main", "trunk", "trunk")).toThrow(/main checkout/i);
  });

  it("enforces conservative cleanup state transitions", () => {
    expect(() => assertCleanupTransition("active", "cleaning")).not.toThrow();
    expect(() => assertCleanupTransition("cleanup_failed", "cleaning")).not.toThrow();
    expect(() => assertCleanupTransition("cleaning", "removed")).not.toThrow();
    expect(() => assertCleanupTransition("active", "removed")).toThrow(/Cannot transition/);
  });
});
