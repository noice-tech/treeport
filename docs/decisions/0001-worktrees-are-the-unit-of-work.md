# Decision 0001: Worktrees are the unit of work

* Status: Accepted
* Date: 2026-07-25
* Related: Issue #119

## Context

TaskTTY needs a durable user-facing model for organizing development work.

One proposed model introduced a separate `Task` entity:

```text
Task
└── Workspace
    └── Terminals
```

Under that proposal, Git worktrees would be one possible workspace backend alongside directories, copy-on-write snapshots, containers, remote machines, or micro-VMs.

The proposal offered some apparent flexibility:

* a task could outlive its workspace;
* task titles could differ from branch names and paths;
* future isolation mechanisms could be added;
* the user would express intent without choosing a Git primitive.

However, it also introduced a second lifecycle and source of truth alongside the actual development environment.

## Decision

TaskTTY will treat the Git worktree as the primary unit of work.

The primary hierarchy remains:

```text
Repository
└── Worktree
    └── Terminals
```

TaskTTY will not introduce a separate task entity at this stage.

A worktree may receive TaskTTY-owned presentation metadata, including:

* a human-facing title;
* a reminder or note;
* provenance;
* optional parent-worktree context;
* other lightweight metadata that does not duplicate Git lifecycle state.

This metadata enriches the worktree but does not replace its identity.

## Rationale

A Git worktree already provides grounded development state:

* isolated files;
* starting revision;
* dirty state;
* commits;
* branch or detached HEAD;
* running processes;
* optional pull-request context;
* a concrete removal lifecycle.

A separate task object would require TaskTTY to synchronize abstract status with Git, processes, provider state, and external tools.

Potential contradictions would include:

* a task marked complete with uncommitted files;
* an active task whose workspace was removed externally;
* an archived task with running terminals;
* a merged pull request attached to an in-progress task;
* an external worktree with no task record;
* task deletion whose relationship to workspace, branch, and terminal deletion is unclear.

The worktree model avoids these contradictions by grounding work in the concrete workspace that contains it.

## Consequences

### Positive

* Git remains the source of truth.
* Worktrees created by Zed, Git, scripts, agents, and TaskTTY are immediately first-class.
* TaskTTY does not require an import or conversion workflow.
* Cleanup semantics remain tied to concrete Git and filesystem state.
* The product remains opinionated and easier to explain.
* Human-facing context can still be added independently from branch names and paths.

### Negative

* TaskTTY is explicitly Git-worktree-oriented.
* Work that cannot be represented by a Git worktree may not fit the primary product model.
* A removed worktree no longer has an active workspace representation.
* Future non-worktree isolation mechanisms may require a new decision or a revised abstraction.

These tradeoffs are accepted. Product clarity is currently more valuable than hypothetical backend generality.

## Progressive enhancement

TaskTTY does not require every worktree to have coding-agent, pull-request, or provider integrations.

Core state comes from Git, process lifecycle, and TaskTTY-owned terminal state.

Optional applications can enrich the experience using:

* terminal titles;
* BEL attention;
* OSC progress;
* TaskTTY CLI and API operations;
* provider-specific extensions.

The absence of these integrations must not invalidate the worktree model.

## Alternatives considered

### Separate Task entity

Rejected because it creates a parallel lifecycle and synchronization burden without a validated second workspace backend.

### Generic Workspace entity exposed to users

Rejected for now because “workspace” is less concrete and less opinionated than the Git worktree behavior TaskTTY is designed around.

### Generic adapter framework with worktrees as one backend

Deferred. A shared backend abstraction should emerge only after a second concrete implementation demonstrates actual common requirements.

### Worktree plus lightweight metadata

Accepted. This provides human-facing titles and reminders without introducing an independent task lifecycle.

## Future reconsideration

This decision may be revisited when all of the following are true:

1. A concrete non-worktree backend has been implemented or seriously prototyped.
2. Users have demonstrated workflows that cannot reasonably use Git worktrees.
3. The second backend shares enough lifecycle semantics to justify a common abstraction.
4. Introducing that abstraction does not weaken external Git interoperability or cleanup safety.

Until then, hypothetical containers, micro-VMs, remote environments, or copy-on-write directories must not shape the primary user-facing model.
