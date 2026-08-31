# Decision 0002: The product name is Treeport

- Status: Accepted
- Date: 2026-07-25
- Related: [Decision 0001](0001-worktrees-are-the-unit-of-work.md)

## Context

The original TaskTTY name focused on terminals.

Decision 0001 made Git worktrees the primary unit of work. Terminal emulation and a separate task model are not primary concepts.

The original name did not have a public release.

## Decision

The product and GitHub repository name is **Treeport**.

The name identifies a stable place to enter Git worktree development environments and return to them.

The product hierarchy is:

```text
Project
└── Tree
    └── Terminals
```

Each tree represents a Git worktree. The tree term does not add a separate lifecycle abstraction.

## Prerelease change

This change is a complete prerelease name change. It is not a supported compatibility transition.

Production code, configuration, metadata, APIs, storage, and new runtime identifiers use only Treeport names.

Existing development data needs a one-time migration before the renamed server starts.

The migration moves the database and data directories. At the time of this historical rename, it retained the then-current terminal-runtime metadata as opaque identifiers. The later terminal-host cutover removes those active fields and deliberately does not adopt live terminals from the earlier runtime.

Treeport does not have a permanent fallback, dual read, or dual write.
