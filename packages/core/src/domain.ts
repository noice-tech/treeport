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
