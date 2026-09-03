# Decision 0007: Git inventory defines tree existence

- Status: Accepted
- Date: 2026-08-10

## Context

Treeport previously saved cleanup lifecycle states on trees.

Git removal could succeed while some checkout files stayed on disk.

Treeport then showed the old tree as `cleanup_failed` and requested another cleanup operation.

This behavior contradicted Git and kept terminal identity for a tree whose Git worktree did not exist.

It also made daemon and browser recovery depend on filesystem cleanup.

Tree removal is an approved destructive operation.

After safety review and confirmation, a browser close or daemon restart must not cancel the approved operation.

## Decision

The current Git worktree inventory controls tree existence in Treeport.

A database worktree row and user-visible tree represent a Git worktree that Git currently reports.

Reconciliation removes an unmatched linked tree even when files stay at the old checkout path.

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

Treeport stops tree terminals before it runs configured project cleanup.

Project cleanup stays with the durable removal operation. Treeport saves each successful command before it starts the next command.

After a restart, Treeport skips saved successful commands. It repeats a command when the saved state shows an interrupted execution.

A project cleanup failure keeps the Git worktree. Git removal starts only after all project cleanup commands succeed.

External Git removal does not run repository cleanup code. The external removal operation records that project cleanup was skipped.

When Git removes the worktree, Treeport immediately removes the tree identity.

Residual file cleanup stays with the operation.

Treeport removes a residual path only when the saved short-duration filesystem authorization still matches.

If the path changed or cannot be verified, Treeport keeps it.

The successful removal records a cleanup warning. The residual path does not restore the tree.

A later Git worktree at the same path gets a new tree identity.

It is not cleanup material for the earlier operation.

## Consequences

- Users see whether Git reports the underlying worktree for a tree.
- A browser refresh gets removal state from the durable operation.
- A daemon restart continues approved removal before or after each cleanup and Git boundary.
- A project cleanup failure keeps a standard tree that the user can remove again.
- External Git removal never starts project cleanup.
- A failure after Git removal can keep files but cannot keep an invalid tree.
- Recovery checks repository, Git, and filesystem observations before each destructive boundary.
- Worktree records do not contain cleanup lifecycle state or cleanup errors.
