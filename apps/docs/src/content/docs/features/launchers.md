---
title: Launchers
description: Save programs to start in a tree, with inputs you fill in at launch.
---

Launchers are saved commands that you start in a tree. Use them to start a coding agent, a development server, or a test watcher.

## Create a launcher

1. Select **New app** in the sidebar.
2. Select **Manage launchers**.
3. Enter a name and command.

Launchers you save here are available in all projects and trees.

Treeport runs the command directly. For pipes or `&&`, use an explicit shell, such as `sh -c 'pnpm build && pnpm start'`.

Enable **Close on success** to close a terminal after a successful command. Failed commands stay visible for inspection.

## Inputs

Write `${name}` inside an argument to ask for a value when the launcher starts. For example, `pi ${prompt}` asks for a prompt. Input names start with a lowercase letter and contain lowercase letters, numbers, or underscores.

Each value is passed as part of its argument without shell parsing. If an argument is exactly one input and you leave it empty, Treeport omits the argument, so `pi ${prompt}` also starts Pi without a prompt.

You can paste files into an input to insert their paths.

## Add any agent CLI

You can add any coding agent CLI as a launcher. Most agent CLIs accept a prompt as an argument, so a `${prompt}` input lets you start the agent with a task. For example:

```sh
claude ${prompt}
codex ${prompt}
```

Check the CLI's `--help` for how it accepts an initial prompt.

You can also ask an agent to set this up. For example: "Run `treeport skills`, then add your CLI as a Treeport launcher that accepts a prompt."

## Start in a new tree

When you create a tree, choose a launcher in **Open with** to start it in the new tree. The tree name is optional and defaults to `tree`, `tree-2`, and so on.

A launcher can set a **Tree title command**. It runs after the new tree starts, and its first output line becomes the tree's title. It can use the same inputs as the command. For example:

```sh
claude -p 'Reply with a 3-5 word title for: ${task}'
```

To change a title later, select **Edit title…** on the tree in the sidebar, or run `treeport worktree title "<title>"` in the tree.

Launchers that close on success cannot start a new tree.

## Use the CLI

```sh
treeport launcher add --name Claude -- claude '${prompt}'
treeport launcher list
treeport launch claude --input prompt="Fix the login redirect loop"
treeport launch claude --new-tree --input prompt="Fix the login redirect loop"
treeport launcher remove <launcher-id>
```

Quote `${...}` so your shell does not expand it. Add `--repo` to `treeport launcher add` to save the launcher in the current tree's `.treeport/settings.json`. Use `--tree-title` with a JSON array to set a tree title command.

## Share launchers

To share launchers, add a `launchers` section to `.treeport/settings.json`. Each tree reads its own copy of this file. For the fields and an example, see [Project configuration](/reference/project-configuration/#launchers).

Treeport also shows compatible tasks from the main tree's `.zed/tasks.json`.

[Packages](/features/packages/) can supply launchers globally or for one project.

Removing a launcher does not stop terminals that are already running.
