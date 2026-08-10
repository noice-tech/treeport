# Decision 0007: Git inventory defines worktree existence

- Status: Accepted
- Date: 2026-08-10

## Context

Treeport previously stored cleanup lifecycle states on worktrees. A removal could succeed in Git but leave a partial checkout directory, after which Treeport exposed the old worktree as `cleanup_failed` and asked the user to retry or clean it manually. This contradicted Git, retained terminal and navigation identity for a workspace that no longer existed, and made browser and daemon recovery depend on a filesystem-cleanup detail.

Removal is also an accepted destructive command. Once the preview and confirmation have been validated, closing the browser or restarting the daemon must not discard that accepted intent.

## Decision

Git's current worktree inventory is the authority for whether a worktree exists in Treeport. A database worktree row and every user-facing worktree projection represent a worktree Git currently reports. Reconciliation retires an unmatched linked worktree even when files remain at its former checkout path.

Removal is a durable, idempotent operation. Treeport persists the accepted preview, repository and checkout identities, Git administrative key, quarantine path, terminal server identity, and progress before side effects. Browser clients derive transient removal progress from active operations. After a daemon restart, Treeport re-observes Git and resumes the accepted operation without requesting confirmation again.

Crossing the Git removal boundary retires the worktree identity immediately. Residual checkout cleanup then belongs to the operation. Treeport deletes a residual path only when the persisted short-lived filesystem authorization still matches. A changed or unverifiable path is preserved and recorded as a cleanup warning on an otherwise successful removal; it never resurrects the worktree.

A Git worktree later created at the same path receives a new Treeport identity and is not cleanup material for the earlier operation.

## Consequences

- Users see the binary model Git provides: a worktree exists or it does not.
- Refreshing the browser reconstructs “removing” state from the durable operation.
- Restarting the daemon resumes accepted removal on either side of the Git boundary.
- Failures before Git removal leave an ordinary, retryable worktree.
- Failures after Git removal may preserve files but cannot retain a zombie worktree.
- Operation recovery must revalidate repository, Git, and filesystem observations before every destructive boundary.
- Worktree records do not contain cleanup lifecycle status or cleanup errors.
