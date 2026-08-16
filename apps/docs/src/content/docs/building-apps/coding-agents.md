---
title: Coding agents
description: Use coding agents in persistent, observable Trees.
---

Treeport runs terminal coding agents without a change to their interfaces.

An agent runs in a persistent terminal in its Tree. You can connect again, read its output, or take control.

## Use Pi

[Pi](https://pi.dev) has an extension model that can add Treeport functions.

An extension can create Trees and terminals, report progress, and send BEL when the agent requires attention.

Pi stays a standard terminal application. The extension adds Treeport functions only where they are useful.

## Use other coding agents

Treeport does not require a specified agent, provider, or workflow.

Other terminal agents can use supported signals, such as progress updates and BEL notifications.

Treeport can show these signals without parsing agent output.

## Give the Treeport skill to an agent

The Treeport skill is compatible with the [Agent Skills](https://agentskills.io/) format.

The skill teaches an agent to use Treeport. It does not add a task system, provider, or required workflow.

With the skill, an agent can:

- find its current Treeport project, Tree, and terminal;
- create persistent terminals in the current Tree;
- create child Trees and terminals for parallel agents;
- inspect terminal status and recent output;
- wait for progress, BEL, or process exit without output parsing.

These sessions stay as standard Treeport terminals. You can open them, monitor their work, or take control.

Each Treeport CLI package contains the skill.

To show its location, run:

```sh
treeport skills
```

To load it automatically, copy the [Treeport skill](https://github.com/noice-tech/treeport/blob/main/apps/treeport/skills/treeport/SKILL.md) to your agent skill directory.

The skill requires the `treeport` command on `PATH` and an available Treeport daemon.

It also protects user control. An agent must not delete a terminal or Tree unless the user requests that operation.
