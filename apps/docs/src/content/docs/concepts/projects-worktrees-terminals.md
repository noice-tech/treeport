---
title: Projects, worktrees, and terminals
description: Learn how Treeport organizes repositories, worktrees, and terminals.
---

Treeport uses a Git worktree as the boundary for one unit of development work.

```text
Project
└── Worktree
    └── Terminal
```

## Projects

A project is a Git repository that you open in Treeport.

When you close a project, Treeport stops all terminals in that project. It does not remove the repository, worktrees, or files.

You can open the project again later.

## Worktrees

A worktree is a Git checkout in a project. It can be the main worktree or a linked worktree.

Treeport finds worktrees that Git, editors, agents, scripts, or other tools create. Treeport does not have to create them.

## Terminals

Each terminal belongs to a worktree. The terminal runs in a tmux session that Treeport manages.

When you close a client, the client disconnects from the terminal. The terminal and its process continue to run.

Open Treeport again to connect to the same session.

## Keep your current tools

Git controls branches, commits, and worktrees. Your editor, agent, shell, and other terminal tools keep their usual interfaces.

Read [How Treeport uses your tools](/concepts/fits-around-your-tools/).
