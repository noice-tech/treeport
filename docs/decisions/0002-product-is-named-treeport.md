# Decision 0002: The product is named Treeport

- Status: Accepted
- Date: 2026-07-25
- Related: [Decision 0001](0001-worktrees-are-the-unit-of-work.md)

## Context

The original TaskTTY name emphasized terminals, but Decision 0001 established Git worktrees—not terminal emulation or a separate task model—as the product's primary unit of work.

## Decision

The product and GitHub repository are named **Treeport**. The name reflects a stable place for entering and returning to worktree-backed development environments. The product hierarchy remains:

```text
Repository
└── Worktree
    └── Terminals
```

This rename does not introduce task, tree, workspace, or provider-specific lifecycle abstractions.

## Compatibility boundary

Treeport is canonical in the UI, documentation, package scope, CLI, environment variables, storage keys, and newly created runtime identifiers.

During the transition, Treeport also:

- ships `tasktty` as a deprecated CLI alias;
- accepts legacy `TASKTTY_*` configuration and managed-terminal context variables;
- reuses a lone legacy default database in place instead of copying live SQLite state;
- discovers existing tmux sessions and browser state under legacy identifiers;
- retains stable legacy machine-readable values where changing them would break automation.

When both forms are supplied, canonical Treeport configuration wins. Compatibility identifiers are not part of the outward product name and may be removed by a future decision after users have migrated.
