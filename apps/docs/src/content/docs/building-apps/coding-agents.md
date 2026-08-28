---
title: Coding agents
description: Use coding agents in persistent, observable trees.
---

Treeport runs terminal coding agents without a change to their interfaces.

An agent runs in a persistent terminal in its tree. You can connect again, read its output, or take control.

## Use Pi

The optional `@treeport/pi` package connects [Pi](https://pi.dev) to the current Treeport tree.

The package contains a Pi extension and the detailed Treeport skill.

### Install the package

Install Treeport `0.5.0` or later. Make sure that the `treeport` command is on `PATH`.

Install Pi `0.84.3` or later.

Install the package globally in Pi:

```sh
pi install npm:@treeport/pi
```

Start Pi in a terminal that Treeport manages.

A connected session shows this footer status:

```text
treeport · <tree-name>
```

Outside a managed terminal, the package adds no instructions, notification, or footer status.

In a managed terminal, the package briefly defines Treeport projects and trees for Pi.

It includes the current project and tree names. It does not include their IDs, paths, or daemon URL.

The package tells Pi to use the `treeport` CLI through its standard Bash tool.

### Start persistent processes

Ask Pi to start a long-running process:

```text
Start the development server.
```

Pi creates a persistent terminal in the current tree. The process stays visible in Treeport.

Pi uses Bash directly for a finite command that it must await.

Ask Pi to stop a background process:

```text
Stop the development server.
```

Pi stops the process and deletes its terminal. Pi must not delete the terminal that hosts its session.

### Control a browser tab

Ask Pi to open and inspect your application:

```text
Open the app and check the settings page.
```

Pi opens or controls a browser tab in the current tree.

The package adds browser guidance only when the Treeport CLI and daemon support browser commands.

The browser tab stays open after the task. You can inspect or control the same page.

Pi must get your approval before it installs managed Chromium.

### Start a side quest

Ask Pi to start independent work:

```text
Do this side quest in a separate tree.
```

Pi can create another persistent terminal in the current tree.

For isolated Git work, Pi can use `treeport spawn` to create another tree and its first terminal.

### Use detailed Treeport guidance

Pi does not need the bundled skill for routine terminal or browser operations.

Use the skill for these detailed workflows:

- manage the Treeport daemon lifecycle;
- configure services or remote access;
- update Treeport;
- recover from partial child-tree creation;
- coordinate complex child-tree work.

### Understand the safety guidance

The package tells Pi to follow these rules:

- delete a terminal only when you ask Pi to stop or close its process;
- never delete the terminal that hosts the Pi session;
- never poll terminal output through repeated model calls;
- never install Chromium without your approval;
- never put secrets in browser URLs or command arguments.

Remove the package when you no longer need it:

```sh
pi remove npm:@treeport/pi
```

## Use other coding agents

Treeport does not require a specified agent, provider, or workflow.

Other terminal agents can use supported signals, such as progress updates and BEL notifications.

Treeport can show these signals without parsing agent output.

## Give the Treeport skill to an agent

The Treeport skill is compatible with the [Agent Skills](https://agentskills.io/) format.

The skill teaches an agent to use Treeport. It does not add a task system, provider, or required workflow.

With the skill, an agent can:

- find its current Treeport project, tree, and terminal;
- create persistent terminals in the current tree;
- create child trees and terminals for parallel agents;
- inspect terminal status and recent output;
- wait for progress, BEL, or process exit without output parsing.

These sessions stay as standard Treeport terminals. You can open them, monitor their work, or take control.

Each Treeport CLI package contains the skill.

The `@treeport/pi` package also loads the skill for Pi. Pi uses compact extension guidance for routine Treeport operations.

To show the CLI package skill location, run:

```sh
treeport skills
```

For another agent, copy the [Treeport skill](https://github.com/noice-tech/treeport/blob/main/apps/treeport/skills/treeport/SKILL.md) to its skill directory.

The skill requires the `treeport` command on `PATH` and an available Treeport daemon.

It also protects user control. An agent must not delete a terminal or tree unless the user requests that operation.
