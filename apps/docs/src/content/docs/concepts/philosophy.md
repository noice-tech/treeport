---
title: Philosophy
description: Why Treeport exists and why it deliberately builds on tools that already work.
---

Treeport is for people who want the power of terminal tools without turning terminal mechanics into a hobby.

## 1. Terminal-native, not terminal-nerdy

I am not a terminal nerd. I love [Pi](https://pi.dev/), but I still reach for [Zed](https://zed.dev/) as my code editor. I started learning programming in 2016 in a DOS-style Far Manager, enjoyed VS Code, and never completely switched to Neovim or another keyboard-only environment. Clicking with a mouse is cool.

Treeport reflects that preference. Terminal applications should remain real terminal applications, but the workspace around them should feel like a normal app. Tabs should respond to familiar shortcuts such as `Cmd+T` and `Cmd+W`. Repositories and worktrees should be navigable with a mouse. You should not need to adopt someone else's terminal lifestyle.

## 2. tmux should be invisible

Treeport uses tmux because tmux already solves persistent terminal sessions well. It is an implementation detail, not the product interface.

I do not care about learning tmux, and Treeport users should not have to care either. You should not need to understand tmux sessions, windows, panes, prefixes, or configuration to leave a process running and reconnect later.

Projects such as [Herdr](https://herdr.dev/) are taking an exciting approach by rethinking the multiplexer itself. Treeport makes a different tradeoff: keep a proven multiplexer underneath and put a familiar application interface above it.

## 3. Compose tools that already work

Treeport would rather connect good tools than replace them:

- [Tailscale](https://tailscale.com/) already provides trusted private networking;
- Pi and other coding agents already provide strong coding workflows;
- terminal CLIs already expose powerful development tools;
- editors already provide excellent code navigation and editing; and
- GitHub pull requests already provide a good review workflow.

Treeport owns the persistent worktree and terminal context around those tools. It should not grow weaker copies of their interfaces merely to keep everything inside one product.

## 4. One worktree is one task

The workflow began with a habit: create one Git worktree for each piece of work. That gives every task its own checkout, branch, changes, terminals, agents, and development servers.

Treeport treats that concrete workspace as the task instead of inventing a second task database and lifecycle. Git remains the source of truth, regardless of whether a worktree was created by Treeport, an editor, an agent, a script, or Git itself.

## 5. Deliberately unambitious

You can think of Treeport as a shittier version of Codex: a convenient place to start and revisit coding work without trying to invent a new agent, editor, terminal protocol, review system, or cloud platform.

That lack of ambition is a product constraint. Treeport should make the worktree-per-task workflow pleasant, persistent, and accessible. Whenever an existing tool already solves a problem well, Treeport should integrate with it or get out of its way.
