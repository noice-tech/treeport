---
title: Your first workspace
description: Register a repository, create a worktree, and start a persistent terminal.
---

A Treeport workspace is a Git worktree plus its persistent terminal sessions.

## 1. Register a repository

With the daemon running, register an existing Git repository:

```sh
treeport project add ~/Projects/example
```

Treeport reads the repository's worktree inventory from Git. Existing linked worktrees appear automatically; there is no import step.

You can also add a repository from the web or desktop interface.

## 2. Create a worktree and terminal

Create a linked worktree from the repository's remote default branch and launch Pi in it:

```sh
treeport spawn \
  --project ~/Projects/example \
  --worktree-name investigate-cache \
  --name agent \
  -- pi
```

The command returns after the terminal session is created. Pi continues running independently of the CLI and any attached browser.

To base the new worktree on the committed `HEAD` of your current worktree instead, add `--from-current`. Uncommitted changes are not copied.

## 3. Reconnect

Open Treeport, choose the repository and worktree, then select **agent**. You are attaching to the original terminal—not starting another process.

You can close the tab or browser and return later. A second device can attach to the same session when it can securely reach your Treeport server.

## Add more terminals

A worktree can contain any number of terminals. Create a development server beside the agent:

```sh
treeport terminal create \
  --worktree ~/Projects/worktrees/investigate-cache \
  --name dev \
  -- pnpm dev
```

Omit the command after `--` to create a persistent login shell:

```sh
treeport terminal create --worktree . --name shell
```

Inside a Treeport-managed terminal, `.` resolves to the current worktree.

## What to try next

- Learn how [persistent terminals](/features/persistent-terminals/) work.
- Set up a [coding-agent workflow](/guides/agent-workflows/).
- Review [safe worktree cleanup](/features/safe-cleanup/) before removing work.
