# Decision 0001: Git worktrees are the unit of work

- Status: Accepted
- Date: 2026-07-25
- Related: Issue #119

## Context

Treeport needs a stable user model for development work.

Current product copy calls this item a **Tree**. This decision uses **Git worktree** for the underlying Git concept.

One proposal added a separate `Task` entity:

```text
Task
└── Workspace
    └── Terminals
```

A workspace could be a worktree, directory, snapshot, container, remote computer, or micro virtual machine.

This model could let a task continue after workspace removal. It could also separate task titles from branches and paths.

However, the model would add a second lifecycle and source of truth.

## Decision

Treeport uses a Git worktree as the primary unit of work.

The product hierarchy is:

```text
Project
└── Tree
    └── Terminals
```

Treeport will not add a separate task entity at this stage.

A Tree can have Treeport presentation information:

- a user title;
- a reminder or note;
- provenance;
- optional parent-Tree context;
- other small items that do not copy Git lifecycle state.

This information adds context but does not replace Git worktree identity.

## Rationale

A Git worktree supplies concrete development state:

- separate files;
- a starting revision;
- file change state;
- commits;
- a branch or detached `HEAD`;
- active processes;
- optional pull-request context;
- a removal lifecycle.

A separate task object must synchronize abstract status with Git, processes, providers, and external tools.

This synchronization can cause contradictions:

- A completed task can have uncommitted files.
- An active task can have no workspace.
- An archived task can have active terminals.
- A merged pull request can belong to an active task.
- An external Git worktree can have no task record.
- Task removal can have an unclear effect on branches, workspaces, and terminals.

The Tree model prevents these contradictions. Development work stays connected to the concrete workspace that contains it.

## Consequences

### Positive consequences

- Git stays the source of truth.
- Git worktrees from Git, editors, scripts, agents, and Treeport are first-class Trees.
- Treeport does not need an import or conversion workflow.
- Git state controls Tree existence and removal.
- Operation-owned cleanup controls residual files.
- The product is direct and easy to explain.
- Presentation information can differ from branch names and paths.

### Negative consequences

- Treeport is specific to Git worktrees.
- Work that cannot use a Git worktree can be outside the primary product model.
- A removed Tree does not keep an active workspace representation.
- A future isolation method can require a new decision or abstraction.

Treeport accepts these limits. Current product clarity is more important than possible future backends.

## Progressive enhancement

Treeport does not require coding-agent, pull-request, or provider integrations.

Core state comes from Git, process lifecycle, and Treeport terminal state.

Optional applications can add information through:

- terminal titles;
- BEL attention;
- OSC progress;
- Treeport CLI and API operations;
- provider extensions.

The Tree model must stay valid when these integrations are not present.

## Rejected alternatives

### Separate task entity

Treeport rejects this model because it adds a parallel lifecycle without a verified second workspace backend.

### User-visible generic workspace entity

Treeport rejects this model for now. A workspace is less concrete than the Git worktree behavior that Treeport supplies.

### Generic adapter framework

Treeport defers this model. A shared abstraction needs a second implementation with verified common requirements.

### Tree with small presentation information

Treeport accepts this model. It supplies user titles and reminders without an independent task lifecycle.

## Conditions for a new decision

Review this decision only when all these conditions are true:

1. A concrete non-worktree backend exists or has a substantial prototype.
2. Users have workflows that cannot reasonably use Git worktrees.
3. The second backend shares sufficient lifecycle behavior for one abstraction.
4. The abstraction keeps Git interoperability and cleanup safety.

Until then, possible future backends must not control the primary user model.
