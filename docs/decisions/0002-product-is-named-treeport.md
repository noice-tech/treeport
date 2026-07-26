# Decision 0002: The product is named Treeport

- Status: Accepted
- Date: 2026-07-25
- Related: [Decision 0001](0001-worktrees-are-the-unit-of-work.md)

## Context

The original TaskTTY name emphasized terminals, but Decision 0001 established Git worktrees—not terminal emulation or a separate task model—as the product's primary unit of work. The original name was never released.

## Decision

The product and GitHub repository are named **Treeport**. The name reflects a stable place for entering and returning to worktree-backed development environments. The product hierarchy remains:

```text
Repository
└── Worktree
    └── Terminals
```

This rename does not introduce task, tree, workspace, or provider-specific lifecycle abstractions.

## Pre-release cutover

This is a hard pre-release rename, not a supported compatibility transition. Production code, configuration, metadata, APIs, storage, and newly created runtime identifiers use only Treeport names.

Existing local development data requires a one-time operational migration before the renamed server starts. That migration moves the database and data directories and rewrites persisted tmux metadata while retaining persisted tmux socket and session names exactly as stored; those values are opaque identifiers. No permanent fallback, dual read, or dual write is provided.
