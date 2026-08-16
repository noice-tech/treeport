---
title: Projects, Trees, and terminals
description: Learn how Treeport organizes repositories, Trees, and terminals.
---

Treeport uses a Tree as the boundary for one unit of development work.

```text
Project
└── Tree
    └── Terminal
```

## Projects

A project is a Git repository that you open in Treeport.

When you close a project, Treeport stops all terminals in that project. It does not remove the repository, Git worktrees, or files.

You can open the project again later.

## Trees

A Tree is Treeport's persistent workspace for an isolated development environment.

The Tree name does not tie the workspace to one isolation mechanism. Treeport currently uses a Git worktree for each Tree.

A Git worktree is a checkout in a project. Git identifies one as the main worktree or a linked worktree.

Treeport finds Git worktrees that Git, editors, agents, scripts, or other tools create. It shows each worktree as a Tree.

[Rift](https://github.com/anomalyco/rift) is one example of a different isolation mechanism. It creates copy-on-write workspaces instead of Git worktrees. Treeport does not currently support Rift.

## Terminals

Each terminal belongs to a Tree. The terminal runs in a tmux session that Treeport manages.

When you close a client, the client disconnects from the terminal. The terminal and its process continue to run.

Open Treeport again to connect to the same session.

## Keep your current tools

Git controls branches, commits, and worktrees. Your editor, agent, shell, and other terminal tools keep their usual interfaces.

Read [How Treeport uses your tools](/concepts/fits-around-your-tools/).
