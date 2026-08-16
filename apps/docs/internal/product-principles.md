---
title: Product principles
description: Principles that define the Treeport product boundary.
---

Treeport is a persistent terminal workspace that uses Git worktrees.

Treeport shows each Git worktree as a Tree. Use **Tree** and **Trees** for these items in product copy.

Use **Git worktree** only when the text explains the underlying Git concept or names a stable technical contract.

Use these principles for product design, issue review, integrations, and architecture decisions.

## Use a Tree as the unit of work

Each Tree represents a Git worktree as one unit of development work.

A Tree contains useful source state:

- a separate checkout;
- a starting revision;
- staged, unstaged, untracked, and conflicted files;
- commits;
- a branch or detached revision;
- persistent terminals and processes;
- optional pull-request context;
- a cleanup lifecycle.

Add information to this object instead of making a parallel task model.

A Tree can have user titles, reminders, provenance, and presentation information.

This information must not replace or hide its Git worktree identity.

## Keep Git authoritative

Treeport does not have exclusive control of repositories or Git worktrees.

These tools can create, move, change, or remove Git worktrees:

- Git;
- Zed or another editor;
- scripts;
- coding agents;
- other Git worktree tools;
- Treeport.

Treeport must compare its state with Git.

It must not require an import or conversion for an external Git worktree.

Treeport information must fail safely when Git state changes.

## Do not add a parallel task lifecycle

A separate task entity causes synchronization questions:

- Can a task be complete when its Tree has changes?
- Can a task be active after workspace removal?
- Does task archiving remove terminals?
- Does task deletion remove its branch?
- What occurs when a pull request merges outside Treeport?
- How does an external Git worktree connect to a task?

Treeport must not add status or archive behavior that copies Git, process, or provider state.

Use concrete actions and observations for completion:

- Commit or discard changes.
- Make commits available from another reference.
- Merge the pull request when applicable.
- Stop active terminals.
- Remove the Tree safely.

## Use progressive enhancement

Treeport must be useful with these minimum tools:

```text
Git + tmux + shell
```

Optional tools can add functions without becoming requirements:

- coding agents;
- terminal integrations;
- GitHub or GitLab CLIs;
- pull requests;
- diff viewers;
- Tailscale;
- desktop distribution;
- other terminal runtimes.

A missing optional integration must not damage or confuse the baseline workflow.

For example:

- Without an agent integration, Treeport can show an active terminal.
- Without OSC progress, Treeport can preserve and show the terminal.
- Without BEL, users can open and control the terminal.
- Without GitHub authentication, Git and Tree operations continue.
- Without a pull request, users can complete or discard work.

Integrations add information. They do not define the basic workflow.

## Let applications publish state

Treeport must not parse arbitrary terminal output or add provider logic to core.

Applications can publish state through general terminal mechanisms:

- terminal titles;
- BEL attention;
- OSC progress;
- process exit;
- other documented protocols.

For example, a Pi extension can:

- set the title to `PR MERGED`;
- send BEL when checks pass;
- send active progress while the agent works.

Treeport shows these signals in a consistent form.

It does not separately get and copy state that the application already understands.

## Keep terminal applications unchanged

Treeport starts and connects to standard terminal user interfaces.

It must not replace specialist tools with simplified internal interfaces.

Specialist tools keep their responsibilities:

- Agents control coding workflows.
- Diff viewers control code review.
- Git and provider CLIs control commits, pull requests, and merges.
- Editors control file navigation and editing.

Treeport controls the persistent Tree and terminal context around them.

## Use application navigation

Treeport supplies desktop, browser, and phone interfaces for terminal sessions.

It can use familiar application operations:

- terminal tabs;
- `Cmd+T` to create;
- `Cmd+W` to close;
- numbered selection shortcuts;
- mouse navigation;
- a persistent project and Tree hierarchy.

A terminal runtime must not force its native session, tab, or pane hierarchy into the main Treeport interface.

## Make cleanup safer than creation

Tree creation must be low cost and easy.

Tree removal must be conservative.

Treeport must review these conditions:

- staged, unstaged, untracked, and conflicted files;
- detached commits;
- commit reachability;
- active terminals;
- changes after confirmation;
- Git administration identity;
- filesystem identity;
- interrupted operations.

If Treeport cannot prove safe cleanup of the approved checkout, it must keep state and require manual action.

## Keep core small

Treeport must not become:

- an editor;
- a file browser;
- a task board;
- an issue tracker;
- a complete Git client;
- a first-party diff viewer;
- a provider-specific agent chat interface;
- a CI dashboard;
- a cloud execution system;
- a general terminal multiplexer.

Use these extension points for related workflows:

- terminal presets;
- documented terminal protocols;
- CLI and API operations;
- small integrations;
- optional runtime adapters;
- limited extensions with a verified need.

Add a function to core only when it improves the shared Tree and terminal lifecycle.

Do not add a core function that copies a specialist tool.
