---
title: Projects, worktrees, and terminals
description: How Treeport organizes Git repositories, worktrees, and persistent terminals.
---

**Treeport makes one opinionated bet:** a Git worktree is the right boundary for a piece of development work.

Treeport adds persistent terminals around your existing Git worktrees. It does not replace Git, your editor, or the terminal tools you already use.

```text
Project
└── Worktree
    └── Terminal
```

## Projects

A project is a Git repository opened in Treeport. Closing a project stops all of its Treeport terminals, but leaves the repository, worktrees, and files on disk. You can reopen it later.

## Worktrees

A worktree is a Git checkout within a project: the main checkout or a linked worktree. Treeport discovers worktrees created by Git, editors, agents, scripts, and other worktree-aware tools. It does not require Treeport to have created them.

## Terminals

Terminals belong to a worktree and run in Treeport-managed tmux sessions. Closing a browser tab or the desktop app only detaches you: the terminal and its process keep running. Reopen Treeport to attach to the same session.

## Fits around your tools

Treeport is intentionally small. Git remains authoritative for branches, commits, and worktrees, while your editor, agent, shell, and other terminal tools keep their normal interfaces. Learn how Treeport [fits around your tools](/concepts/fits-around-your-tools/).
