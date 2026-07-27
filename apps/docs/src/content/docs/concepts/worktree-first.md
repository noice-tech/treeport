---
title: Worktree-first development
description: Why Treeport uses Git worktrees as the unit of work.
---

Treeport is built around one opinionated idea:

> **A worktree is a piece of work.**

A worktree already contains the concrete state of a development task:

- an isolated checkout and known starting revision;
- staged, unstaged, untracked, and conflicted files;
- local commits and an optional branch or pull request;
- running agents and development processes;
- a natural point at which the work can be finished or discarded.

Treeport enriches this object with persistent terminals and navigation. It does not introduce a parallel task record with its own status or lifecycle.

## Git is authoritative

Treeport discovers the main checkout and linked worktrees using Git. A worktree can be created by Treeport, the Git CLI, Zed, an agent, a script, or another worktree-aware tool. Treeport sees the same inventory and reconciles when it changes.

Git continues to own branches, commits, dirty state, conflicts, and checkout contents. Treeport owns durable repository and worktree identity, terminal sessions, runtime metadata, and conservative cleanup orchestration.

## Finish with concrete actions

There is no Treeport-specific “done” state. Work is finished through observable actions:

- commit or discard changes;
- make commits reachable from another ref;
- merge a pull request when one exists;
- stop running terminals;
- safely remove the linked worktree.

This avoids states such as “task complete” while its checkout is still dirty or its processes are still running.

## Keep specialist tools specialist

Treeport is not an editor, issue tracker, Git client, diff viewer, or normalized agent chat interface. Pi, Claude Code, Codex, shells, test runners, and arbitrary TUIs continue to own their normal interfaces. Treeport provides the persistent terminal and worktree context around them.
