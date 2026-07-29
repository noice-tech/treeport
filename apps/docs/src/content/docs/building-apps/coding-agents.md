---
title: Coding agents
description: Use coding agents in persistent, observable worktrees.
---

Treeport works with terminal-based coding agents without adapting or replacing their interfaces. An agent runs in a normal persistent terminal in its worktree, so you can reconnect, observe its output, or take over when needed.

## Pi

[Pi](https://pi.dev) is the best extensible coding agent for Treeport. Its extension model lets you add Treeport-aware behavior without changing the normal agent experience: extensions can create worktrees and terminals, report custom progress, and ring the terminal bell when attention is needed.

That follows Treeport's model of progressive enhancement. Pi remains a normal terminal application when no integration is needed; extensions can opt into Treeport features where they help.

## Other coding agents

Other coding agents have not been tested yet. They should work well when they can emit supported terminal signals, such as progress updates and BEL notifications, because Treeport can surface them without parsing agent output. Treeport does not require a particular agent, provider, or workflow.

## Skills

The Treeport skill is an [Agent Skills](https://agentskills.io/)-compatible instruction set for coding agents. It teaches an agent how to use Treeport without imposing a task system, provider, or workflow.

With the skill, an agent can:

- identify its current Treeport project, worktree, and terminal;
- create persistent terminals in its current worktree;
- spawn child worktrees with persistent terminals for other agents, so work can run in parallel;
- inspect terminal status and recent output; and
- wait for progress, attention (BEL), or process exit without scraping terminal output.

The resulting sessions remain normal Treeport terminals: you can open them, observe their work, or take control of the agent's usual terminal interface.

Every Treeport CLI includes the skill. An agent can read it directly without installing anything else:

```sh
treeport skills
```

To load it automatically, add [`skills/treeport/SKILL.md`](https://github.com/noice-tech/treeport/blob/main/skills/treeport/SKILL.md) to the location where your coding agent discovers Agent Skills. The skill requires the `treeport` command on `PATH` and a reachable Treeport daemon. It also tells agents to preserve user control: they must not delete terminals or worktrees unless explicitly asked.
