---
title: Product principles
description: Principles that define Treeport's product boundary.
---

Treeport is a persistent terminal workspace built around Git worktrees.

These principles describe the product boundary. They should guide feature design, issue triage, integrations, and architectural decisions.

## A worktree is the unit of work

Treeport treats a Git worktree as the concrete representation of a piece of development work.

A worktree already contains useful and authoritative state:

- an isolated checkout;
- a starting revision;
- staged, unstaged, untracked, and conflicted files;
- commits;
- a branch or detached revision;
- persistent terminals and processes;
- optional pull-request context;
- a natural cleanup lifecycle.

Treeport should enrich this object rather than introduce a parallel task model.

Human-facing titles, reminders, provenance, and presentation metadata may be attached to a worktree. They must not replace or obscure its Git identity.

## Git is authoritative

Treeport does not assume exclusive ownership of repositories or worktrees.

Worktrees may be created, moved, modified, or removed by:

- Git;
- Zed or another editor;
- scripts;
- coding agents;
- other worktree-aware tools;
- Treeport itself.

Treeport must reconcile its state with Git rather than require users to import or convert externally created worktrees.

Treeport-owned metadata must degrade safely when the underlying Git state changes.

## Do not introduce a parallel task lifecycle

A separate task entity creates synchronization questions that the worktree model avoids:

- Can a task be complete while its worktree remains dirty?
- Can a task be active after its workspace was removed?
- Does archiving a task remove its terminals?
- Does deleting a task delete its branch?
- What happens when a pull request merges outside Treeport?
- How does an external worktree become associated with a task?

Treeport should not create statuses, archive states, or completion semantics that duplicate Git, process, or provider state.

“Finished” should normally be expressed through concrete actions and observations:

- changes were committed or discarded;
- commits became reachable elsewhere;
- a pull request merged, when applicable;
- running terminals were stopped;
- the worktree was safely removed.

## Progressive enhancement

Treeport must remain useful with minimal dependencies:

```text
Git + tmux + shell
```

Additional tools can provide richer behavior without becoming requirements:

- coding agents;
- terminal integrations;
- GitHub or GitLab CLIs;
- pull requests;
- diff viewers;
- Tailscale;
- desktop packaging;
- alternative terminal runtimes.

The baseline experience must not become broken or confusing when an optional integration is absent.

For example:

- without an agent integration, Treeport can still show that a terminal is running;
- without OSC progress, Treeport can still preserve and render the terminal;
- without BEL signals, users can still open and control the session;
- without GitHub authentication, Git and worktree lifecycle still function;
- without a pull request, work can still be completed or discarded.

Integrations should enrich the product rather than define its basic workflow.

## Applications publish semantic state

Treeport should avoid parsing arbitrary terminal output or embedding provider-specific agent logic into core.

Terminal applications and integrations can publish useful state through standard terminal mechanisms:

- terminal titles;
- BEL attention signals;
- OSC progress sequences;
- process exit;
- other documented generic protocols.

For example, a Pi extension may:

- set the terminal title to `PR MERGED`;
- emit BEL when checks pass;
- publish active progress while the agent is working.

Treeport presents these signals consistently. It does not need to independently query and duplicate every workflow state that the application already understands.

## Real terminal applications remain real terminal applications

Treeport runs and attaches to normal TUIs.

It should not replace Pi, Claude Code, Codex, Hunk, `gh`, shells, or other tools with normalized internal interfaces merely to make their workflows look consistent.

Specialist tools should continue to own specialist experiences:

- agents own their coding workflow;
- diff viewers own code review;
- Git and provider CLIs own commits, pull requests, and merges;
- editors own file navigation and editing.

Treeport owns the persistent worktree and terminal context around them.

## Application-style navigation is core

Treeport provides a desktop, browser, and mobile interface around terminal sessions.

Its interaction model may use familiar application conventions such as:

- terminal tabs;
- `Cmd+T` to create;
- `Cmd+W` to close;
- numeric shortcuts to switch;
- mouse-based navigation;
- a persistent repository and worktree hierarchy.

An optional terminal runtime must not force Treeport to expose the runtime’s native workspace, tab, or pane hierarchy as the primary product interface.

## Cleanup should be safer than creation

Creating a worktree should be inexpensive and encouraged.

Removing one must be conservative.

Treeport should account for:

- staged, unstaged, untracked, and conflicted files;
- detached commits;
- commit reachability;
- running terminals;
- external changes since confirmation;
- Git administrative identity;
- filesystem identity;
- interrupted operations.

When Treeport cannot prove that cleanup is safe and still targets the originally approved checkout, it should preserve state and require manual intervention.

## Keep core small

Treeport should not become:

- an editor;
- a file browser;
- a task board;
- an issue tracker;
- a full Git client;
- a first-party diff viewer;
- a provider-specific coding-agent chat UI;
- a CI dashboard;
- a cloud execution platform;
- a general-purpose terminal multiplexer.

Useful surrounding workflows should normally be enabled through:

- terminal presets;
- documented terminal protocols;
- CLI and API operations;
- lightweight integrations;
- optional runtime adapters;
- constrained extensions where justified.

A feature belongs in core when it strengthens the shared worktree and terminal lifecycle rather than reproducing a specialist tool.
