import type { DirtyState, FinishPreflight, PrInfo, WorktreeKind } from "@wtr/shared";

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function finishEligibility(input: {
  kind: WorktreeKind;
  dirty: DirtyState;
  pr: PrInfo;
  gitMerged: boolean;
}): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.kind === "main") reasons.push("The main checkout cannot be removed");
  if (input.dirty.staged) reasons.push(`${input.dirty.staged} staged change(s)`);
  if (input.dirty.unstaged) reasons.push(`${input.dirty.unstaged} unstaged change(s)`);
  if (input.dirty.untracked) reasons.push(`${input.dirty.untracked} untracked file(s)`);
  if (input.pr.state !== "merged" && !input.gitMerged)
    reasons.push("The branch is not confirmed merged");
  return { eligible: reasons.length === 0, reasons };
}

export function assertDiscardConfirmation(
  kind: WorktreeKind,
  branch: string,
  confirmation: string,
): void {
  if (kind === "main")
    throw new DomainError("MAIN_WORKTREE", "The main checkout cannot be discarded", 409);
  if (confirmation !== branch) {
    throw new DomainError(
      "CONFIRMATION_MISMATCH",
      `Type the exact branch name “${branch}” to discard this worktree`,
      400,
    );
  }
}

export type CleanupTransition =
  | { from: "active" | "cleanup_failed"; to: "cleaning" }
  | { from: "cleaning"; to: "removed" | "cleanup_failed" };

export function assertCleanupTransition(
  from: string,
  to: string,
): asserts from is CleanupTransition["from"] {
  const valid =
    ((from === "active" || from === "cleanup_failed") && to === "cleaning") ||
    (from === "cleaning" && (to === "removed" || to === "cleanup_failed"));
  if (!valid)
    throw new DomainError(
      "INVALID_CLEANUP_STATE",
      `Cannot transition worktree cleanup from ${from} to ${to}`,
      409,
    );
}

export function publicPreflight(input: FinishPreflight): FinishPreflight {
  return structuredClone(input);
}
