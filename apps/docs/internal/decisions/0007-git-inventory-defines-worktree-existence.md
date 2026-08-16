# Decision 0007: Git inventory defines worktree existence

- Status: Accepted
- Date: 2026-08-10

## Context

Treeport previously saved cleanup lifecycle states on worktrees.

Git removal could succeed while some checkout files stayed on disk.

Treeport then showed the old worktree as `cleanup_failed` and requested another cleanup operation.

This behavior contradicted Git and kept terminal identity for a worktree that did not exist.

It also made daemon and browser recovery depend on filesystem cleanup.

Worktree removal is an approved destructive operation.

After safety review and confirmation, a browser close or daemon restart must not cancel the approved operation.

## Decision

The current Git worktree inventory controls worktree existence in Treeport.

A database worktree row and user-visible worktree represent a worktree that Git currently reports.

Reconciliation removes an unmatched linked worktree even when files stay at the old checkout path.

Removal is a durable operation that is safe to repeat.

Before effects, Treeport saves these items:

- the approved safety preview;
- repository and checkout identities;
- Git administration key;
- quarantine path;
- terminal server identity;
- operation progress.

Browser clients get temporary removal progress from active operations.

After a daemon restart, Treeport checks Git again and continues the approved operation.

It does not request a second confirmation.

When Git removes the worktree, Treeport immediately removes the worktree identity.

Residual file cleanup stays with the operation.

Treeport removes a residual path only when the saved short-duration filesystem authorization still matches.

If the path changed or cannot be verified, Treeport keeps it.

The successful removal records a cleanup warning. The residual path does not restore the worktree.

A later Git worktree at the same path gets a new Treeport identity.

It is not cleanup material for the earlier operation.

## Consequences

- Users see the two Git states: a worktree exists or does not exist.
- A browser refresh gets removal state from the durable operation.
- A daemon restart continues approved removal before or after the Git boundary.
- A failure before Git removal keeps a standard worktree that the user can remove again.
- A failure after Git removal can keep files but cannot keep an invalid worktree.
- Recovery checks repository, Git, and filesystem observations before each destructive boundary.
- Worktree records do not contain cleanup lifecycle state or cleanup errors.
