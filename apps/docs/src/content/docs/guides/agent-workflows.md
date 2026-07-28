---
title: Coding-agent workflows
description: Run coding agents in persistent, observable worktrees.
---

Treeport can run Pi, Claude Code, Codex, or any other terminal-based coding agent without adapting or replacing its TUI.

## Start an agent in a new piece of work

Create the worktree and its first terminal together:

```sh
treeport spawn \
  --project ~/Projects/example \
  --worktree-name improve-search \
  --name agent \
  -- pi
```

The agent runs inside the new worktree and receives Treeport context through environment variables. Its terminal stays available for you to observe or take over.

Use `--from-current` when the child should start from your current committed `HEAD` rather than the fetched remote default branch:

```sh
treeport spawn \
  --project . \
  --worktree-name follow-up \
  --name agent \
  --from-current \
  -- pi
```

Uncommitted changes are not copied.

## Discover managed context

Inside a managed terminal, an agent or script can run:

```sh
treeport context
```

This returns the exact project, worktree, terminal, paths, statuses, IDs, and daemon URL. Use `treeport context --json` for programmatic consumers.

## Create observable child work

An agent can create another worktree and persistent terminal using `treeport spawn`. Treeport owns the terminal and worktree mechanics; the caller still owns the command, prompt, tool policy, and higher-level workflow.

Commands after `--` are passed as an argv array. Avoid an implicit `sh -lc`; launch a shell explicitly only when shell semantics are intentional.

## Observe terminal activity

Inspect runtime status and terminal signals:

```sh
treeport terminal inspect <terminal-id>
```

Read recent terminal contents:

```sh
treeport terminal capture <terminal-id>
treeport terminal capture <terminal-id> --lines 500
```

Wait for a raw condition over Treeport's event stream:

```sh
treeport terminal wait <terminal-id> --until working
treeport terminal wait <terminal-id> --until idle --timeout 30m
treeport terminal wait <terminal-id> --until bell
treeport terminal wait <terminal-id> --until exit
```

These conditions reflect standard terminal progress, BEL, and process state. Treeport does not parse arbitrary output or infer that an agent's task is complete.

## Install the Agent Skill

Treeport includes an [Agent Skills](https://agentskills.io/)-compatible skill:

```sh
mkdir -p .agents/skills
cp -R /path/to/treeport/skills/treeport .agents/skills/treeport
```

For a user-wide installation, copy it to `~/.agents/skills/treeport` instead. The skill teaches compatible agents the CLI's context, creation, observation, JSON, and safety contracts.
