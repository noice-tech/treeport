---
title: Removing a worktree
description: Review and safely remove a Git worktree.
---

Creating a worktree should be cheap. Removing one must be safe.

Before cleanup, Treeport checks the current checkout and Git state rather than relying on an earlier snapshot. It accounts for conditions including:

- staged, unstaged, untracked, and conflicted files;
- detached or otherwise unreachable commits;
- active terminals;
- Git administrative and filesystem identity;
- changes made after the user reviewed the operation.

If Treeport cannot prove that cleanup is safe and still targets the approved checkout, it preserves the worktree and asks for manual intervention.

## Preview and confirmation

Treeport requests a fresh removal preview before it removes a worktree. An ineligible worktree is refused with the reasons.

When warnings can be explicitly accepted, the CLI asks you to rerun the command with `--force`. This confirms warnings from a fresh preview; it is not permission to blindly delete arbitrary directories.

:::caution
Review the reported worktree, changes, commits, and running terminals before confirming destructive cleanup.
:::
